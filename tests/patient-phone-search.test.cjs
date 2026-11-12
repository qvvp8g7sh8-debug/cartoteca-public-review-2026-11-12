const { assetPath } = require('./helpers/interface-assets.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {JSDOM,VirtualConsole}=require('jsdom');
const {patientMatchesSearch,normalizePatientSearchQuery,createPatientNames}=require('../src/shared/patient-names.cjs');
const {directoryPage}=require('../src/server/modules/cabinet/directory.cjs');
const {createStorage}=require('../storage.cjs'),{createPlatformStore}=require('../platform-store.cjs'),{createMultiServer}=require('../multi-server.cjs');
const root=path.resolve(__dirname,'..'),patient=(id,phone,createdBy='staff')=>({id,name:'Анна Морозова',designation:'тренер по фитнесу',phone,createdBy,appointments:[],visits:[]});
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Phone search UI timeout');await new Promise(r=>setTimeout(r,15));}}
test('Russian +7/8 aliases match full and partial formatted queries without rewriting or guessing foreign prefixes',()=>{
 for(const phone of ['+7 (918) 123-45-67','79181234567','8 918 123 45 67']){
  const p=patient('p',phone),before=structuredClone(p);
  for(const q of ['89181234567','+79181234567','8 (918) 123-45-67','+7 918 123 45 67','8 918','+7 (918)','8918','7918','918123','8\u00a0918\u2011123\u201145\u201167','Анна Морозова','фитнесу'])assert.equal(patientMatchesSearch(p,q),true,q+' / '+phone);
  assert.equal(patientMatchesSearch(p,'89181234568'),false);assert.deepEqual(p,before);
 }
 for(const [phone,wrong] of [['+81 90 1234 567','79101234567'],['+374 91 123456','891123456'],['+1 918 123 4567','89181234567'],['555918','8555918']])assert.equal(patientMatchesSearch(patient('foreign',phone),wrong),false);
 assert.equal(patientMatchesSearch(patient('foreign','+81 90 1234 567'),'+81 (90) 1234-567'),true);
 assert.equal(patientMatchesSearch({name:'Анна',designation:'кабинет 5-этаж'},'5-этаж'),true);
 assert.equal(normalizePatientSearchQuery(' + '),'+');assert.equal(patientMatchesSearch({name:'Анна'},'8918'),false);
});
test('pasted phone formatting works in search queries and stored numbers', () => {
  const copied = '\u202A+7 999 123\u201145\u201167\u202C';
  assert.equal(normalizePatientSearchQuery(copied), '79991234567');
  assert.equal(patientMatchesSearch(patient('p', '+7 (999) 123-45-67'), copied), true);
  assert.equal(patientMatchesSearch(patient('p', copied), '89991234567'), true);
  const foreign = patient('foreign', '\u202A+81 90 1234\u2011567\u202C');
  assert.equal(patientMatchesSearch(foreign, '81901234567'), true);
  assert.equal(patientMatchesSearch(foreign, '79101234567'), false);
});
test('encrypted directory uses the same aliases with staff visibility, counts and unchanged storage',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-phone-directory-')),store=createStorage(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 store.write({revision:0,patients:[patient('plus','+7 (918) 123-45-67'),patient('eight','8 918 123 45 67','owner'),patient('foreign','+81 90 1234 567')],services:[]});
 const before=store.read(),owner={organizationId:'org',role:'owner',accountId:'owner'},staff={...owner,role:'cosmetologist',accountId:'staff'};
 const page=(q,current=owner)=>directoryPage(store,current,new URL('http://test/?'+new URLSearchParams({q,limit:20})));
 for(const q of ['8918','+7 (918) 123-45-67','8 918 123 45 67']){assert.equal(page(q).matched,2);assert.deepEqual(page(q,staff).directory.map(p=>p.id),['plus']);}
 assert.equal(page('79101234567').matched,0);assert.deepEqual(store.read(),before);
});
test('compatible local appointment lookup shares the same partial prefix and formatting rules',async t=>{
 const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());w.eval(fs.readFileSync(path.join(root,'src/client/core/client-directory.js'),'utf8'));
 const records=[patient('plus','+7 (918) 123-45-67'),patient('eight','8 918 987 65 43')],state={pagedReads:false};
 const module=w.createClientDirectory(state,{...createPatientNames(),clientRecords:()=>records});
 for(const q of ['8 918 123','+7 (918) 123'])assert.deepEqual((await module.loadAppointmentDirectory(q)).patients.map(p=>p.id),['plus']);
 assert.deepEqual((await module.loadAppointmentDirectory('7918987')).patients.map(p=>p.id),['eight']);
});
for(const width of [390,1440])test('client list, card search and appointment choice use equivalent phone prefixes at '+width,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-phone-ui-')),platform=createPlatformStore(path.join(dir,'platform')),password='Synthetic-phone-test-2026';
 const owner=await platform.registerOwner({email:'owner@example.test',password,displayName:'Test',organizationName:'Test'});platform.verifyEmail(owner.verificationToken);platform.close();
 const store=createStorage(path.join(dir,'tenants',owner.organizationId));store.write({revision:0,services:[],patients:[patient('plus','+7 (918) 123-45-67',owner.accountId),patient('eight','8 918 987 65 43',owner.accountId)]});const before=store.read();store.close();
 const server=createMultiServer({dataDir:dir,telegramAutostart:false,supportAutostart:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify({email:'owner@example.test',password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));const w=new JSDOM(fs.readFileSync(assetPath('index.html'),'utf8'),{url:base,runScripts:'outside-only',virtualConsole:vc}).window;
 t.after(async()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 w.fetch=(route,options={})=>fetch(base+route,{...options,headers:{...options.headers,Origin:base,Cookie:cookie}});w.AbortController=AbortController;w.structuredClone=structuredClone;w.matchMedia=()=>({matches:width<=700,addEventListener(){}});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 require('./helpers/client-bundle.cjs').evaluateClient(w);const $=s=>w.document.querySelector(s),type=(selector,text)=>{const field=$(selector);field.value=text;field.dispatchEvent(new w.Event('input',{bubbles:true}));};await until(()=>!w.document.body.classList.contains('app-loading'));
 $('[data-view="clients"]').click();$('[data-client-filter="all"]').click();type('#search','8 (918) 123');await until(()=>w.document.querySelectorAll('[data-patient]').length===1&&$('[data-patient="plus"]'));
 type('#search','+7 (918) 987');await until(()=>w.document.querySelectorAll('[data-patient]').length===1&&$('[data-patient="eight"]'));
 $('[data-patient="eight"]').click();type('#search','8918123');await until(()=>w.document.querySelectorAll('[data-patient]').length===1&&$('[data-patient="plus"]'));
 $('[data-view="calendar"]').click();$('#calendar-new').click();await until(()=>$('#editor').open);
 for(const [q,id] of [['8 (918) 123','plus'],['+7 918 987','eight']]){type('#appointment-patient-search',q);await until(()=>w.document.querySelectorAll('[data-appointment-patient-index]').length===1&&Array.from(w.document.querySelectorAll('#appointment-patient-results small')).some(field=>field.textContent===(id==='plus'?'+7 (918) 123-45-67':'+7 (918) 987-65-43')));$('[data-appointment-patient-index]').click();assert.equal($('#appointment-patient').value,id);}
 $('#cancel-editor').click();const inspect=createStorage(path.join(dir,'tenants',owner.organizationId));try{assert.deepEqual(inspect.read(),before);}finally{inspect.close();}assert.deepEqual(errors,[]);
});
