import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import dns from 'node:dns'
import crypto from 'node:crypto'
import { getMediaKeys } from '@whiskeysockets/baileys'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { createMediaService, BoundedQueue, MediaError, mediaFrom, publicAddress, validateMediaLocation, runFFmpeg, downloadWhatsAppMedia } from '../commands/media.js'

const limits = { maxBytes: 1024 * 1024, maxVideoSeconds: 5, timeoutSeconds: 20 }
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-command-media-test-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
const source = (type, extras = {}) => ({ type, value: { url: 'https://mmg.whatsapp.net/test-only', ...extras } })
test('image sticker and sticker-to-image conversion use actual Sharp and clean all temporary files', async t => {
  const root = directory(t), png = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#008069' } }).png().toBuffer()
  let input = png, sticker
  const service = createMediaService({ tempRoot: root, download: async () => Readable.from([input]) })
  await service.process('sticker', source('image'), limits, async content => {
    const file = content.sticker.url; assert(fs.existsSync(file)); sticker = fs.readFileSync(file)
    const metadata = await sharp(sticker).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 512); assert.equal(metadata.height, 512)
  })
  assert.deepEqual(fs.readdirSync(root), [])
  input = sticker
  await service.process('toimg', source('sticker'), limits, async content => { const metadata = await sharp(content.image.url).metadata(); assert.equal(metadata.format, 'png') })
  assert.deepEqual(fs.readdirSync(root), [])
})
test('actual FFmpeg converts a short video to an animated sticker and MP3', async t => {
  assert(fs.existsSync(ffmpeg), 'The installed FFmpeg dependency must exist for this test')
  const root = directory(t), videoFile = path.join(root, 'fixture.mp4')
  await runFFmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'color=c=green:s=128x128:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '1', '-f', 'mp4', videoFile], 15000)
  const video = fs.readFileSync(videoFile), service = createMediaService({ tempRoot: root, download: async () => Readable.from([video]) })
  await service.process('sticker', source('video'), limits, async content => {
    const metadata = await sharp(content.sticker.url, { animated: true }).metadata(); assert.equal(metadata.format, 'webp'); assert(metadata.pages > 1)
  })
  await service.process('tomp3', source('video'), limits, async content => { assert.equal(content.mimetype, 'audio/mpeg'); assert(fs.statSync(content.audio.url).size > 1000) })
  assert.deepEqual(fs.readdirSync(root), ['fixture.mp4'])
})
test('deceptive types, large downloads, forged duration metadata and failed sends leave no temp files', async t => {
  const root = directory(t)
  let input = Buffer.from('<html>not media</html>')
  const service = createMediaService({ tempRoot: root, download: async () => Readable.from([input]) })
  await assert.rejects(service.process('sticker', source('image'), limits, () => {}), /content does not match/)
  input = Buffer.alloc(limits.maxBytes + 1)
  await assert.rejects(service.process('sticker', source('image'), limits, () => {}), /size limit/)
  input = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#008069' } }).png().toBuffer()
  await assert.rejects(service.process('sticker', source('image'), limits, () => { throw Error('simulated upload failure') }), MediaError)
  assert.deepEqual(fs.readdirSync(root), [])
  const file = path.join(root, 'long.mp4')
  await runFFmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:r=5:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', '-f', 'mp4', file], 15000)
  input = fs.readFileSync(file)
  await assert.rejects(service.process('sticker', source('video', { seconds: 0 }), { ...limits, maxVideoSeconds: 1 }, () => {}), /duration limit/)
  await assert.rejects(service.process('statussave', source('video', { seconds: 0 }), { ...limits, maxVideoSeconds: 1 }, () => {}), /duration limit/)
  assert.deepEqual(fs.readdirSync(root), ['long.mp4'])
})

