const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { migrateBookingRequests } = require('../src/server/migrations/009-booking-requests.cjs');
const { createBookingRequestStore } = require('../src/server/modules/booking/request-store.cjs');
const { assertReservationChanges } = require('../src/server/modules/booking/reservation-guard.cjs');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-request-store-'));
  const platform = createPlatformStore(dir);
  const owner = await platform.registerOwner({email:'synthetic@requests.test', password:'Synthetic-request-password', displayName:'Synthetic', organizationName:'Synthetic'});
  platform.close();
  const database = createPlatformDatabase(dir), store = createBookingRequestStore(database);
  t.after(() => { database.db.close(); assert.equal(path.dirname(dir),path.resolve(os.tmpdir())); fs.rmSync(dir,{recursive:true,force:true}); });
  const payload = {date:'2030-01-01',time:'09:00',duration:30,staffId:owner.accountId,roomId:'main',kind:'reserve',name:'Private synthetic contact',phone:'+79990000000',serviceIds:['s']};
  return {dir,database,store,owner,payload};
}

test('inbox summary reads only sealed metadata and detects expiry and acceptance preparation', async t => {
  const f=await fixture(t),org=f.owner.organizationId,now=100000;
  const record=f.database.transaction(()=>f.store.create(org,'synthetic-summary-key',f.payload,30,now));
  const metadataOnly=createBookingRequestStore({...f.database,open(){throw Error('Contact decryption is forbidden for summary');}});
  const first=metadataOnly.summary(org,null,now);
  assert.equal(first.count,1);
  assert.deepEqual(Object.keys(first).sort(),['checkedAt','count','version']);
  assert.equal(metadataOnly.summary(org,null,now+1).version,first.version);
  assert.notEqual(metadataOnly.summary(org,null,record.expiresAt).version,first.version);
  assert.equal(metadataOnly.summary(org,'other-staff',now).count,0);
  assert.equal(metadataOnly.summary('other-organization',null,now).count,0);
  f.database.transaction(()=>f.store.prepareAcceptance(org,record.id,0,'synthetic-patient',now,{date:'2030-01-01',time:'10:00'}));
  assert.equal(f.store.get(org,record.id,now).revision,0);
  assert.notEqual(metadataOnly.summary(org,null,now).version,first.version);
  const page=f.store.list(org,null,null,now);
  assert.equal(page.version,metadataOnly.summary(org,null,now).version);
  assert.equal(f.database.db.isTransaction,false);
  f.database.transaction(()=>f.store.finish(org,record.id,0,'rejected',now));
  assert.equal(metadataOnly.summary(org,null,now).count,0);
});
test('durable requests are encrypted, idempotent and do not renew an expired reservation', async t => {
  const f=await fixture(t), org=f.owner.organizationId, now=100000;
  const create=(payload=f.payload)=>f.database.transaction(()=>f.store.create(org,'synthetic-key-0001',payload,30,now));
  assert.throws(()=>f.store.create(org,'synthetic-key-0001',f.payload,30,now),/transaction/);
  const first=create(), second=create(); assert.deepEqual(second,first);
  assert.equal(first.expiresAt,now+1800000); assert.equal(first.status,'pending');
  assert.equal(f.store.get('other-org',first.id,now),null);
  assert.throws(()=>create({...f.payload,time:'10:00'}),{status:409});
  assert.equal(f.store.get(org,first.id,first.expiresAt).status,'expired');
  assert.equal(f.database.transaction(()=>f.store.create(org,'synthetic-key-0001',f.payload,30,first.expiresAt)).status,'expired');
  const bytes=f.database.db.prepare('SELECT value FROM booking_requests').get().value;
  assert.ok(!Buffer.from(bytes).includes(Buffer.from(f.payload.name)));
  assert.equal(f.store.reserves(org,'2030-01-01','2030-01-01',now).length,1);
  assert.equal(f.store.reserves(org,'2030-01-01','2030-01-01',first.expiresAt).length,0);
  assert.equal(f.store.reserves(org,'2030-01-01','2030-01-01',now,first.id).length,0);
});
test('other-time requests never reserve; terminal changes are revision guarded and rollback safe',async t=>{
  const f=await fixture(t),org=f.owner.organizationId;
  const request=f.database.transaction(()=>f.store.create(org,'synthetic-key-0002',{...f.payload,kind:'other-time'},30,100));
  assert.equal(request.status,'requested');assert.equal(request.expiresAt,100+86400000);
  assert.deepEqual(f.store.reserves(org,'2030-01-01','2030-01-01',100),[]);
  assert.throws(()=>f.database.transaction(()=>{f.store.finish(org,request.id,0,'rejected',100);throw Error('rollback');}),/rollback/);
  assert.equal(f.store.get(org,request.id,100).status,'requested');
  assert.throws(()=>f.database.transaction(()=>f.store.finish(org,request.id,1,'rejected',100)),{status:409});
  const result=f.database.transaction(()=>f.store.finish(org,request.id,0,'rejected',100));
  assert.equal(result.revision,1);assert.equal(result.status,'rejected');
  assert.throws(()=>f.database.transaction(()=>f.store.finish(org,request.id,1,'accepted',100)),{status:409});
});

