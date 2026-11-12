const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createPlatformStore}=require('../platform-store.cjs');
const {createMultiServer}=require('../multi-server.cjs');
const {createAuthentication}=require('../src/server/modules/auth/authentication.cjs');
const {createBilling}=require('../src/server/modules/billing/service.cjs');
const {createNotifications}=require('../src/server/modules/notifications/service.cjs');
const {validateReservation}=require('../src/server/modules/booking/policy.cjs');
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-v2-security-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('legacy backup refuses a platform directory without creating a misleading empty cabinet',t=>{
  const dir=directory(t),platformDir=path.join(dir,'platform'),backups=path.join(dir,'backups');
  fs.mkdirSync(platformDir);fs.writeFileSync(path.join(platformDir,'platform.sqlite'),'sentinel');
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../backup-cli.cjs'),'create','--data',dir,'--backups',backups],{encoding:'utf8'});
  assert.equal(result.status,1);
  assert.equal(fs.existsSync(path.join(dir,'cabinet.sqlite')),false);
  assert.equal(fs.existsSync(path.join(dir,'encryption.key')),false);
  assert.equal(fs.existsSync(backups),false);
  assert.equal(fs.readFileSync(path.join(platformDir,'platform.sqlite'),'utf8'),'sentinel');
});
test('authentication rejects account changes while password verification is in flight',async()=>{
  let resume;const pending=new Promise(resolve=>resume=resolve);
  let account={row:{id:'one',status:'active'},value:{salt:'same',passwordHash:'same'}};
  const auth=createAuthentication({accountByEmail:()=>account,normalizeEmail:x=>x,verifyPassword:()=>pending,publicAccount:()=>({id:'one'}),memberships:()=>[],fail:(status,message)=>Object.assign(Error(message),{status})});
  const login=auth.authenticate('test@example.test','dummy');
  account={row:{id:'one',status:'suspended'},value:{salt:'same',passwordHash:'same'}};resume(true);
  await assert.rejects(login,{status:401});
});
test('two concurrent password resets consume one token only',async t=>{
  const dir=directory(t),store=createPlatformStore(dir);
  try{
    const account=await store.registerOwner({email:'owner@example.test',password:'Original-owner-password',displayName:'Test',organizationName:'Test'});store.verifyEmail(account.verificationToken);
    const token=store.requestPasswordReset('owner@example.test');
    const result=await Promise.allSettled([store.resetPassword(token,'Replacement-password-one'),store.resetPassword(token,'Replacement-password-two')]);
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(result.filter(x=>x.status==='rejected'&&x.reason.status===400).length,1);
  }finally{store.close();}
});
test('two concurrent bootstrap calls cannot create two global administrators',async t=>{
  const dir=directory(t),store=createPlatformStore(dir);
  try{
    const result=await Promise.allSettled([store.bootstrapGlobalAdmin({email:'a@example.test',password:'Administrator-password-one',displayName:'A'}),store.bootstrapGlobalAdmin({email:'b@example.test',password:'Administrator-password-two',displayName:'B'})]);
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(store.adminOverview(result.find(x=>x.status==='fulfilled').value.accountId).accountsTotal,1);
  }finally{store.close();}
});
test('HTTP v2 prevents photo-limit bypass and denies clinical data to global administrator',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-v2-http-'));
  const platform=createPlatformStore(path.join(dir,'platform'));
  const owner=await platform.registerOwner({email:'owner@example.test',password:'Owner-test-password-2026',displayName:'Owner',organizationName:'Clinic'});platform.verifyEmail(owner.verificationToken);
  await platform.bootstrapGlobalAdmin({email:'admin@example.test',password:'Admin-test-password-2026',displayName:'Admin'});platform.close();
  const server=createMultiServer({dataDir:dir,sendMail:null});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const contexts=new Map();
  async function request(route,body,cookie='',method=body?'POST':'GET') {
    const response=await fetch(base+route,{method,headers:{Origin:base,'X-Cartoteca-Request':'1','Content-Type':'application/json',Cookie:cookie,...contexts.get(cookie)},body:body?JSON.stringify(body):undefined});
    if(route==='/api/auth/login'&&response.ok) {
      const login=await response.clone().json(),issued=response.headers.get('set-cookie')?.split(';')[0];
      if(login.user&&issued) contexts.set(issued,{'X-Cartoteca-Account-Id':login.user.id,'X-Cartoteca-Organization-Id':login.organizationId||''});
    }
    return response;
  }
  const login=await request('/api/auth/login',{email:'owner@example.test',password:'Owner-test-password-2026'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
  const visits=Array.from({length:9},(_,i)=>({id:'v'+i,date:'2026-10-03',procedure:'Test',photos:Array.from({length:i===8?3:6},()=>({data}))}));
  const denied=await request('/api/cabinet',{revision:0,patients:[{id:'p',name:'Test',visits,appointments:[]}],services:[]},cookie,'PUT');assert.equal(denied.status,402);
  const unchanged=await request('/api/cabinet',null,cookie);assert.equal((await unchanged.json()).revision,0);
  const admin=await request('/api/auth/login',{email:'admin@example.test',password:'Admin-test-password-2026'}),adminCookie=admin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/cabinet',null,adminCookie)).status,403);assert.equal((await request('/api/admin/overview',null,cookie)).status,403);
  assert.equal((await request('/api/admin/overview',null,adminCookie)).status,200);
  assert.equal((await fetch(base+'/.env.local')).status,404);
  assert.equal((await fetch(base+'/app.js')).status,401);
});
test('production refuses insecure origin before creating a database',t=>{
  const dir=directory(t),target=path.join(dir,'not-created');
  assert.throws(()=>createMultiServer({dataDir:target,production:true,origin:'http://example.test',sendMail:null}),/HTTPS/);assert.equal(fs.existsSync(target),false);
});
test('unconfigured integrations fail explicitly and reservation defaults to thirty minutes',async()=>{
  await assert.rejects(createBilling().startCheckout({organizationId:'o',amountKopecks:10000,idempotencyKey:'i'}),{status:503});
  await assert.rejects(createNotifications().enqueue({organizationId:'o',channel:'telegram',recipient:'r',template:'reminder',idempotencyKey:'i'}),{status:503});
  const now=Date.parse('2030-01-01T00:00:00Z'),reservation=validateReservation({organizationId:'o',staffId:'s',startsAt:'2030-01-01T12:00:00Z',durationMinutes:90},now);
  assert.equal(reservation.expiresAt,'2030-01-01T00:30:00.000Z');assert.equal(reservation.endsAt,'2030-01-01T13:30:00.000Z');
});
