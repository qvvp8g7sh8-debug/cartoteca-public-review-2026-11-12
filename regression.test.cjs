const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const OTPAuth=require('otpauth'),sharp=require('sharp');
const {createStore}=require('./auth-store.cjs'),{createServer}=require('./serve.cjs');
const {createBackup,restoreBackup}=require('./backup.cjs');
const credentials={email:'regression@example.test',password:'Regression-password-2026!'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-regression-'));const store=createStore(path.join(root,'data'));t.after(()=>{store.close();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('cartoteca-regression-'))fs.rmSync(root,{recursive:true,force:true})});return {root,store};}
const valid=()=>({revision:0,patients:[{id:'p',name:'Test',visits:[{id:'v',date:'2026-09-15',photos:[]}],appointments:[{id:'a',date:'2026-09-15',time:'10:15',duration:90}]}],services:[{id:'s',name:'Service',duration:'60 минут',price:1000}]});
const photoState=data=>{const s=valid();s.patients[0].visits[0].photos=[{data}];return s};
const image=async format=>'data:image/'+format+';base64,'+(await sharp({create:{width:8,height:6,channels:3,background:'#abc'}}).toFormat(format).toBuffer()).toString('base64');

test('in-flight password login cannot bypass concurrent MFA activation',async t=>{
 const {store}=fixture(t),token=await store.setup(credentials.email,credentials.password,'owner');
 const {secret}=await store.prepareMfa(token,{password:credentials.password});
 const login=store.login(credentials.email,credentials.password,'attacker');
 store.enableMfa(token,new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate());
 await assert.rejects(login,{status:401});
 const pending=await store.login(credentials.email,credentials.password,'new');assert.equal(store.session(pending),false);assert.equal(store.security(token).mfa,true);
});
test('in-flight reauthentication and login fail when session is revoked or password changes',async t=>{
 const {store}=fixture(t),token=await store.setup(credentials.email,credentials.password,'owner');
 const pending=store.prepareMfa(token,{password:credentials.password});store.logout(token);await assert.rejects(pending,{status:401});assert.equal(store.storage.get('mfaPending'),null);
 const current=await store.login(credentials.email,credentials.password,'owner');
 const login=store.login(credentials.email,credentials.password,'other');store.revoke(current,'others');await assert.rejects(login,{status:401});
 const check=store.login(credentials.email,credentials.password,'another');store.storage.set('owner',{...store.storage.get('owner'),passwordHash:'00'.repeat(64)});await assert.rejects(check,{status:401});
});
test('concurrent password changes commit only once and revoke all devices',async t=>{
 const {store}=fixture(t),token=await store.setup(credentials.email,credentials.password,'owner');
 const results=await Promise.allSettled(['New-password-one-2026!','New-password-two-2026!'].map(newPassword=>store.changePassword(token,{password:credentials.password,newPassword})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,401);assert.equal(store.session(token),false);
});
test('slow cabinet PUT cannot commit after logout or revocation by another device',async t=>{
 for(const action of ['logout','revoke']){
  const {root}=fixture(t);const server=createServer({dataDir:path.join(root,'http'),sendMail:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
   const base='http://127.0.0.1:'+server.address().port;
   const request=(route,body,cookie='',method='POST')=>fetch(base+route,{method,headers:{Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
   const cookie=r=>r.headers.get('set-cookie').split(';')[0];const first=cookie(await request('/api/auth/setup',credentials));const second=cookie(await request('/api/auth/login',credentials));
   let seen;const arrived=new Promise(r=>seen=r);server.on('request',req=>{if(req.method==='PUT')seen()});
   let finish;const result=new Promise(r=>finish=r);
   const slow=http.request(base+'/api/cabinet',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1',Cookie:first}},res=>{res.resume();res.on('end',()=>finish(res.statusCode))});
   slow.write('{"revision":0,');await arrived;
   if(action==='logout')await request('/api/auth/logout',{},first);else await request('/api/security/revoke',{id:'others'},second);
   slow.end('"patients":[],"services":[]}');assert.equal(await result,401);
   const saved=await(await request('/api/cabinet',undefined,second,'GET')).json();assert.equal(saved.revision,0);assert.equal(saved.initialized,false);
  } finally {await new Promise(r=>server.close(r));}
 }
});
test('photo decoding rechecks authorization before commit and leaves no files',async t=>{
 const {store}=fixture(t),token=await store.setup(credentials.email,credentials.password,'owner');const state=photoState(await image('png'));
 const saving=store.storage.writeAsync(state,()=>{if(!store.session(token))throw Object.assign(Error(),{status:401})});store.logout(token);
 await assert.rejects(saving,{status:401});assert.equal(store.read().revision,0);assert.equal(fs.readdirSync(store.storage.photoDir).length,0);
});
test('late failed reset email cannot invalidate a newer successfully delivered token',async t=>{
 const {store}=fixture(t);await store.setup(credentials.email,credentials.password,'owner');
 let rejectOld,secondToken;const first=store.requestReset(credentials.email,()=>new Promise((_,r)=>rejectOld=r),'https://example.test','first');
 const expected=assert.rejects(first,{status:503});
 await store.requestReset(credentials.email,async(_,url)=>secondToken=new URL(url).hash.slice(7),'https://example.test','second');
 rejectOld(Error('SMTP test failure'));await expected;
 await store.resetPassword({token:secondToken,password:'Replacement-password-2026!'},'confirm');
 assert.equal(store.session(await store.login(credentials.email,'Replacement-password-2026!','login')),true);
});
test('invalid nested records, dates, types, duplicates and limits are rejected atomically',t=>{
 const {store}=fixture(t);const saved=store.write(valid());
 const bad=[
  s=>s.patients[0].appointments=[null],s=>s.patients[0].visits=[null],
  s=>s.patients[0].appointments[0].date='2026-02-30',s=>s.patients[0].visits[0].date='bad',s=>s.patients[0].birth='2026-13-01',
  s=>s.patients[0].appointments[0].time='24:00',s=>s.patients[0].appointments[0].time='10:03',
  s=>s.patients[0].appointments[0].duration=16,s=>s.patients[0].appointments[0].duration='60',
  s=>s.patients[0].appointments.push(s.patients[0].appointments[0]),s=>s.patients[0].visits.push(s.patients[0].visits[0]),
  s=>s.services[0].price='" data-injected="yes',s=>s.services[0].price=-1,s=>s.services[0].price=Infinity,
  s=>s.services[0].duration='16 минут',s=>s.services[0].duration='many',s=>s.patients[0].name='',s=>s.patients[0].notes='x'.repeat(20001),
  s=>s.patients[0].visits[0].photos=Array(7).fill({data:'bad'}),s=>s.patients[0].appointments=Array(10001).fill({id:'a'}),
  s=>s.patients[0].visits[0].notes={},s=>s.services[0].product=[],s=>s.patients[0].visits[0].photos=[null],
  s=>s.patients[0].custom=JSON.parse('{"__proto__":{}}'),s=>s.revision=-1
 ];
 for(const mutate of bad){const s=structuredClone(saved);mutate(s);assert.throws(()=>store.write(s),{status:400});assert.deepEqual(store.read().patients,saved.patients);assert.equal(store.read().revision,1);assert.equal(fs.readdirSync(store.storage.photoDir).length,0);}
 const historical=structuredClone(saved);historical.patients[0].visits[0].legacyField={note:'preserved'};delete historical.patients[0].appointments[0].duration;delete historical.services[0].duration;
 const good=store.write(historical);assert.deepEqual(good.patients[0].visits[0].legacyField,{note:'preserved'});
});
test('real JPEG PNG WebP decode, resize and export/import preserve usable pixels',async t=>{
 const {store}=fixture(t);
 for(const format of ['jpeg','png','webp']){
  const payload=photoState(await image(format));payload.revision=store.read().revision;
  const result=await store.storage.writeAsync(payload);const ref=result.patients[0].visits[0].photos[0].data;
  const file=store.photo(ref.split('/').pop());const meta=await sharp(file.buffer).metadata();assert.equal(meta.format,format);assert.equal(meta.width,8);assert.equal(meta.height,6);
  await sharp(file.buffer).raw().toBuffer();
  result.patients[0].visits[0].photos[0].data='data:'+file.mime+';base64,'+file.buffer.toString('base64');const imported=store.write(result);assert.equal(imported.patients.length,1);
 }
 const large=await sharp({create:{width:2000,height:1000,channels:3,background:'#fff'}}).jpeg().toBuffer();const payload=photoState('data:image/jpeg;base64,'+large.toString('base64'));payload.revision=store.read().revision;
 const saved=store.write(payload);const meta=await sharp(store.photo(saved.patients[0].visits[0].photos[0].data.split('/').pop()).buffer).metadata();assert.equal(meta.width,1600);assert.equal(meta.height,800);
});
test('truncated signatures, incomplete bodies, MIME mismatch, huge dimensions and SVG fail without mutation',async t=>{
 const {store}=fixture(t),good=await image('png');
 const huge=await sharp({create:{width:6500,height:6500,channels:3,background:'#fff'}}).png().toBuffer();
 const bad=['data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),'data:image/jpeg;base64,/9j/','data:image/webp;base64,'+Buffer.from('RIFF0000WEBP').toString('base64'),good.replace('image/png','image/jpeg'),'data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,'+huge.toString('base64'),'data:image/png;base64,'+Buffer.from(good.split(',')[1],'base64').subarray(0,40).toString('base64')];
 for(const data of bad){await assert.rejects(store.storage.writeAsync(photoState(data)),{status:400});assert.equal(store.read().revision,0);assert.equal(fs.readdirSync(store.storage.photoDir).length,0);}
});
test('verified backups remove only old inactive photos, retain 14 archives and remain restorable',async t=>{
 const {store,root}=fixture(t);let s=store.write(photoState(await image('png')));const old=s.patients[0].visits[0].photos[0].data.split('/').pop();
 s.patients[0].visits[0].photos=[];store.write(s);const orphan=path.join(store.storage.photoDir,old+'.enc');assert.equal(fs.existsSync(orphan),true);
 const dir=path.join(root,'backups'),key=path.join(root,'backup.key');
 // Failure must retain inactive files and existing archives.
 fs.writeFileSync(key,Buffer.alloc(1));await assert.rejects(createBackup(store.storage,dir,key));assert.equal(fs.existsSync(orphan),true);fs.unlinkSync(key);
 let latest;for(let i=0;i<15;i++)latest=await createBackup(store.storage,dir,key);
 assert.equal(fs.existsSync(orphan),false);assert.equal(fs.readdirSync(dir).filter(x=>x.endsWith('.enc')).length,14);
 await restoreBackup(latest,key,path.join(root,'restored'));
});
test('backup photo manifest comes from SQLite snapshot despite a concurrent live deletion',async t=>{
 const {store,root}=fixture(t);const state=store.write(photoState(await image('png')));
 const db=store.storage.db,original=db.exec.bind(db);let changed=false;
 db.exec=sql=>{const result=original(sql);if(sql.startsWith('VACUUM INTO')&&!changed){changed=true;const next=structuredClone(state);next.patients[0].visits[0].photos=[];store.write(next)}return result};
 const key=path.join(root,'backup.key'),archive=await createBackup(store.storage,path.join(root,'backups'),key);db.exec=original;
 assert.deepEqual(await restoreBackup(archive,key,path.join(root,'restored')),{patients:1,photos:1});
 const id=state.patients[0].visits[0].photos[0].data.split('/').pop();assert.equal(fs.existsSync(path.join(store.storage.photoDir,id+'.enc')),true);
});
test('photo decode rollback and stale async save preserve the last committed cabinet',async t=>{
 const {store}=fixture(t);const url=await image('png'),bad=photoState(url);
 bad.patients[0].visits[0].photos.push({data:'data:image/png;base64,iVBORw0KGgo='});
 assert.throws(()=>store.write(bad),{status:400});assert.equal(fs.readdirSync(store.storage.photoDir).length,0);assert.equal(store.read().revision,0);
 const delayed=store.storage.writeAsync(photoState(url));const expected=assert.rejects(delayed,{status:409});
 const winner=store.write(valid());await expected;assert.deepEqual(store.read().patients,winner.patients);assert.equal(fs.readdirSync(store.storage.photoDir).length,0);
});
test('corrupt active photograph prevents backup cleanup and retains orphan and prior archives',async t=>{
 const {store,root}=fixture(t),url=await image('png');let state=store.write(photoState(url));
 const old=state.patients[0].visits[0].photos[0].data.split('/').pop();state.patients[0].visits[0].photos[0].data=url;state=store.write(state);
 const active=state.patients[0].visits[0].photos[0].data.split('/').pop(),activeFile=path.join(store.storage.photoDir,active+'.enc');
 const bytes=fs.readFileSync(activeFile);bytes[bytes.length-1]^=1;fs.writeFileSync(activeFile,bytes);
 const dir=path.join(root,'backups'),key=path.join(root,'backup.key');await assert.rejects(createBackup(store.storage,dir,key));
 assert.equal(fs.existsSync(path.join(store.storage.photoDir,old+'.enc')),true);assert.equal(fs.readdirSync(dir).length,0);assert.equal(store.storage.get('backupStatus').ok,false);
});
