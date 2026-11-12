const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{fork}=require('node:child_process');
const {createPlatformDatabase}=require('../src/server/infrastructure/platform-database.cjs');
const {createPublicAuthLimits}=require('../src/server/modules/auth/public-limits.cjs');
const constants=require('../src/server/infrastructure/platform-constants.cjs'),{fail}=require('../src/shared/errors.cjs');
const {createPlatformStore}=require('../platform-store.cjs'),{createMultiServer}=require('../multi-server.cjs');
const {PRIVACY_VERSION}=require('../src/shared/privacy-consent.cjs');
const password='Synthetic-public-request-password-2026';
function directory(t,close=()=>{}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-public-limits-'));t.after(async()=>{await close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('cartoteca-public-limits-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
function budgets(directory,clock){const database=createPlatformDatabase(directory);return {...createPublicAuthLimits({...database,...constants,fail,now:clock}),database,close:()=>database.db.close()};}
test('public email/IP budgets are atomic, persistent, pseudonymous and expire without touching login failures',t=>{
  let store,time=2000000000000;const dir=directory(t,()=>store?.close());store=budgets(dir,()=>time);
  store.database.db.prepare('INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)').run('preserved-login-key',5,time,time+900000);
  store.consumePublicAuthRequest('forgot','OWNER@example.test','synthetic-ip');
  const before=store.database.db.prepare('SELECT * FROM login_limits ORDER BY key').all();
  assert.throws(()=>store.consumePublicAuthRequest('forgot','owner@example.test','different-ip'),e=>e.status===429&&e.retryAfter===60);
  assert.deepEqual(store.database.db.prepare('SELECT * FROM login_limits ORDER BY key').all(),before);
  assert.equal(JSON.stringify(before).includes('owner@example.test'),false);assert.equal(JSON.stringify(before).includes('synthetic-ip'),false);
  store.close();store=budgets(dir,()=>time);
  assert.throws(()=>store.consumePublicAuthRequest('forgot','owner@example.test','third-ip'),{status:429});
  time+=60000;store.consumePublicAuthRequest('forgot','owner@example.test','third-ip');time+=60000;store.consumePublicAuthRequest('forgot','owner@example.test','fourth-ip');time+=60000;
  assert.throws(()=>store.consumePublicAuthRequest('forgot','owner@example.test','fifth-ip'),e=>e.status===429&&e.retryAfter===3420);
  time+=3600000;store.consumePublicAuthRequest('forgot','owner@example.test','fifth-ip');
  assert.equal(store.database.db.prepare('SELECT failures FROM login_limits WHERE key=?').get('preserved-login-key').failures,5);
});
test('new-email rotation cannot bypass the IP or global registration quota',t=>{
  let store;const dir=directory(t,()=>store?.close());store=budgets(dir,()=>2000000000000);
  for(let i=0;i<10;i++)store.consumePublicAuthRequest('register','first-'+i+'@example.test','one-ip');
  assert.throws(()=>store.consumePublicAuthRequest('register','overflow@example.test','one-ip'),{status:429});
  for(let i=10;i<100;i++)store.consumePublicAuthRequest('register','rotated-'+i+'@example.test','ip-'+i);
  assert.throws(()=>store.consumePublicAuthRequest('register','site-overflow@example.test','unused-ip'),{status:429});
});
test('daily registration quota persists across hourly resets and rotating IPs',t=>{
  let store,time=2000000000000;const dir=directory(t,()=>store?.close());store=budgets(dir,()=>time);
  for(let hour=0;hour<5;hour++){for(let i=0;i<100;i++)store.consumePublicAuthRequest('register',`daily-${hour}-${i}@example.test`,`daily-ip-${hour}-${i}`);time+=3600000;}
  assert.throws(()=>store.consumePublicAuthRequest('register','daily-overflow@example.test','new-ip'),{status:429});time+=24*3600000;
  store.consumePublicAuthRequest('register','after-expiry@example.test','new-ip');
});
function worker(dir,count,prefix){return new Promise((resolve,reject)=>{
  const child=fork(path.join(__dirname,'fixtures/public-auth-worker.cjs'),[dir,String(count),prefix],{stdio:['ignore','ignore','ignore','ipc']});let result,diagnostic,spawnError;
  child.on('message',packet=>{if(packet?.kind==='diagnostic')diagnostic=packet.failures;else if(Number.isSafeInteger(packet?.allowed)&&Number.isSafeInteger(packet?.blocked)&&packet.allowed>=0&&packet.blocked>=0&&packet.allowed+packet.blocked===count)result={allowed:packet.allowed,blocked:packet.blocked};});
  child.once('error',error=>{spawnError={name:/^[A-Za-z_]{1,40}$/.test(error.name)?error.name:null,code:/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:null};});
  child.once('close',(code,signal)=>{if(code===0&&!signal&&!spawnError&&result&&!diagnostic)return resolve(result);reject(Error('Synthetic limiter worker failed '+JSON.stringify({exitCode:code,signal,spawnError,diagnostic:diagnostic||null})));});
});}
test('independent processes share a single registration request allowance',async t=>{
  const dir=directory(t),platform=createPlatformStore(dir);platform.close();
  const settled=await Promise.allSettled([worker(dir,8,'one'),worker(dir,8,'two')]);assert.ok(settled.every(r=>r.status==='fulfilled'),JSON.stringify(settled.filter(r=>r.status==='rejected').map(r=>r.reason.message)));const results=settled.map(r=>r.value);assert.equal(results.reduce((n,r)=>n+r.allowed,0),10);assert.equal(results.reduce((n,r)=>n+r.blocked,0),6);
});
async function httpFixture(t){
  let server;const dir=directory(t,()=>server?new Promise(r=>server.close(r)):undefined),platform=createPlatformStore(path.join(dir,'platform'));
  const owner=await platform.registerOwner({email:'owner@example.test',password,displayName:'Synthetic owner',organizationName:'Synthetic clinic'});platform.verifyEmail(owner.verificationToken);platform.close();
  const outbox=[];server=createMultiServer({dataDir:dir,telegramBot:null,telegramAutostart:false,sendMail:async(email,url,meta)=>outbox.push({email,url,...meta})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  async function request(route,body){if(body&&route==='/api/auth/register')body={privacyConsent:true,privacyConsentVersion:PRIVACY_VERSION,...body};const res=await fetch(base+route,{method:'POST',headers:{Origin:base,'X-Cartoteca-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,data:await res.json(),retry:res.headers.get('retry-after')};}
  return {dir,request,outbox,base};
}
test('HTTP recovery throttles known and unknown emails alike and rejects without extra mail or tokens',async t=>{
  const f=await httpFixture(t);
  assert.equal((await f.request('/api/auth/forgot',{email:'owner@example.test'})).status,200);
  const message=f.outbox[0],token=decodeURIComponent(new URL(message.url).hash.split('=')[1]);
  const known=await f.request('/api/auth/forgot',{email:'OWNER@example.test'});assert.equal(known.status,429);assert.ok(Number(known.retry)>0&&Number(known.retry)<=60);
  assert.equal((await f.request('/api/auth/forgot',{email:'unknown@example.test'})).status,200);
  const unknown=await f.request('/api/auth/forgot',{email:'unknown@example.test'});assert.equal(unknown.status,429);assert.equal(f.outbox.length,1);
  assert.equal((await f.request('/api/auth/reset',{token,password:'Replacement-synthetic-password'})).status,200);assert.equal((await f.request('/api/auth/reset',{token,password})).status,400);
});
test('unverified HTTP registrations allocate no tenant database; quotas block before creating accounts',async t=>{
  const f=await httpFixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.request('/api/auth/register',{email:'new-'+i+'@example.test',password,displayName:'Synthetic '+i,organizationName:'Synthetic '+i})).status,201);
  const denied=await f.request('/api/auth/register',{email:'eleventh@example.test',password,displayName:'Synthetic',organizationName:'Synthetic'});assert.equal(denied.status,429);
  assert.equal(fs.existsSync(path.join(f.dir,'tenants')),false);assert.equal(f.outbox.length,10);
  assert.equal(require('./helpers/platform-inspection.cjs').platformInspection(path.join(f.dir,'platform')).accounts.length,11);
  assert.equal((await f.request('/api/auth/login',{email:'new-0@example.test',password})).status,403);
  const token=decodeURIComponent(new URL(f.outbox[0].url).hash.split('=')[1]);assert.equal((await f.request('/api/auth/verify-email',{token})).status,200);
  assert.equal((await f.request('/api/auth/login',{email:'new-0@example.test',password})).status,200);
});
test('later recovery requests preserve delivered links and one successful reset consumes every outstanding link',async t=>{
  let store;const dir=directory(t,()=>store?.close());store=createPlatformStore(dir);
  const owner=await store.registerOwner({email:'owner@example.test',password,displayName:'Synthetic',organizationName:'Synthetic'});store.verifyEmail(owner.verificationToken);
  const first=store.requestPasswordReset('owner@example.test'),second=store.requestPasswordReset('owner@example.test');
  await store.resetPassword(first,'Changed-synthetic-password');await assert.rejects(store.resetPassword(second,password),{status:400});
  const third=store.requestPasswordReset('owner@example.test'),fourth=store.requestPasswordReset('owner@example.test');
  const results=await Promise.allSettled([store.resetPassword(third,password),store.resetPassword(fourth,'Other-synthetic-password')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
