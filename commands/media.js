import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import { getMediaKeys } from '@whiskeysockets/baileys'

sharp.cache({ memory: 16, files: 0, items: 20 })
sharp.concurrency(1)
export class MediaError extends Error {}
export class BoundedQueue {
  constructor(concurrency = 1, capacity = 8) { this.concurrency = concurrency; this.capacity = capacity; this.active = 0; this.pending = [] }
  run(task) {
    if (this.active + this.pending.length >= this.capacity) return Promise.reject(new MediaError('Media processing is busy. Please try again after the current request finishes.'))
    return new Promise((resolve, reject) => { this.pending.push({ task, resolve, reject }); this.drain() })
  }
  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift(); this.active++
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.active--; this.drain() })
    }
  }
}
export function containsViewOnce(content) {
  if (!content || typeof content !== 'object') return false
  return !!(content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension ||
    content.imageMessage?.viewOnce || content.videoMessage?.viewOnce ||
    containsViewOnce(content.ephemeralMessage?.message) || containsViewOnce(content.documentWithCaptionMessage?.message))
}
export function mediaFrom(content) {
  if (containsViewOnce(content)) throw new MediaError('View-once media cannot be converted or saved.')
  const message = content?.ephemeralMessage?.message || content
  for (const [key, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['stickerMessage', 'sticker']]) if (message?.[key]) return { type, value: message[key] }
  return null
}
export function validateMediaLocation(value) {
  // The Baileys host override is pinned, including when an untrusted protobuf URL exists.
  if (value.url) {
    let url
    try { url = new URL(value.url) } catch { throw new MediaError('Invalid WhatsApp media URL.') }
    if (url.protocol !== 'https:' || url.hostname !== 'mmg.whatsapp.net' || url.port || url.username || url.password) throw new MediaError('Only authenticated WhatsApp media can be processed.')
  }
  if (value.directPath && (!/^\/[^\\\s]*$/.test(value.directPath) || value.directPath.startsWith('//') || value.directPath.includes('..'))) throw new MediaError('Invalid WhatsApp media path.')
  if (!value.directPath && !value.url) throw new MediaError('This media is no longer accessible. Send a fresh attachment.')
}
export function publicAddress(address) {
  if (net.isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address)
  if (net.isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
}
// Baileys rc14's getHttpStream currently drops redirect/signal options. Use a
// strict HTTPS transport and reuse Baileys' key derivation instead of relying on
// options that are silently ignored. This downloader never follows redirects.
export async function downloadWhatsAppMedia(value, type, { options, maxBytes }) {
  validateMediaLocation(value)
  const url = value.directPath ? new URL(value.directPath, 'https://mmg.whatsapp.net') : new URL(value.url)
  if (url.hostname !== 'mmg.whatsapp.net') throw new MediaError('Invalid WhatsApp media host.')
  if (Buffer.from(value.mediaKey || []).length !== 32) throw new MediaError('This media does not have valid WhatsApp decryption keys.')
  const { cipherKey, iv, macKey } = await getMediaKeys(value.mediaKey, type)
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv), hmac = crypto.createHmac('sha256', macKey).update(iv)
  const encryptedHash = crypto.createHash('sha256'), plainHash = crypto.createHash('sha256')
  let tail = Buffer.alloc(0), bytes = 0
  const stream = new Transform({
    transform(chunk, _, callback) {
      try {
        bytes += chunk.length; if (bytes > maxBytes + 32) throw new MediaError('Media exceeds this account’s size limit.')
        encryptedHash.update(chunk)
        const joined = Buffer.concat([tail, chunk]), split = Math.max(0, joined.length - 10), data = joined.subarray(0, split)
        tail = joined.subarray(split)
        if (data.length) { hmac.update(data); const decoded = decipher.update(data); plainHash.update(decoded); this.push(decoded) }
        callback()
      } catch (error) { callback(error) }
    },
    flush(callback) {
      try {
        if (tail.length !== 10 || !crypto.timingSafeEqual(hmac.digest().subarray(0, 10), tail)) throw new MediaError('WhatsApp media integrity verification failed.')
        const decoded = decipher.final(); plainHash.update(decoded); this.push(decoded)
        for (const [provided, actual] of [[value.fileSha256, plainHash.digest()], [value.fileEncSha256, encryptedHash.digest()]]) if (provided && (Buffer.from(provided).length !== 32 || !crypto.timingSafeEqual(Buffer.from(provided), actual))) throw new MediaError('WhatsApp media integrity verification failed.')
        callback()
      } catch (error) { callback(error) }
    }
  })
  return new Promise((resolve, reject) => {
    let delivered = false, response
    const request = https.get(url, { signal: options?.signal, headers: { 'User-Agent': 'WhatsAppBotMedia/1.0' },
      lookup(hostname, lookupOptions, callback) {
        if (hostname !== 'mmg.whatsapp.net') return callback(new MediaError('Invalid media host.'))
        dns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
          if (error) return callback(error)
          if (!records.length || records.some(record => !publicAddress(record.address))) return callback(new MediaError('Media host resolved to a restricted network.'))
          if (lookupOptions.all) callback(null, records)
          else callback(null, records[0].address, records[0].family)
        })
      }
    }, res => {
      response = res
      if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > maxBytes + 32) { res.resume(); request.destroy(); reject(new MediaError('This WhatsApp media is unavailable or exceeds the size limit.')); return }
      delivered = true; res.on('error', error => stream.destroy(error)); res.pipe(stream); resolve(stream)
    })
    request.on('error', error => { if (delivered) stream.destroy(error); else reject(error) })
    stream.on('error', () => { response?.destroy(); request.destroy() })
    stream.on('close', () => { response?.destroy(); request.destroy() })
  })
}
function signature(buffer) {
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image'
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'sticker'
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'video'
  return null
}
export function runFFmpeg(executable, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostics = '', settled = false
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); /* resolve only after exit so cleanup cannot race a writer */ }, timeoutMs)
    const started = Date.now()
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000) })
    child.once('error', error => { if (error.name !== 'AbortError') finish(new MediaError('The local media processor is unavailable.')) })
    child.once('close', code => finish(code === 0 ? null : new MediaError(Date.now() - started >= timeoutMs ? 'Media processing timed out.' : 'Unsupported or damaged media, or no audio track was found.'), diagnostics))
  })
}
export function createMediaService({ download = downloadWhatsAppMedia, queue = new BoundedQueue(), tempRoot = os.tmpdir(), ffmpeg = process.env.COMMAND_FFMPEG_PATH || ffmpegStatic } = {}) {
  const controllers = new Set()
  let stopped = false
  return {
    stop() { stopped = true; for (const controller of controllers) controller.abort() },
    availability() { return { sticker: true, toimg: true, tomp3: !!ffmpeg && fs.existsSync(ffmpeg), videoSticker: !!ffmpeg && fs.existsSync(ffmpeg) } },
    async process(command, source, limits, consume) {
      if (!source) throw new MediaError('Attach media or reply to an accessible image, video or sticker.')
      return queue.run(async () => {
        if (stopped) throw new MediaError('Media processing is stopping.')
        const timeoutMs = limits.timeoutSeconds * 1000, controller = new AbortController(), started = Date.now()
        controllers.add(controller)
        const remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        let directory
        try {
          directory = await fs.promises.mkdtemp(path.join(tempRoot, 'wa-command-media-'))
          await fs.promises.chmod(directory, 0o700)
          validateMediaLocation(source.value)
          const reportedSize = Number(source.value.fileLength || 0)
          if (reportedSize > limits.maxBytes || Number(source.value.seconds || 0) > limits.maxVideoSeconds) throw new MediaError('Media exceeds this account’s size or duration limit.')
          if ((command === 'toimg' && source.type !== 'sticker') || (command === 'tomp3' && source.type !== 'video')) throw new MediaError(command === 'toimg' ? 'Reply to a sticker.' : 'Attach or reply to a video with an audio track.')
          const input = path.join(directory, 'input'), output = path.join(directory, 'output')
          let bytes = 0
          const bounded = new Transform({ transform(chunk, _, callback) {
            bytes += chunk.length
            if (bytes > limits.maxBytes) callback(new MediaError('Media exceeds this account’s size limit.'))
            else callback(null, chunk)
          } })
          const stream = await download(source.value, source.type, { maxBytes: limits.maxBytes, host: 'mmg.whatsapp.net', options: { redirect: 'error', signal: controller.signal } })
          await pipeline(stream, bounded, fs.createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal: controller.signal })
          const descriptor = fs.openSync(input, 'r'), header = Buffer.alloc(16)
          try { fs.readSync(descriptor, header, 0, 16, 0) } finally { fs.closeSync(descriptor) }
          const kind = signature(header)
          if (!kind || (source.type === 'video' && kind !== 'video') || (source.type === 'sticker' && kind !== 'sticker') || (source.type === 'image' && !['image', 'sticker'].includes(kind))) throw new MediaError('The attachment content does not match its media type.')
          if (source.type === 'video') {
            if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new MediaError('Video processing needs the local FFmpeg dependency.')
            // Check actual duration for conversions AND Status copies.
            const report = await runFFmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2', '-i', input, '-t', '0', '-f', 'null', '-'], remaining(), controller.signal)
            const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report)
            if (!duration || Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) > limits.maxVideoSeconds + 0.05) throw new MediaError('The video exceeds this account’s duration limit.')
          }
          let content
          if (command === 'statussave') {
            if (source.type !== 'video') {
              const metadata = await sharp(input, { limitInputPixels: 16000000, failOn: 'warning' }).metadata()
              if (!metadata.width || !metadata.height || metadata.width * metadata.height > 16000000) throw new MediaError('The image exceeds the pixel limit or is damaged.')
            }
            content = source.type === 'video' ? { video: { url: input } } : { image: { url: input } }
          } else if (source.type !== 'video') {
            const processor = sharp(input, { limitInputPixels: 16000000, failOn: 'warning', animated: false }).rotate().timeout({ seconds: limits.timeoutSeconds })
            if (command === 'sticker') await processor.resize(512, 512, { fit: 'contain', background: '#00000000' }).webp({ quality: 70 }).toFile(output)
            else await processor.png().toFile(output)
            content = command === 'sticker' ? { sticker: { url: output } } : { image: { url: output } }
          } else {
            if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new MediaError('Video conversion needs the local FFmpeg dependency.')
            const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2', '-i', input]
            const args = command === 'tomp3' ? ['-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3'] : ['-an', '-vf', "fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", '-c:v', 'libwebp', '-loop', '0', '-f', 'webp']
            await runFFmpeg(ffmpeg, [...base, '-t', String(limits.maxVideoSeconds), ...args, '-fs', String(limits.maxBytes), output], remaining(), controller.signal)
            content = command === 'tomp3' ? { audio: { url: output }, mimetype: 'audio/mpeg', fileName: 'audio.mp3' } : { sticker: { url: output } }
          }
          const resultFile = command === 'statussave' ? input : output
          if ((await fs.promises.stat(resultFile)).size > limits.maxBytes) throw new MediaError('The converted media exceeds the output limit.')
          if (controller.signal.aborted) throw new MediaError('Media processing timed out.')
          // Keep the private file until Baileys has finished uploading it.
          return await consume(content)
        } catch (error) {
          if (error instanceof MediaError) throw error
          throw new MediaError(stopped ? 'Media processing is stopping.' : controller.signal.aborted ? 'Media processing timed out.' : 'This media could not be processed. It may be expired, damaged or unsupported.')
        } finally {
          clearTimeout(timeout)
          controllers.delete(controller)
          if (directory) await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        }
      })
    }
  }
}
