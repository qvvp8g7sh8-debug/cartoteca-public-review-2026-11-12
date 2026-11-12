const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlatformStore}=require('../platform-store.cjs'),{createStorage}=require('../storage.cjs');
const {createMultiServer}=require('../multi-server.cjs');
const {publicInfo,publicAvailability,publicDates,publicSubmit}=require('../src/server/modules/booking/public-service.cjs');
const {privateBookingHealth}=require('../src/server/modules/booking/readiness.cjs');
const {PRIVACY_VERSION}=require('../src/shared/privacy-consent.cjs');
const date='2030-01-01',now=Date.parse(date+'T00:00:00Z'),password='Synthetic-public-booking-password';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-public-booking-')),platform=createPlatformStore(path.join(dir,'platform'));
  let storage;t.after(()=>{storage?.close();platform.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const owner=await platform.registerOwner({email:'owner@public-booking.test',password,displayName:'Synthetic specialist',organizationName:'Synthetic organization',city:'Synthetic city'});platform.verifyEmail(owner.verificationToken);
  const token=(await platform.login('owner@public-booking.test',password)).token;
  storage=createStorage(path.join(dir,'tenants',owner.organizationId));
  storage.write({revision:0,patients:[{id:'private-card',name:'Private record not public',phone:'+79990000099',createdBy:owner.accountId,visits:[],appointments:[]}],services:[{id:'s',name:'Synthetic service',duration:'30 минут',price:120}]});
  platform.workSchedules.save(token,{staffId:owner.accountId,dates:[date,'2030-01-02'],status:'working',intervals:[['09:00','12:00'],['13:00','24:00']],revision:0,expectedTimeZone:'Europe/Moscow'},storage);
  const context={platform,tenantStore:()=>storage,clientAddress:()=> 'synthetic-client',req:{}};
  const enable=()=>platform.bookingPublication.save(token,{enabled:true,revision:platform.bookingPublication.view(token).revision});
  const input=(key,extra={})=>({key,date,time:'09:00',serviceIds:['s'],staffId:owner.accountId,kind:'reserve',firstName:'Synthetic',phone:'+79990000000',consent:true,privacyConsentVersion:PRIVACY_VERSION,...extra});
  return {dir,platform,owner,token,storage,context,enable,input};
}
test('fresh public proof recovers an IP change with the original idempotency key', async t => {
  const f = await fixture(t); f.enable();
  const org = f.owner.organizationId, key = publicInfo(f.context, org, now).challenge;
  const changed = { ...f.context, clientAddress: () => 'synthetic-new-address' };
  assert.throws(() => publicSubmit(changed, org, f.input(key), now + 2000),
    { status: 400, code: 'BOOKING_CHALLENGE_REJECTED' });
  assert.equal(f.platform.bookingRequests.byKey(org, key, now + 2000), null);
  const challenge = publicInfo(changed, org, now + 2000).challenge;
  assert.throws(() => publicSubmit(changed, org, f.input('arbitrary-key-with-valid-length', { challenge }), now + 2500),
    { status: 400 });
  const input = f.input(key, { challenge });
  const result = publicSubmit(changed, org, input, now + 3000);
  const next = publicInfo(changed, org, now + 4000).challenge;
  assert.deepEqual(publicSubmit(changed, org, { ...input, challenge: next }, now + 5000), result);
  assert.ok(!('challenge' in f.platform.bookingRequests.byKey(org, key, now + 5000).submission));
  assert.throws(() => publicSubmit(changed, org, f.input(key, { challenge: key }), now + 6000),
    { status: 400, code: 'BOOKING_CHALLENGE_REJECTED' });
});

test('expired public proof needs a fresh signed proof; renewal preserves the key', async t => {
  const f = await fixture(t); f.enable();
  const org = f.owner.organizationId, key = publicInfo(f.context, org, now).challenge;
  const later = now + 31 * 60000;
  assert.throws(() => publicSubmit(f.context, org, f.input(key), later),
    { status: 400, code: 'BOOKING_CHALLENGE_REJECTED' });
  const challenge = publicInfo(f.context, org, later).challenge;
  const result = publicSubmit(f.context, org, f.input(key, { challenge }), later + 1);
  assert.equal(result.status, 'pending');
  assert.ok(f.platform.bookingRequests.byKey(org, key, later + 1));
});

test('public booking is opt-in, tenant-scoped and exposes only public services/staff, not contacts or permissions',async t=>{
  const f=await fixture(t),org=f.owner.organizationId;
  assert.equal(f.platform.bookingPublication.view(f.token).enabled,false);
  assert.throws(()=>publicInfo(f.context,org,now),{status:404});
  f.enable();const info=publicInfo(f.context,org,now),text=JSON.stringify(info);
  assert.equal(info.services.length,1);assert.equal(info.members.length,1);assert.ok(info.challenge);
  for(const secret of ['Private record','79990000099','owner@','manageOwnRequests','allowSelfEdit','password','salt'])assert.ok(!text.includes(secret));
  assert.throws(()=>publicInfo(f.context,'not-an-organization',now),{status:404});
  f.platform.bookingPublication.save(f.token,{enabled:false,revision:1});
  const closed=publicInfo(f.context,org,now);
  assert.equal(closed.health.reason,'paused');assert.equal(closed.health.available,false);
  assert.deepEqual(closed.services,[]);assert.deepEqual(closed.members,[]);assert.equal(closed.challenge,undefined);
  assert.throws(()=>publicAvailability(f.context,org,{date,serviceIds:['s'],staffId:f.owner.accountId},now),{status:404});
  assert.throws(()=>publicDates(f.context,org,'2030-01',f.owner.accountId),{status:404});
  assert.throws(()=>publicSubmit(f.context,org,f.input(info.challenge),now+2000),{status:404});
});

test('public category context uses only the current organization groups and preserves empty fallbacks',async t=>{
  const f=await fixture(t),org=f.owner.organizationId;
  f.platform.createServiceGroup(f.token,{revision:0,id:'shared',title:'Public procedure'});
  f.platform.createServiceGroup(f.token,{revision:1,id:'unused',title:'Unpublished group'});
  const other=await f.platform.registerOwner({email:'other-category@public-booking.test',password,displayName:'Other',organizationName:'Other organization'});
  f.platform.verifyEmail(other.verificationToken);
  const otherToken=(await f.platform.login('other-category@public-booking.test',password)).token;
  f.platform.createServiceGroup(otherToken,{revision:0,id:'shared',title:'Foreign procedure'});
  f.platform.createServiceGroup(otherToken,{revision:1,id:'foreign',title:'Foreign private group'});
  const data=f.storage.read();
  data.services=['shared','other','','missing','foreign'].map((category,i)=>({id:'category-'+i,name:'Synthetic zone '+i,category,duration:'30 минут',price:120}));
  data.services.push({id:'hidden-category',name:'Hidden service',category:'unused',duration:'30 минут',price:120,staffId:'unavailable-staff'});
  f.storage.write(data);
  f.enable();
  const info=publicInfo(f.context,org,now);
  assert.deepEqual(info.services.map(({id,categoryId,categoryTitle})=>({id,categoryId,categoryTitle})),[
    {id:'category-0',categoryId:'shared',categoryTitle:'Public procedure'},
    {id:'category-1',categoryId:'other',categoryTitle:'Другое'},
    ...[2,3,4].map(i=>({id:'category-'+i,categoryId:'',categoryTitle:''})),
  ]);
  const text=JSON.stringify(info);
  for(const hidden of ['Foreign procedure','Foreign private group','Unpublished group','Hidden service'])assert.ok(!text.includes(hidden));
  assert.ok(!('groups' in info));assert.ok(!('serviceGroups' in info));
});

test('missing working days disable publication; restoring graph never enables it automatically',async t=>{
  const f=await fixture(t),org=f.owner.organizationId;
  const context={...f.context,token:f.token,current:{organizationId:org}};
  assert.equal(privateBookingHealth(context,now).enabled,false);
  f.enable();
  assert.equal(publicInfo(f.context,org,now).health.available,true);
  f.platform.workSchedules.save(f.token,{staffId:f.owner.accountId,dates:[date,'2030-01-02'],status:'closed',intervals:[],revision:1,expectedTimeZone:'Europe/Moscow'},f.storage);
  const health=privateBookingHealth(context,now),info=publicInfo(f.context,org,now);
  assert.equal(health.enabled,false);assert.equal(health.available,false);
  assert.deepEqual(health.issues.map(p=>p.code),['no_working_days']);
  assert.equal(info.health.reason,'no_working_days');
  assert.equal(f.platform.bookingPublication.view(f.token).enabled,false);
  assert.throws(()=>publicAvailability(f.context,org,{date,serviceIds:['s'],staffId:f.owner.accountId},now),{status:404});
  f.platform.workSchedules.save(f.token,{staffId:f.owner.accountId,dates:['2030-01-03'],status:'working',intervals:[['09:00','10:00']],revision:2,expectedTimeZone:'Europe/Moscow'},f.storage);
  assert.equal(privateBookingHealth(context,now).enabled,false);
  assert.deepEqual(privateBookingHealth(context,now).issues.map(p=>p.code),['awaiting_activation']);
  assert.equal(publicInfo(f.context,org,now).health.reason,'awaiting_activation');
  f.enable();
  assert.equal(privateBookingHealth(context,now).available,true);
  assert.equal(publicInfo(f.context,org,now).health.nextDate,'2030-01-03');
});
test('hidden public prices stay in internal catalog and request snapshots; setting survives omitted legacy writes and isolates tenants',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId;
  assert.equal(publicInfo(f.context,org,now).showPrices,true);
  assert.equal(publicInfo(f.context,org,now).services[0].price,120);
  const values=()=>{const {revision,mode,minimumLeadMinutes,reservationMinutes,staff,services}=f.platform.onlineBooking.view(f.token);return {revision,mode,minimumLeadMinutes,reservationMinutes,staff,services};};
  f.platform.onlineBooking.save(f.token,{...values(),showPrices:false},new Set(['s']));
  const info=publicInfo(f.context,org,now);
  assert.equal(info.showPrices,false);assert.ok(!('price' in info.services[0]));
  const available=publicAvailability(f.context,org,{date,serviceIds:['s'],staffId:f.owner.accountId},now);
  assert.ok(!JSON.stringify(available).includes('price'));
  assert.equal(f.storage.readServices()[0].price,120);
  publicSubmit(f.context,org,f.input(info.challenge),now+2000);
  assert.equal(f.platform.bookingRequests.byKey(org,info.challenge,now+2000).services[0].price,120);
  f.platform.onlineBooking.save(f.token,values(),new Set(['s']));
  assert.equal(f.platform.onlineBooking.view(f.token).showPrices,false);
  assert.throws(()=>f.platform.onlineBooking.save(f.token,{...values(),showPrices:'false'},new Set(['s'])),{status:400});
  assert.equal(require('../src/server/modules/booking/settings.cjs').defaults().showPrices,true);
  const other=await f.platform.registerOwner({email:'other@price.test',password,displayName:'Other',organizationName:'Other organization',city:'Synthetic city'});f.platform.verifyEmail(other.verificationToken);
  const otherToken=(await f.platform.login('other@price.test',password)).token;
  assert.equal(f.platform.onlineBooking.view(otherToken).showPrices,true);
  f.platform.onlineBooking.save(f.token,{...values(),showPrices:true},new Set(['s']));
  assert.equal(publicInfo(f.context,org,now).services[0].price,120);
});

