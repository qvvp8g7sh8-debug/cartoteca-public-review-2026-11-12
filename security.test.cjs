const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const OTPAuth=require('otpauth');
const {createServer}=require('./serve.cjs');const {createStore}=require('./auth-store.cjs');const {createBackup,restoreBackup,verifyArchive}=require('./backup.cjs');
const credentials={email:'security@example.test',password:'test-password-with-20-characters'};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
const payload={revision:0,patients:[{id:'p',name:'Private Person',visits:[{id:'v',date:'2026-09-15',photos:[{data:png}]}],appointments:[]}],services:[]};
function folder(t){t.cleanups=[];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-security-'));t.after(async()=>{for(const close of t.cleanups)await close();if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('cartoteca-security-'))fs.rmSync(dir,{recursive:true,force:true});});return dir;}
async function httpFetch(url,options){return new Promise((resolve,reject)=>{const req=require('node:http').request(url,{method:options.method,headers:options.headers},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});}
const cookie=r=>r.headers.get('set-cookie').split(';')[0];
async function httpFixture(t,options={}){const dir=folder(t);const server=createServer({dataDir:dir,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.cleanups.push(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;return {dir,request:(route,body,token='',method=body?'POST':'GET')=>httpFetch(base+route,{method,headers:{Host:options.origin?new URL(options.origin).host:new URL(base).host,Origin:options.origin||base,'X-Cartoteca-Request':'1','Content-Type':'application/json',Cookie:token},body:body?JSON.stringify(body):undefined})};}
test('MFA blocks password-only sessions, prevents code replay, consumes recovery codes and revokes other devices',async t=>{
const f=await httpFixture(t);const first=cookie(await f.request('/api/auth/setup',credentials));const second=cookie(await f.request('/api/auth/login',credentials));
const preparation=await f.request('/api/security/mfa/prepare',{password:credentials.password},first);assert.equal(preparation.status,200);const {secret,qr}=await preparation.json();assert.match(qr,/^data:image\/png/);
const code=new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate();const enable=await f.request('/api/security/mfa/enable',{code},first);assert.equal(enable.status,200);const {codes}=await enable.json();assert.equal(codes.length,10);
assert.equal((await f.request('/api/cabinet',undefined,second)).status,401);
const login=await f.request('/api/auth/login',credentials);assert.equal((await login.clone().json()).requiresMfa,true);const pending=cookie(login);assert.equal((await f.request('/api/cabinet',undefined,pending)).status,401);
assert.equal((await f.request('/api/auth/verify',{code},pending)).status,400);
const verified=await f.request('/api/auth/verify',{code:codes[0]},pending);assert.equal(verified.status,200);const third=cookie(verified);assert.notEqual(third,pending);assert.equal((await f.request('/api/cabinet',undefined,pending)).status,401);assert.equal((await f.request('/api/cabinet',undefined,third)).status,200);
const pending2=cookie(await f.request('/api/auth/login',credentials));assert.equal((await f.request('/api/auth/verify',{code:codes[0]},pending2)).status,400);
assert.equal((await f.request('/api/security/revoke',{id:'others'},first)).status,200);assert.equal((await f.request('/api/cabinet',undefined,third)).status,401);
assert.equal((await f.request('/api/security/mfa/disable',{password:credentials.password,code:'bad'},first)).status,400);
assert.equal((await f.request('/api/security/mfa/disable',{password:credentials.password,code:codes[1]},first)).status,200);
assert.equal((await (await f.request('/api/security',undefined,first)).json()).mfa,false);
});
test('recovery email uses trusted origin, single-use token, password reset revokes every session',async t=>{
let sent;const f=await httpFixture(t,{origin:'https://cabinet.example.test',sendMail:async(to,url)=>{sent={to,url};}});const first=cookie(await f.request('/api/auth/setup',credentials));
const result=await f.request('/api/auth/forgot',{email:credentials.email});assert.equal(result.status,200);assert.equal(sent.to,credentials.email);assert.match(sent.url,/^https:\/\/cabinet.example.test\/#reset=/);const token=new URL(sent.url).hash.slice(7);
assert.equal((await f.request('/api/auth/reset',{token:'wrong',password:'new-long-password-2026'})).status,400);
assert.equal((await f.request('/api/auth/reset',{token,password:'new-long-password-2026'})).status,200);assert.equal((await f.request('/api/cabinet',undefined,first)).status,401);
assert.equal((await f.request('/api/auth/reset',{token,password:'another-long-password-2026'})).status,400);assert.equal((await f.request('/api/auth/login',credentials)).status,401);
const login=await f.request('/api/auth/login',{...credentials,password:'new-long-password-2026'});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/Secure/);
assert.equal((await f.request('/api/auth/forgot',{email:'unknown@example.test'})).status,200);
});
test('recovery cannot bypass enabled MFA and expired links fail',async t=>{
const dir=folder(t);const store=createStore(dir);t.cleanups.push(()=>store.close());const token=await store.setup(credentials.email,credentials.password,'ip');const {secret}=await store.prepareMfa(token,{password:credentials.password});const {codes}=store.enableMfa(token,new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate());let reset;
await store.requestReset(credentials.email,async(to,url)=>reset=new URL(url).hash.slice(7),'https://test.example','a');
await assert.rejects(store.resetPassword({token:reset,password:'replacement-password-2026'},'b'),{status:400});
await store.resetPassword({token:reset,password:'replacement-password-2026',code:codes[0]},'b');assert.equal(store.session(token),false);
const pending=await store.login(credentials.email,'replacement-password-2026','c');assert.equal(store.session(pending),false);
await store.requestReset(credentials.email,async(to,url)=>reset=new URL(url).hash.slice(7),'https://test.example','d');store.storage.set('reset',{...store.storage.get('reset'),expires:0});await assert.rejects(store.resetPassword({token:reset,password:'replacement-password-2027',code:codes[1]},'e'),{status:400});
});
test('encrypted archive restores database and photographs, invalid key/corruption rejected without overwriting',async t=>{
const root=folder(t);const store=createStore(path.join(root,'data'));t.cleanups.push(()=>store.close());const token=await store.setup(credentials.email,credentials.password,'ip');const saved=store.write(payload);const archive=await createBackup(store.storage,path.join(root,'backups'),path.join(root,'backup.key'));assert.equal(await verifyArchive(archive,path.join(root,'backup.key')),true);
assert.equal(fs.readFileSync(archive).includes(Buffer.from('Private Person')),false);assert.equal(fs.readFileSync(store.storage.filename).includes(Buffer.from('Private Person')),false);
const restored=path.join(root,'restored');assert.deepEqual(await restoreBackup(archive,path.join(root,'backup.key'),restored),{patients:1,photos:1});const copy=createStore(restored);try{assert.equal(copy.session(token),false);assert.deepEqual(copy.read().patients,saved.patients);assert.deepEqual(copy.photo(saved.patients[0].visits[0].photos[0].data.split('/').pop()).buffer,Buffer.from(png.split(',')[1],'base64'));assert.equal(copy.session(await copy.login(credentials.email,credentials.password,'ip2')),true);}finally{copy.close();}
await assert.rejects(restoreBackup(archive,path.join(root,'backup.key'),restored));
const bad=path.join(root,'bad.enc');const bytes=fs.readFileSync(archive);bytes[40]^=1;fs.writeFileSync(bad,bytes);const rejected=path.join(root,'rejected');await assert.rejects(restoreBackup(bad,path.join(root,'backup.key'),rejected));assert.equal(fs.existsSync(rejected),false);
fs.writeFileSync(path.join(root,'wrong.key'),Buffer.alloc(32));await assert.rejects(verifyArchive(archive,path.join(root,'wrong.key')));
});
test('photo export is portable, inactive photos inaccessible, unsupported uploads do not change data',async t=>{
const f=await httpFixture(t);const token=cookie(await f.request('/api/auth/setup',credentials));assert.equal((await f.request('/api/cabinet',payload,token,'PUT')).status,200);const state=await(await f.request('/api/cabinet',undefined,token)).json();const photo=state.patients[0].visits[0].photos[0].data;
assert.equal((await(await f.request('/api/export',undefined,token)).json()).patients[0].visits[0].photos[0].data,png);
const invalid=structuredClone(state);invalid.patients[0].visits[0].photos[0].data='data:image/svg+xml;base64,PHN2Zz4=';assert.equal((await f.request('/api/cabinet',invalid,token,'PUT')).status,400);assert.equal((await f.request(photo,undefined,token)).status,200);
assert.equal((await f.request('/api/cabinet',{revision:1,patients:[],services:[]},token,'PUT')).status,200);assert.equal((await f.request(photo,undefined,token)).status,404);
for(const route of ['/data/encryption.key','/data/cabinet.sqlite','/backups/backup.key','/storage.cjs'])assert.equal((await f.request(route,undefined,token)).status,404);
});
test('legacy migration preserves owner password and photos and retires plaintext only after verification',async t=>{
const root=folder(t);const source=createStore(path.join(root,'source'));await source.setup(credentials.email,credentials.password,'ip');const owner=source.storage.get('owner');source.close();const dir=path.join(root,'legacy');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'cabinet.json'),JSON.stringify({...payload,owner,initialized:true}));const migrated=createStore(dir);try{assert.equal(migrated.read().patients[0].name,'Private Person');assert.equal(migrated.session(await migrated.login(credentials.email,credentials.password,'ip')),true);assert.equal(fs.existsSync(path.join(dir,'cabinet.json')),false);assert.equal(fs.existsSync(path.join(dir,'migration-original.enc')),true);}finally{migrated.close();}
});
test('production startup refuses HTTP and unclaimed cabinets; recovery explicitly unavailable without mail',async t=>{
const root=folder(t);assert.throws(()=>createServer({dataDir:path.join(root,'prod'),production:true,origin:'https://safe.example'}));const f=await httpFixture(t);assert.equal((await f.request('/api/auth/forgot',{email:credentials.email})).status,503);
});
test('failed backup closes output, removes partial archive, reports failure and can retry',async t=>{
const root=folder(t);const store=createStore(path.join(root,'data'));t.cleanups.push(()=>store.close());await store.setup(credentials.email,credentials.password,'ip');const saved=store.write(payload);const id=saved.patients[0].visits[0].photos[0].data.split('/').pop();const file=path.join(store.storage.photoDir,id+'.enc');const bytes=fs.readFileSync(file);fs.unlinkSync(file);
const backups=path.join(root,'backups'),key=path.join(root,'backup.key');await assert.rejects(createBackup(store.storage,backups,key));assert.equal(store.storage.get('backupStatus').ok,false);assert.equal(fs.readdirSync(backups).length,0);fs.writeFileSync(file,bytes);await createBackup(store.storage,backups,key);assert.equal(store.storage.get('backupStatus').ok,true);
});
