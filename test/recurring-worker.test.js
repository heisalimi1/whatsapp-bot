import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as recurrence from '../recurring-schedules.js'
import { buildDeliveryPlan } from '../automation-delivery.js'

// Exercise the actual production worker and timer functions with a controlled clock.
function worker(data, clock, calls) {
  const source=fs.readFileSync(new URL('../bot.js',import.meta.url),'utf8')
  const functions=source.slice(source.indexOf('function scheduleAccount('),source.indexOf('\nlet reloadTimer'))
  class ClockDate extends Date { constructor(...args){super(...(args.length?args:[clock.now]))}static now(){return clock.now} }
  let nextTimer=0,persisted,online=true
  const timers=new Map()
  const context=vm.createContext({ ...recurrence, buildDeliveryPlan, Date:ClockDate, Map, Set, Math, Promise, Number, Array, String,
    cronTasks:new Map(),oneShotTimers:new Map(),runningJobs:new Set(),queuedJobs:new Map(),stopRequests:new Map(),activeJobPromises:new Map(),accountGroups:new Map([['fixture',[]]]),MAX_CONCURRENT_JOBS:2,shuttingDown:false,
    cron:{validate(){return true},schedule(){return {destroy(){},stop(){}}}},log(){},
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:clock.now+ms});return id},clearTimeout(id){timers.delete(id)},
    async dataFor(){return data},saveAccountData(){persisted=JSON.parse(JSON.stringify(data))},
    async getAccountSocket(){return online?{async sendMessage(jid,content,options){calls.push({jid,content,options})}}:null},
    async getAccountStatusAudience(){return ['1234567890@s.whatsapp.net']},async targetsFor(){return [{jid:'fixture@g.us'}]},
    pickText(message){return message.texts[0]},buildContent(entry,text){return entry.media?{image:Buffer.from('fixture'),caption:text}:{text}},async waitBetweenSends(){}
  })
  vm.runInContext(functions,context)
  return {context,timers,offline(){online=false},online(){online=true},snapshot(){return persisted},
    arm(){context.scheduleAccount('fixture',data)},
    async advance(ms){clock.now+=ms;for(let i=0;i<30;i++){const found=[...timers].find(([,timer])=>timer.at<=clock.now);if(!found)break;const [id,timer]=found;timers.delete(id);await timer.fn();await Promise.resolve();await Promise.resolve()}},data}
}

test('background worker repeats, coalesces downtime, survives restart and prevents duplicate timer sends', async()=>{
  const clock={now:Date.parse('2026-10-08T12:00:00Z')},calls=[]
  const interval={value:1,unit:'minutes'}
  const data={jobs:[{id:'job',name:'Fixture',messageId:'message',interval,nextRunAt:new Date(clock.now+60000).toISOString(),status:'scheduled',repeatCount:1,delaySeconds:[0,0],toLists:['fixture'],toRecipients:[],toStatus:true}],messages:[{id:'message',texts:['fixture']}],delaySeconds:[0,0]}
  const first=worker(data,clock,calls);first.arm();first.arm();assert.equal(first.timers.size,1)
  await first.advance(60000);assert.equal(calls.length,2);assert.equal(data.jobs[0].status,'scheduled');assert(data.jobs[0].activeRun.finishedAt)
  await first.advance(60000);assert.equal(calls.length,4,'the worker automatically arms the following occurrence without dashboard activity')
  first.arm();first.arm();await first.advance(5*60000);assert.equal(calls.length,6,'missed intervals result in one run rather than a burst of duplicate posts')
  assert.equal(data.jobs[0].nextRunAt,'2026-10-08T12:08:00.000Z')
  const snapshot=first.snapshot(),restarted=worker(snapshot,clock,calls);restarted.arm()
  await restarted.advance(60000);assert.equal(calls.length,8,'restart preserves the next occurrence and does not replay the finished one')
  await restarted.context.runJob('fixture','job',{occurrenceAt:snapshot.jobs[0].lastOccurrenceAt});assert.equal(calls.length,8,'duplicate occurrence callback is ignored')
  snapshot.jobs[0].status='paused';restarted.arm();await restarted.advance(60000);assert.equal(calls.length,8)
  snapshot.jobs[0].status='scheduled';restarted.arm();restarted.offline();await restarted.advance(0);assert.equal(calls.length,8);assert.equal(snapshot.jobs[0].status,'scheduled')
  assert.equal(restarted.timers.size,1,'offline waits have one bounded retry timer')
  restarted.online();await restarted.advance(30000);assert.equal(calls.length,10,'a saved schedule resumes after connectivity returns')
  snapshot.jobs=[];restarted.arm();await restarted.advance(60000);assert.equal(calls.length,10,'deleting a schedule stops future deliveries')
})