test('another-time deadline unlocks one normalized phone at exactly 24 hours without reserving or renewing',async t=>{
  const f=await fixture(t),org=f.owner.organizationId,now=100000;
  const payload={...f.payload,kind:'other-time'};
  const first=f.database.transaction(()=>f.store.create(org,'synthetic-expiry-key-01',payload,30,now));
  const deadline=now+86400000;
  const peerDatabase=createPlatformDatabase(f.dir),peer=createBookingRequestStore(peerDatabase);
  try {
    assert.throws(()=>peer.publicCapacity(org,'89990000000',deadline-1),{status:409});
    assert.doesNotThrow(()=>peer.publicCapacity('another-org','89990000000',deadline-1));
    assert.equal(peer.get(org,first.id,deadline-1).status,'requested');
    assert.equal(peer.get(org,first.id,deadline).status,'expired');
    assert.doesNotThrow(()=>peer.publicCapacity(org,'89990000000',deadline));
    const replay=peerDatabase.transaction(()=>peer.create(org,'synthetic-expiry-key-01',payload,60,deadline));
    assert.equal(replay.id,first.id);assert.equal(replay.expiresAt,deadline);assert.equal(replay.status,'expired');
    assert.equal(peer.byKey(org,'synthetic-expiry-key-01',deadline).status,'expired');
    const second=peerDatabase.transaction(()=>peer.create(org,'synthetic-expiry-key-02',payload,30,deadline));
    assert.notEqual(second.id,first.id);
    assert.throws(()=>f.store.publicCapacity(org,'+79990000000',deadline),{status:409});
    assert.deepEqual(peer.reserves(org,payload.date,payload.date,deadline),[]);
    assert.equal(peer.list(org,null,null,deadline).items.find(r=>r.id===first.id).status,'expired');
    peerDatabase.transaction(()=>peer.finish(org,second.id,0,'accepted',deadline));
    assert.equal(peer.get(org,second.id,second.expiresAt).status,'accepted');
  } finally {peerDatabase.db.close();}
});

test('legacy NULL deadlines expire from original creation and survive database reopening without rewriting rows',async t=>{
  const f=await fixture(t),org=f.owner.organizationId,now=100000;
  const first=f.database.transaction(()=>f.store.create(org,'synthetic-legacy-key-01',{...f.payload,kind:'other-time'},30,now));
  f.database.db.prepare('UPDATE booking_requests SET expires_at=NULL WHERE id=?').run(first.id);
  const peerDatabase=createPlatformDatabase(f.dir),peer=createBookingRequestStore(peerDatabase);
  try {
    assert.equal(peer.get(org,first.id,now).expiresAt,now+86400000);
    assert.throws(()=>peer.publicCapacity(org,'89990000000',now+86400000-1),{status:409});
    assert.doesNotThrow(()=>peer.publicCapacity(org,'89990000000',now+86400000));
    assert.equal(peer.get(org,first.id,now+86400000).status,'expired');
    assert.equal(peerDatabase.db.prepare('SELECT expires_at FROM booking_requests WHERE id=?').get(first.id).expires_at,null);
    assert.equal(peer.list(org,null,null,now+86400000).items.length,1);
  } finally {peerDatabase.db.close();}
});
test('schema 9 verifies an encrypted schema 8 snapshot and leaves schema unchanged after failed DDL',async t=>{
  const f=await fixture(t),db=f.database.db;
  db.exec('DROP TABLE booking_requests; PRAGMA user_version=8');
  migrateBookingRequests(f.database,f.dir);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,9);
  const root=path.join(f.dir,'migration-backups'), saved=fs.readdirSync(root).find(n=>n.startsWith('before-009-'));
  const snapshot=new DatabaseSync(path.join(root,saved,'platform.sqlite'),{readOnly:true});
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');snapshot.close();
  assert.deepEqual(fs.readFileSync(path.join(root,saved,'platform.key')),fs.readFileSync(path.join(f.dir,'platform.key')));
  const count=fs.readdirSync(root).length;migrateBookingRequests(f.database,f.dir);assert.equal(fs.readdirSync(root).length,count);
  db.exec('DROP TABLE booking_requests; CREATE TABLE booking_requests(bad TEXT); PRAGMA user_version=8');
  assert.throws(()=>migrateBookingRequests(f.database,f.dir),/already exists/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n,1);
});
test('manual writes respect active reserves for staff and room, allow expired and unchanged occupancy',()=>{
  const now=Date.parse('2030-01-01T00:00:00Z'), a={id:'a',date:'2030-01-01',time:'09:00',duration:30,staffId:'s',roomId:'r'};
  const reserve={...a,id:'request',expiresAt:now+10000,status:'pending'};
  const platform={workspaceSettings:()=>({enabled:false,rooms:[{id:'r',active:true,preventOverlap:true,staffIds:['s','other']},{id:'r2',active:true,preventOverlap:true,staffIds:['s','other']}]}),organizationTimeZone:()=> 'Europe/Moscow',bookingRequests:{reserves:(_org,_from,_to,clock)=>clock<reserve.expiresAt?[reserve]:[]}};
  const state=(item)=>({patients:item?[{id:'p',appointments:[item]}]:[]});
  const check=(item,old=null,clock=now)=>assertReservationChanges(platform,'org',state(old),state(item),clock);
  assert.throws(()=>check(a),{status:409});
  assert.throws(()=>check({...a,roomId:'r2'}),{status:409});
  assert.throws(()=>check({...a,staffId:'other'}),{status:409});
  assert.doesNotThrow(()=>check({...a,staffId:'other',roomId:'r2'}));
  assert.doesNotThrow(()=>check({...a,time:'09:30'}));
  assert.doesNotThrow(()=>check({...a,confirmed:true},a));
  assert.doesNotThrow(()=>check(a,null,reserve.expiresAt));
  reserve.date='2030-01-02';reserve.time='00:00';
  platform.bookingRequests.reserves=(_org,from,to)=>{
    assert.equal(from,'2029-12-31');assert.equal(to,'2030-01-02');return [reserve];
  };
  assert.throws(()=>check({...a,time:'23:45',duration:60}),{status:409});
});
