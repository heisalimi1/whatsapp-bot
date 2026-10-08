import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'

test('workspace migration preserves accounts; email-bound one-use invitations share only authorized business data',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whatsapp-workspace-test-'))
  const previous=process.env.AUTH_DATABASE_PATH
  process.env.AUTH_DATABASE_PATH=path.join(root,'auth.sqlite')
  const auth=await import(pathToFileURL(path.resolve('auth-store.js')))
  const owner=(await auth.createUser({fullName:'Owner',email:'owner@example.test',password:'test-password-for-workspace'})).user
  const member=(await auth.createUser({fullName:'Member',email:'member@example.test',password:'test-password-for-workspace'})).user
  const other=(await auth.createUser({fullName:'Other',email:'other@example.test',password:'test-password-for-workspace'})).user
  const direct=new DatabaseSync(process.env.AUTH_DATABASE_PATH)
  const before=JSON.stringify(direct.prepare('SELECT * FROM users ORDER BY id').all())
  const store=await import(pathToFileURL(path.resolve('workspace-store.js')))
  t.after(()=>{store.closeWorkspaceStore();auth.closeAuthStore();direct.close();if(previous===undefined)delete process.env.AUTH_DATABASE_PATH;else process.env.AUTH_DATABASE_PATH=previous;fs.rmSync(root,{recursive:true,force:true})})
  assert.equal(JSON.stringify(direct.prepare('SELECT * FROM users ORDER BY id').all()),before,'migration changes no user IDs, password hashes or credentials')
  assert.equal(store.workspaceContext(owner.id).workspace.id,owner.id,'legacy owner ID becomes the same stable workspace ID')
  assert.equal(store.workspaceContext(other.id).workspace.id,other.id)
  assert.throws(()=>store.selectWorkspace(other.id,owner.id),/not found/)
  const invitation=store.createWorkspaceInvite(owner.id,owner.id,member.email)
  assert.notEqual(direct.prepare('SELECT token_hash FROM workspace_invites').get().token_hash,invitation.code,'invitation credentials are stored as hashes')
  assert.throws(()=>store.acceptWorkspaceInvite(other.id,invitation.code),/another email/)
  store.acceptWorkspaceInvite(member.id,invitation.code)
  assert.equal(store.workspaceContext(member.id).workspace.id,owner.id)
  assert.equal(store.workspaceContext(member.id).workspace.role,'member')
  assert.throws(()=>store.acceptWorkspaceInvite(member.id,invitation.code),/invalid/)
  assert.throws(()=>store.createWorkspaceInvite(member.id,owner.id,other.email),/Only/)
  assert.throws(()=>store.workspaceMembers(other.id,owner.id),/Only/)
  assert.equal(store.workspaceMembers(owner.id,owner.id).length,2)
  store.renameWorkspace(owner.id,owner.id,'Shared business')
  assert.equal(store.workspaceContext(member.id).workspace.name,'Shared business')
  store.removeWorkspaceMember(owner.id,owner.id,member.id)
  assert.equal(store.workspaceContext(member.id).workspace.id,member.id,'revoked members immediately fall back to their own business')
  assert.throws(()=>store.selectWorkspace(member.id,owner.id),/not found/)
  const expired=store.createWorkspaceInvite(owner.id,owner.id,member.email)
  direct.prepare('UPDATE workspace_invites SET expires_at=?').run(Date.now()-1)
  assert.throws(()=>store.acceptWorkspaceInvite(member.id,expired.code),/expired/)
})