test('month navigation has no fixed future horizon; public slots hide rooms and another-time options exclude breaks/closures',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId;
  assert.deepEqual(publicDates(f.context,org,'2030-01',f.owner.accountId).dates,[date,'2030-01-02']);
  assert.deepEqual(publicDates(f.context,org,'2040-02',f.owner.accountId).dates,[]);
  const preview=publicAvailability(f.context,org,{date,serviceIds:['s'],staffId:f.owner.accountId},now);
  assert.ok(preview.slots.some(s=>s.time==='09:00'));assert.ok(preview.requestedTimes.includes('23:30'));
  assert.ok(!JSON.stringify(preview).includes('roomId'));assert.ok(!preview.requestedTimes.includes('12:00'));
  assert.throws(()=>publicAvailability(f.context,org,{date,serviceIds:['s'],duration:15},now),{status:400});
  f.platform.workSchedules.save(f.token,{staffId:'organization',dates:[date],status:'closed',revision:0,expectedTimeZone:'Europe/Moscow'},f.storage);
  assert.deepEqual(publicDates(f.context,org,'2030-01').dates,['2030-01-02']);
  assert.deepEqual(publicAvailability(f.context,org,{date,serviceIds:['s'],staffId:f.owner.accountId},now).slots,[]);
});
test('public admission checks signed form, consent and current occupancy; replay does not extend reserve and other-time holds nothing',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId,info=publicInfo(f.context,org,now);
  const future=publicInfo(f.context,org,now+5000).challenge;
  assert.throws(()=>publicSubmit(f.context,org,f.input(future),now),{status:400});
  assert.throws(()=>publicSubmit(f.context,org,f.input(info.challenge.slice(0,-1)+(info.challenge.endsWith('0')?'1':'0')),now+2000),{status:400});
  assert.throws(()=>publicSubmit(f.context,org,f.input(info.challenge,{consent:false}),now+2000),{status:400});
  assert.throws(()=>publicSubmit(f.context,org,f.input(info.challenge,{privacyConsentVersion:undefined}),now+2000),{status:409});
  assert.throws(()=>publicSubmit(f.context,org,f.input(info.challenge,{privacyConsentVersion:'obsolete'}),now+2000),{status:409});
  assert.equal(f.platform.bookingRequests.byKey(org,info.challenge,now+2000),null);
  const result=publicSubmit(f.context,org,f.input(info.challenge),now+2000);
  assert.equal(result.status,'pending');assert.deepEqual(Object.keys(result).sort(),['date','duration','expiresAt','status','time']);
  assert.deepEqual(publicSubmit(f.context,org,f.input(info.challenge),now+3000),result);
  assert.deepEqual(f.platform.bookingRequests.byKey(org,info.challenge,now+3000).privacyConsent,
    {granted:true,version:PRIVACY_VERSION,purpose:'booking',at:now+2000});
  const key2=publicInfo(f.context,org,now).challenge;
  assert.throws(()=>publicSubmit(f.context,org,f.input(key2,{phone:'+79990000001'}),now+2000),{status:409});
  const key3=publicInfo(f.context,org,now).challenge;
  const other=publicSubmit(f.context,org,f.input(key3,{phone:'+79990000001',kind:'other-time'}),now+2000);
  assert.equal(other.status,'requested');assert.equal(other.expiresAt,now+2000+86400000);
  assert.equal(f.platform.bookingRequests.reserves(org,date,date,now+2000).length,1);
  assert.equal(f.storage.read().patients.length,1,'public admission does not create clinical cards');
});