test('encrypted WhatsApp downloads verify streaming HMAC and both hashes without contacting the network', async t => {
  const plain = Buffer.from('Synthetic media integrity fixture. No customer content.'), mediaKey = Buffer.alloc(32, 7)
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, 'image')
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10)
  const payload = Buffer.concat([encrypted, mac]), sha = value => crypto.createHash('sha256').update(value).digest()
  const value = { url: 'https://mmg.whatsapp.net/synthetic-only', mediaKey, fileSha256: sha(plain), fileEncSha256: sha(payload) }
  let actual = payload, status = 200, records = [{ address: '8.8.8.8', family: 4 }], requests = 0
  t.mock.method(dns, 'lookup', (_host, _opts, callback) => callback(null, records))
  t.mock.method(https, 'get', (url, opts, callback) => {
    assert.equal(url.hostname, 'mmg.whatsapp.net'); assert(opts.signal); requests++
    const request = new EventEmitter(); request.destroy = () => {}
    setImmediate(() => opts.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) { request.emit('error', error); return }
      assert.deepEqual(addresses, records)
      // Deliberately split cipher blocks and the trailing MAC across chunks.
      const response = Readable.from([actual.subarray(0, 3), actual.subarray(3, 37), actual.subarray(37, -6), actual.subarray(-6)])
      response.statusCode = status; response.headers = { 'content-length': actual.length }
      callback(response)
    }))
    return request
  })
  const download = input => downloadWhatsAppMedia(input, 'image', { maxBytes: 1024, options: { signal: new AbortController().signal } })
  assert.deepEqual(await buffer(await download(value)), plain)
  actual = Buffer.from(payload); actual[actual.length - 1] ^= 1
  await assert.rejects(buffer(await download(value)), /integrity/)
  actual = payload
  await assert.rejects(buffer(await download({ ...value, fileSha256: Buffer.alloc(32) })), /integrity/)
  await assert.rejects(buffer(await download({ ...value, fileEncSha256: Buffer.alloc(32) })), /integrity/)
  status = 302; await assert.rejects(download(value), /unavailable/)
  status = 200; records = [{ address: '169.254.169.254', family: 4 }]
  await assert.rejects(download(value), /restricted network/)
  const before = requests
  await assert.rejects(download({ ...value, url: 'https://127.0.0.1/private' }), /Only/)
  await assert.rejects(download({ ...value, mediaKey: Buffer.alloc(1) }), /decryption keys/)
  assert.equal(requests, before, 'Rejected inputs never reach the HTTPS transport')
})

test('failed temporary-directory creation and malformed Status images fail safely', async t => {
  const root = directory(t), blocked = path.join(root, 'not-a-directory')
  fs.writeFileSync(blocked, 'synthetic')
  const invalidRoot = createMediaService({ tempRoot: blocked })
  await assert.rejects(invalidRoot.process('sticker', source('image'), limits, () => {}), MediaError)
  invalidRoot.stop()
  const service = createMediaService({ tempRoot: root, download: async () => Readable.from([Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')]) })
  await assert.rejects(service.process('statussave', source('image'), limits, () => {}), MediaError)
  assert.deepEqual(fs.readdirSync(root), ['not-a-directory'])
})
test('media queue bounds concurrency and capacity; FFmpeg timeouts terminate the child', async t => {
  const queue = new BoundedQueue(1, 2)
  let release, active = 0, maximum = 0
  const first = queue.run(async () => { maximum = Math.max(maximum, ++active); await new Promise(resolve => { release = resolve }); active-- })
  const second = queue.run(async () => { maximum = Math.max(maximum, ++active); active-- })
  await assert.rejects(queue.run(() => {}), /busy/)
  await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all([first, second]); assert.equal(maximum, 1)
  await assert.rejects(runFFmpeg(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 100), /timed out/)
})
test('SSRF, path traversal, view-once media and unsupported URLs are rejected before download', () => {
  for (const url of ['http://mmg.whatsapp.net/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://mmg.whatsapp.net.evil.test/x', 'https://user:password@mmg.whatsapp.net/x', 'https://mmg.whatsapp.net:8443/x']) assert.throws(() => validateMediaLocation({ url }), /Only/)
  for (const directPath of ['//evil.test/x', '/../../secret', '/\\secret']) assert.throws(() => validateMediaLocation({ directPath }), /Invalid/)
  assert.throws(() => mediaFrom({ viewOnceMessage: { message: { imageMessage: {} } } }), /View-once/)
  assert.throws(() => mediaFrom({ ephemeralMessage: { message: { imageMessage: { viewOnce: true } } } }), /View-once/)
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false)
  assert.equal(publicAddress('8.8.8.8'), true)
})
test('Status copies exist only during upload and media shutdown aborts an in-flight download', async t => {
  const root = directory(t), png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#008069' } }).png().toBuffer()
  const service = createMediaService({ tempRoot: root, download: async () => Readable.from([png]) })
  await service.process('statussave', source('image'), limits, async content => { assert(fs.existsSync(content.image.url)) })
  assert.deepEqual(fs.readdirSync(root), [])
  let begin
  const entered = new Promise(resolve => { begin = resolve })
  const abortable = createMediaService({ tempRoot: root, download: async (_, __, opts) => { begin(); return new Promise((_, reject) => opts.options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) } })
  const running = abortable.process('sticker', source('image'), limits, () => {})
  await entered; abortable.stop(); await assert.rejects(running, /stopping/)
  assert.deepEqual(fs.readdirSync(root), [])
})
