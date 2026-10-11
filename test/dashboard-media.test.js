import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { MEDIA_SCRIPT } from '../dashboard-media.js'

function fixture({ upload, save, readFails = false } = {}) {
  const elements = new Map(), requests = []
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', files: [], textContent: '', innerHTML: '', className: '', disabled: false, open: false, classList: { toggle() {} } })
    return elements.get(id)
  }
  const context = vm.createContext({
    S: { workspace: { id: 'workspace-fixture' }, cfg: { messages: [] } }, accountId: 'account-fixture', mediaPath: '', editMessageId: '',
    document: { getElementById: element, querySelector: () => element('save') },
    window: { scrollTo() {} },
    FileReader: class { readAsDataURL() { queueMicrotask(() => { if (readFails) this.onerror(); else { this.result = 'data:image/png;base64,aW1hZ2U='; this.onload() } }) } },
    esc: value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), toast() {},
    async api(url, method, body) {
      requests.push({ url, method, body })
      if (url === '/api/upload') return upload ? upload() : { path: 'accounts/account-fixture/media/fixture.png', previewUrl: '/fixture-preview', type: 'image' }
      return save ? save() : { message: 'Message saved successfully.' }
    }, async loadState() {}, Promise, JSON, Error
  })
  vm.runInContext(MEDIA_SCRIPT, context)
  element('messageName').value = 'Image fixture'
  element('messageText').value = 'Caption fixture'
  element('messageFile').files = [{ name: 'fixture.png', size: 128 }]
  return { context, element, requests, run: expression => vm.runInContext(expression, context) }
}

test('selected image uploads once and Save waits before persisting the attachment', async () => {
  let finishUpload
  const f = fixture({ upload: () => new Promise(resolve => { finishUpload = resolve }) })
  const upload = f.run('chooseMessageMedia()')
  await new Promise(resolve => setImmediate(resolve))
  const save = f.run('saveMessage()')
  await f.run('saveMessage()')
  assert.equal(f.requests.length, 1); assert.equal(f.element('save').disabled, true)
  assert.equal(f.element('messageText').disabled, true, 'the in-flight message cannot be accidentally edited')
  finishUpload({ path: 'accounts/account-fixture/media/fixture.png', previewUrl: '/fixture-preview' })
  await upload; await save
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].method, 'POST'); assert.equal(f.requests[1].body.media, 'accounts/account-fixture/media/fixture.png')
  assert.equal(f.element('messageFeedback').textContent, 'Message saved successfully.')
  assert.equal(f.element('save').disabled, false)
})

test('upload failures stay visible and never silently save a message without its selected image', async () => {
  const f = fixture({ upload: async () => { throw Error('Fixture upload rejected') } })
  await f.run('chooseMessageMedia()'); await f.run('saveMessage()')
  assert(f.requests.every(request => request.url === '/api/upload'))
  assert.match(f.element('messageFeedback').textContent, /Attachment not uploaded/)
  assert.equal(f.context.mediaPath, '')
  assert.equal(f.element('save').disabled, false)
  f.run('removeMessageMedia()')
  assert.equal(f.context.mediaUploadError, '')
})

test('unsupported, oversized and unreadable files produce clear errors without saving partial messages', async () => {
  for (const file of [{ name: 'fixture.heic', size: 128 }, { name: 'fixture.png', size: 17 * 1024 * 1024 }, { name: 'fixture.png', size: 0 }]) {
    const f = fixture(); f.element('messageFile').files = [file]
    await f.run('chooseMessageMedia()')
    assert.equal(f.requests.length, 0); assert(f.context.mediaUploadError)
    assert.equal(f.context.mediaPath, '')
  }
  const f = fixture({ readFails: true }); await f.run('chooseMessageMedia()')
  assert.match(f.element('mediaLabel').textContent, /Could not read/)
  assert.equal(f.requests.length, 0); assert.equal(f.context.mediaUploadPromise, null)
})

test('a late upload cannot attach to another account or replace a cleared draft', async () => {
  for (const change of ['accountId="another-account";newMessage(true)', 'newMessage(true)']) {
    let finishUpload
    const f = fixture({ upload: () => new Promise(resolve => { finishUpload = resolve }) })
    const pending = f.run('chooseMessageMedia()')
    await new Promise(resolve => setImmediate(resolve))
    f.run(change)
    finishUpload({ path: 'accounts/account-fixture/media/fixture.png', previewUrl: '/fixture-preview' })
    await pending
    assert.equal(f.context.mediaPath, ''); assert.equal(f.element('messageMediaPreview').innerHTML, '')
  }
})

test('unchanged live polling preserves the existing saved-media elements', () => {
  const f = fixture()
  f.context.S.cfg.messages = [{ id: 'message-fixture', name: 'Fixture', texts: ['Caption'], media: 'fixture.mp4' }]
  f.run('renderMessages()')
  assert.match(f.element('messageCards').innerHTML, /<video/)
  f.element('messageCards').innerHTML = 'Existing video playback fixture'
  f.run('renderMessages()')
  assert.equal(f.element('messageCards').innerHTML, 'Existing video playback fixture')
  f.context.accountId = 'another-account'; f.run('renderMessages()')
  assert.match(f.element('messageCards').innerHTML, /another-account/)
})

test('returning to the same account cannot let an old save erase a newer draft', async () => {
  let finishSave
  const f = fixture({ save: () => new Promise(resolve => { finishSave = resolve }) })
  await f.run('chooseMessageMedia()')
  const pending = f.run('saveMessage()')
  f.run('newMessage(true);document.getElementById("messageName").value="Newer draft"')
  finishSave({ message: 'Message saved successfully.' }); await pending
  assert.equal(f.element('messageName').value, 'Newer draft')
  assert.equal(f.element('messageFeedback').textContent, '')
})
