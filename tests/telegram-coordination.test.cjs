const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createPlatformStore}=require('../platform-store.cjs');
const {createTelegramRuntime}=require('../src/server/modules/notifications/telegram-runtime.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-leader-'));
  const first=createPlatformStore(dir),second=createPlatformStore(dir),runtimes=[];
  t.after(()=>{runtimes.forEach(runtime=>runtime.stop());first.close();second.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {first,second,runtimes};
}
test('Telegram long-poll lease is exclusive across database connections, expires and rejects stale release',t=>{
  const f=fixture(t),a=f.first.telegram,b=f.second.telegram;
  assert.equal(a.acquirePollLease('first',0),true);assert.equal(b.acquirePollLease('second',0),false);
  assert.equal(a.acquirePollLease('first',60000),true);assert.equal(b.acquirePollLease('second',120001),false);
  assert.equal(b.acquirePollLease('second',180001),true);a.releasePollLease('first');assert.equal(a.acquirePollLease('first',180002),false);
  b.releasePollLease('second');assert.equal(a.acquirePollLease('first',180003),true);
});
test('only one runtime polls the bot and graceful shutdown lets another runtime take over',async t=>{
  const f=fixture(t),calls=[0,0];
  const bot=index=>({initialize:async()=>({username:'Synthetic_bot'}),updates:async(offset,signal)=>{calls[index]++;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));}});
  const first=createTelegramRuntime({platform:f.first,tenantStore:()=>{},bot:bot(0)}),second=createTelegramRuntime({platform:f.second,tenantStore:()=>{},bot:bot(1)});f.runtimes.push(first,second);
  first.start();second.start();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[1,0]);
  first.stop();second.stop();second.start();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[1,1]);first.stop();second.stop();
});
test('expired delivery workers cannot finish a newer claim or a changed appointment job',async t=>{
  const f=fixture(t),owner=await f.first.registerOwner({email:'lease@example.test',password:'Synthetic-lease-password',displayName:'Test',organizationName:'Test'}),org=owner.organizationId;
  const a={id:'a',date:'2030-01-01',time:'10:00',service:'One',serviceItems:[{id:'s',name:'One',duration:30,price:10}]};
  f.first.telegram.enqueue(org,'p',a,'stamp',{chatId:'synthetic'},500000,0);
  const old=f.first.telegram.claim(0),next=f.second.telegram.claim(120001);assert.equal(next.attempts,2);
  assert.equal(f.first.telegram.finish(old,'sent'),false);assert.equal(f.second.telegram.delivery(org,'p','stamp'),'sending');
  assert.equal(f.first.telegram.defer(old,130000),false);
  assert.equal(f.second.telegram.finish(next,'sent'),true);
  f.first.telegram.enqueue(org,'p',{...a,serviceItems:[{...a.serviceItems[0],name:'Two'}]},'stamp',{chatId:'synthetic'},500000,120001);
  const changed=f.second.telegram.claim(120001);assert.equal(changed.attempts,1);
  assert.equal(f.first.telegram.finish(old,'sent'),false);assert.equal(f.second.telegram.finish(changed,'sent'),true);
});
test('rate deferral preserves retry budget and survives database connections',async t=>{
  const f=fixture(t),owner=await f.first.registerOwner({email:'defer@example.test',password:'Synthetic-defer-password',displayName:'Test',organizationName:'Test'}),org=owner.organizationId;
  const a={id:'a',date:'2030-01-01',time:'10:00',service:'One'};
  f.first.telegram.enqueue(org,'p',a,'stamp',{chatId:'synthetic'},500000,0);
  const job=f.first.telegram.claim(0);
  assert.equal(job.attempts,1);assert.equal(f.first.telegram.defer(job,1000),true);
  assert.equal(f.second.telegram.claim(999),null);
  const retry=f.second.telegram.claim(1000);assert.equal(retry.attempts,1);
  assert.equal(f.first.telegram.defer(job,2000),false);
  assert.equal(f.second.telegram.finish(retry,'sent'),true);
});