test('public other-time request blocks another request until its deadline, then permits a fresh form without creating cards',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId;
  const key=publicInfo(f.context,org,now).challenge;
  const first=publicSubmit(f.context,org,f.input(key,{date:'2030-01-02',kind:'other-time'}),now+2000);
  const deadline=first.expiresAt;
  const next=publicInfo(f.context,org,deadline-1).challenge;
  assert.throws(()=>publicSubmit(f.context,org,f.input(next,{date:'2030-01-02',kind:'other-time',phone:'89990000000'}),deadline-1),{status:409});
  assert.throws(()=>publicSubmit(f.context,org,f.input(next,{date:'2030-01-02',kind:'reserve',phone:'89990000000'}),deadline-1),{status:409});
  const fresh=publicInfo(f.context,org,deadline).challenge;
  const second=publicSubmit(f.context,org,f.input(fresh,{date:'2030-01-02',kind:'other-time',phone:'89990000000'}),deadline);
  assert.equal(second.status,'requested');assert.equal(second.expiresAt,deadline+86400000);
  assert.equal(f.platform.bookingRequests.byKey(org,key,deadline).status,'expired');
  assert.equal(f.platform.bookingRequests.list(org,null,null,deadline).items.length,2);
  assert.equal(f.platform.bookingRequests.reserves(org,'2030-01-02','2030-01-02',deadline).length,0);
  assert.equal(f.storage.read().patients.length,1);
});
test('budgets normalize Russian phone and survive another process; invalid repeated submissions cannot roll back counters',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId;
  for(let i=0;i<3;i++)f.platform.bookingPublicLimits.consume('submit',org,'address-'+i,i%2?'89990000000':'+79990000000',now);
  const other=createPlatformStore(path.join(f.dir,'platform'));
  try {assert.throws(()=>other.bookingPublicLimits.consume('submit',org,'another-address','89990000000',now),{status:429});}
  finally {other.close();}
  f.platform.bookingPublicLimits.consume('submit',org,'another-address','89990000000',now+3600001);
});
test('public request must fit a provider intersection and a single contact cannot hold multiple slots',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId;
  const info=publicInfo(f.context,org,now);publicSubmit(f.context,org,f.input(info.challenge),now+2000);
  const next=publicInfo(f.context,org,now).challenge;
  assert.throws(()=>publicSubmit(f.context,org,f.input(next,{time:'10:00',phone:'89990000000'}),now+2000),{status:409});
  assert.equal(f.platform.bookingRequests.reserves(org,date,date,now+2000).length,1);
  const settings=f.platform.onlineBooking.view(f.token);
  f.platform.onlineBooking.save(f.token,{revision:settings.revision,mode:settings.mode,minimumLeadMinutes:settings.minimumLeadMinutes,reservationMinutes:settings.reservationMinutes,staff:{[f.owner.accountId]:{enabled:false,manageOwnRequests:true}},services:{}},new Set(['s']));
  assert.equal(publicInfo(f.context,org,now).services.length,0);
  const key=publicInfo(f.context,org,now).challenge;
  assert.throws(()=>publicSubmit(f.context,org,f.input(key,{time:'11:00',phone:'+79990000003'}),now+2000),{status:409});
});
test('disabled publication and invalid IP/organization signatures reject previously issued forms',async t=>{
  const f=await fixture(t);f.enable();const org=f.owner.organizationId,key=publicInfo(f.context,org,now).challenge;
  assert.throws(()=>publicSubmit({...f.context,clientAddress:()=> 'another-client'},org,f.input(key),now+2000),{status:400});
  assert.throws(()=>publicSubmit(f.context,org,f.input(key),now+31*60000),{status:400});
  f.platform.bookingPublication.save(f.token,{enabled:false,revision:1});
  assert.throws(()=>publicSubmit(f.context,org,f.input(key),now+2000),{status:404});
  assert.equal(f.platform.bookingRequests.openCount(org),0);
});
test('HTTP anonymous page works without login, API is opt-in and mutation still requires same origin/CSRF',async t=>{
  const f=await fixture(t),server=createMultiServer({dataDir:f.dir,telegramBot:null,supportBot:null,telegramAutostart:false,supportAutostart:false,sendMail:null});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const target=p=>base+p+'?organization='+f.owner.organizationId;
  try {
    const page=await fetch(base+'/booking.html');assert.equal(page.status,200);assert.match(await page.text(),/booking\.js\?v=/);assert.equal(page.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(target('/api/public-booking/info'))).status,404);
    f.enable();const info=await (await fetch(target('/api/public-booking/info'))).json();
    const bad=await fetch(target('/api/public-booking/requests'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.input(info.challenge))});assert.equal(bad.status,403);
    await delay(1100);
    const good=await fetch(target('/api/public-booking/requests'),{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify(f.input(info.challenge))});
    assert.equal(good.status,200);assert.equal((await good.json()).status,'pending');
    assert.equal((await fetch(base+'/api/online-booking/requests')).status,401);
    assert.equal((await fetch(base+'/src/server/modules/booking/public-service.cjs')).status,404);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
