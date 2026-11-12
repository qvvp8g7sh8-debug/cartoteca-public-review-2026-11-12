const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { migrateStaffNotifications } = require('../src/server/migrations/010-staff-notifications.cjs');
const { createStaffTelegramRuntime } = require('../src/server/modules/notifications/staff-runtime.cjs');
const { createTelegramPacing } = require('../src/server/modules/notifications/telegram-pacing.cjs');
const password = 'Synthetic-staff-notification-password';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-staff-notify-'));
  const platform = createPlatformStore(dir);
  const raw = createPlatformDatabase(dir);
  t.after(() => { raw.db.close(); platform.close(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = await platform.registerOwner({email:'owner@notify.test',password,displayName:'Synthetic owner',organizationName:'Synthetic organization'});
  platform.verifyEmail(owner.verificationToken);
  const users = [{...owner,token:(await platform.login('owner@notify.test',password)).token}];
  for(const [i,role] of ['salon_admin','cosmetologist','cosmetologist'].entries()) {
    const invitation = platform.createInvitation({organizationId:owner.organizationId,invitedBy:owner.accountId,role});
    const user = await platform.acceptInvitation({token:invitation.token,email:`staff${i}@notify.test`,password,displayName:'Synthetic staff'});
    users.push({...user,token:(await platform.login(`staff${i}@notify.test`,password)).token});
  }
  let now = Date.now();
  const connect = (user,index) => { const issued = platform.staffNotifications.issue(user.token,now); platform.staffNotifications.consume(issued.token,String(1000+index),now); return issued; };
  const create = (key='synthetic-notification-key',kind='other-time') => platform.withWriteLock(() => platform.bookingRequests.create(owner.organizationId,key,{staffId:users[2].accountId,date:'2035-01-01',time:'10:00',duration:30,kind,services:[{id:'s',name:'Synthetic service'}],firstName:'PRIVATE CLIENT',phone:'+79990000000',comment:'PRIVATE COMMENT'},30,now));
  const jobs = () => raw.db.prepare('SELECT * FROM staff_notification_jobs ORDER BY account_id').all();
  return {dir,platform,raw,users,owner,connect,create,jobs,clock:()=>now,advance:ms=>now+=ms};
}
test('atomic booking events notify managers and assigned staff only; retries deduplicate and values are encrypted', async t => {
  const f=await fixture(t); f.users.forEach(f.connect);
  const record=f.create(); assert.equal(f.jobs().length,3);
  assert.deepEqual(f.jobs().map(j=>j.account_id).sort(),f.users.slice(0,3).map(u=>u.accountId).sort());
  assert.equal(f.create().id,record.id); assert.equal(f.jobs().length,3);
  for(const j of f.jobs()) assert.doesNotMatch(Buffer.from(j.value).toString(),/PRIVATE|79990000000|100[0-3]|Synthetic service/);
  const status=f.platform.staffNotifications.status(f.users[2].token);
  assert.equal(status.linked,true); assert.ok(!JSON.stringify(status).includes('1002'));
  assert.throws(()=>f.platform.staffNotifications.enqueue(f.owner.organizationId,record,'new-request'),/transaction/);
  assert.throws(()=>f.platform.withWriteLock(()=>{f.platform.staffNotifications.enqueue(f.owner.organizationId,{...record,revision:1},'client-agreed');throw Error('rollback');}),/rollback/);
  assert.equal(f.jobs().length,3);
});
test('links are personal, short-lived, replay-safe and revocation invalidates old capabilities',async t=>{
  const f=await fixture(t),a=f.connect(f.users[2],2);
  f.platform.staffNotifications.consume(a.token,'1002',f.clock());
  assert.throws(()=>f.platform.staffNotifications.consume(a.token,'1003',f.clock()),{status:409});
  const b=f.platform.staffNotifications.issue(f.users[3].token,f.clock());
  assert.throws(()=>f.platform.staffNotifications.consume(b.token,'1002',f.clock()),{status:409});
  assert.throws(()=>f.platform.staffNotifications.consume(b.token,'-1002',f.clock()),{status:400});
  f.advance(15*60000); assert.throws(()=>f.platform.staffNotifications.consume(b.token,'1003',f.clock()),{status:400});
  const binding=f.platform.staffNotifications.status(f.users[2].token).bindingId;
  assert.throws(()=>f.platform.staffNotifications.update(f.users[3].token,{bindingId:binding,enabled:false}),{status:409});
  f.platform.staffNotifications.update(f.users[2].token,{bindingId:binding},true);
  assert.throws(()=>f.platform.staffNotifications.consume(a.token,'1002',f.clock()),{status:400});
  f.connect(f.users[2],2);
  assert.throws(()=>f.platform.staffNotifications.update(f.users[2].token,{bindingId:binding,enabled:false}),{status:409});
});
test('send rechecks active membership, binding and lease; old workers cannot finalize a new claim',async t=>{
  const f=await fixture(t);f.connect(f.users[2],2);f.create();
  const old=f.platform.staffNotifications.claim(f.clock());assert.ok(f.platform.staffNotifications.valid(old,f.clock()));
  f.advance(120001);assert.equal(f.platform.staffNotifications.valid(old,f.clock()),null);
  const newer=f.platform.staffNotifications.claim(f.clock());assert.equal(f.platform.staffNotifications.finish(old,'sent'),false);
  f.raw.db.prepare("UPDATE memberships SET status='suspended' WHERE account_id=?").run(f.users[2].accountId);
  assert.equal(f.platform.staffNotifications.valid(newer,f.clock()),null);
  f.raw.db.prepare("UPDATE memberships SET status='active' WHERE account_id=?").run(f.users[2].accountId);
  f.platform.staffNotifications.stopChat('1002');assert.equal(f.platform.staffNotifications.valid(newer,f.clock()),null);
  assert.equal(f.platform.staffNotifications.status(f.users[2].token).linked,false);
});
test('disable cancels backlog; personal notifications do not require client reminders to be enabled',async t=>{
  const f=await fixture(t);f.connect(f.users[2],2);f.create();
  f.raw.db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)').run(
    f.owner.organizationId,f.raw.seal({enabled:false,restoredPaused:true,leadMinutes:1440,timeZone:'Europe/Moscow',showServices:true}));
  assert.equal(f.platform.telegram.settings(f.owner.organizationId).enabled,false);
  let state=f.platform.staffNotifications.status(f.users[2].token);
  f.platform.staffNotifications.update(f.users[2].token,{bindingId:state.bindingId,enabled:false});
  assert.equal(f.jobs()[0].status,'cancelled');f.create('synthetic-disabled-key');assert.equal(f.jobs().length,1);
  f.platform.staffNotifications.update(f.users[2].token,{bindingId:state.bindingId,enabled:true});
  f.create('synthetic-enabled-key');assert.equal(f.jobs().length,2);assert.equal(f.jobs().filter(j=>j.status==='pending').length,1);
});
test('runtime shares pacing, refunds 429 retries, sends no private contacts and cancels outdated jobs',async t=>{
  const f=await fixture(t);f.connect(f.users[2],2);f.create();let fails=true,sent=[];
  const bot={send:async(chat,text,markup)=>{if(fails){fails=false;throw Object.assign(Error('rate limit'),{status:429,retryAfter:30});}sent.push({chat,text,markup});}};
  const pacing=createTelegramPacing({clock:f.clock,wait:async ms=>f.advance(ms)});
  const runtime=createStaffTelegramRuntime({platform:f.platform,bot,pacing,clock:f.clock,origin:'https://synthetic.test'});
  await runtime.tick(undefined,()=>true);assert.equal(f.jobs()[0].attempts,0);assert.equal(sent.length,0);assert.ok(pacing.remaining('different')>=30000);
  f.advance(30001);await runtime.tick(undefined,()=>true);
  assert.equal(f.jobs()[0].status,'sent');assert.equal(sent[0].chat,'1002');assert.match(sent[0].text,/Synthetic organization|Synthetic service/);
  assert.doesNotMatch(sent[0].text,/PRIVATE|79990000000/);assert.ok(sent[0].markup.inline_keyboard[0][0].url.startsWith('https://synthetic.test/'));
  f.create('synthetic-expired-key','reserve');f.advance(31*60000);await runtime.tick(undefined,()=>true);assert.equal(sent.length,1);
  const clientToken=f.platform.telegram.issueLink(f.owner.organizationId,'synthetic-client',f.owner.accountId);
  f.platform.telegram.consumeLink(clientToken,'1002',()=>true);
  f.create('synthetic-blocked-key');bot.send=async()=>{throw Object.assign(Error('blocked'),{status:403});};
  await runtime.tick(undefined,()=>true);
  assert.equal(f.platform.staffNotifications.status(f.users[2].token).linked,false);
  assert.equal(f.platform.telegram.link(f.owner.organizationId,'synthetic-client'),null);
});
test('membership revoked during pacing cannot receive a queued message; expired jobs never send',async t=>{
  const f=await fixture(t);f.connect(f.users[2],2);f.create();let sends=0;
  const pacing={acquire:async()=>{f.raw.db.prepare("UPDATE memberships SET status='suspended' WHERE account_id=?").run(f.users[2].accountId);return true;}};
  await createStaffTelegramRuntime({platform:f.platform,bot:{send:async()=>sends++},pacing,clock:f.clock}).tick(undefined,()=>true);
  assert.equal(sends,0);assert.equal(f.jobs()[0].status,'cancelled');
  f.raw.db.prepare("UPDATE memberships SET status='active' WHERE account_id=?").run(f.users[2].accountId);f.create('synthetic-ttl-key');f.advance(86400001);
  assert.equal(f.platform.staffNotifications.claim(f.clock()),null);
});
test('migration snapshots populated version 9 and rolls back failed DDL',async t=>{
  const f=await fixture(t);f.raw.db.exec('DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; PRAGMA user_version=9');
  migrateStaffNotifications(f.raw,f.dir);assert.equal(f.raw.db.prepare('PRAGMA user_version').get().user_version,10);
  const directory=fs.readdirSync(path.join(f.dir,'migration-backups')).find(n=>n.startsWith('before-010-'));
  const snapshot=new DatabaseSync(path.join(f.dir,'migration-backups',directory,'platform.sqlite'),{readOnly:true});
  try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,9);assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(),[]);}finally{snapshot.close();}
  f.raw.db.exec('DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; CREATE TABLE staff_notification_jobs(bad TEXT); PRAGMA user_version=9');
  assert.throws(()=>migrateStaffNotifications(f.raw,f.dir));assert.equal(f.raw.db.prepare('PRAGMA user_version').get().user_version,9);
  assert.equal(f.raw.db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_telegram_links'").get(),undefined);
});
