const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function load(file,name,globals={}){return vm.runInNewContext(read(file)+'\n'+name,{structuredClone,AbortController,setTimeout,clearTimeout,console,...globals});}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function dom(t){const w=new JSDOM('<dialog id="editor" open><form id="editor-form"><div id="form-content"><input name="notes" value="Keep draft"><div id="upload-list"></div></div><p id="form-error"></p><button id="save-editor"></button></form></dialog>',{runScripts:'outside-only'}).window;t.after(()=>w.close());return w;}

test('photos never cross visits, closed dialogs or accounts and cannot save during processing',async t=>{
  const w=dom(t),first=deferred(),second=deferred(),state={busy:false,editorMode:{kind:'visit',patientId:'A'},uploadItems:[],account:{id:'owner'}};let signal,calls=0;
  const actions={$:s=>w.document.querySelector(s),esc:String,canDelete:()=>true,toast(){},resize:(file,options)=>{signal=options.signal;return ++calls===1?first.promise:second.promise;}};
  Object.assign(actions,load('src/client/modules/photos.js','createPhotos')(state,actions));
  actions.resize=(file,options)=>{signal=options.signal;return ++calls===1?first.promise:second.promise;};
  const file={type:'image/jpeg',size:1},pending=actions.processFiles([file]);assert.equal(actions.photosPending(),true);assert.equal(actions.$('#save-editor').disabled,true);
  await actions.processFiles([file]);assert.equal(calls,1);
  actions.cancelPhotoProcessing();assert.equal(signal.aborted,true);state.editorMode={kind:'visit',patientId:'B'};state.uploadItems=[];actions.updatePhotoSaveButton();
  const next=actions.processFiles([file]);first.resolve('data:synthetic-A');await pending;assert.equal(state.uploadItems.length,0);assert.equal(actions.photosPending(),true);
  second.resolve('data:synthetic-B');await next;assert.equal(state.uploadItems[0].data,'data:synthetic-B');assert.equal(actions.photosPending(),false);assert.equal(actions.$('#save-editor').disabled,false);
  const late=deferred();actions.resize=()=>late.promise;const old=actions.processFiles([file]);state.account={id:'other'};late.resolve('wrong-account');await old;assert.equal(state.uploadItems.length,1);
});
test('bad photos report errors, release the save button and respect six-photo limit',async t=>{
  const w=dom(t),messages=[],state={busy:false,editorMode:{kind:'visit'},uploadItems:[]};
  const actions={$:s=>w.document.querySelector(s),esc:String,canDelete:()=>true,toast:m=>messages.push(m),resize:async()=>{throw Error('invalid');}};
  Object.assign(actions,load('src/client/modules/photos.js','createPhotos')(state,actions));actions.resize=async()=>{throw Error('invalid');};
  await actions.processFiles([{type:'image/jpeg',size:1},{type:'image/gif',size:1}]);assert.equal(messages.length,2);assert.equal(actions.$('#save-editor').disabled,false);
  actions.resize=async()=>'/synthetic';await actions.processFiles(Array.from({length:8},()=>({type:'image/png',size:1})));assert.equal(state.uploadItems.length,6);
});
test('fresh completed appointment opens its real linked visit, never a blank visit',async()=>{
  const old={id:'p',visits:[],appointments:[{id:'a',status:'scheduled'}]},visit={id:'v',appointmentId:'a'},fresh={id:'p',visits:[visit],appointments:[{id:'a',status:'completed',completedVisitId:'v'}]};
  const state={lazyReads:true,data:[old],account:{id:'owner'},currentView:'calendar',editorMode:null},messages=[];let opened=null,reads=0;
  const actions={canEditRecord:()=>true,ensurePatient:async(id,opts)=>{assert.equal(opts.force,true);reads++;return fresh;},openVisitForm:v=>{opened=v;},toast:m=>messages.push(m)};
  const appointments=load('src/client/modules/appointments.js','createAppointments')(state,actions);
  await appointments.openAppointmentForm({id:'a',patientId:'p',status:'scheduled'});assert.equal(opened,visit);assert.equal(reads,1);
  opened=null;fresh.visits=[];await appointments.openAppointmentForm({id:'a',patientId:'p',status:'completed'});assert.equal(opened,null);assert.match(messages.at(-1),/не найдены/);
  fresh.appointments=[];await appointments.openAppointmentForm({id:'a',patientId:'p',status:'completed'});assert.equal(opened,null);assert.match(messages.at(-1),/удалена/);
});
test('late appointment responses do not replace another form or navigate back',async()=>{
  const reply=deferred(),state={lazyReads:true,data:[],account:{id:'owner'},currentView:'calendar',editorMode:null};let opened=0;
  const actions={canEditRecord:()=>true,ensurePatient:()=>reply.promise,openVisitForm:()=>opened++,toast(){}};
  const appointments=load('src/client/modules/appointments.js','createAppointments')(state,actions);
  const task=appointments.openAppointmentForm({id:'a',patientId:'p',status:'completed'});state.currentView='clients';state.editorMode={kind:'patient'};
  reply.resolve({id:'p',appointments:[{id:'a',status:'completed',completedVisitId:'v'}],visits:[{id:'v',appointmentId:'a'}]});await task;assert.equal(opened,0);assert.equal(state.editorMode.kind,'patient');
});
test('request deadline covers fetch and response body, including non-aborting mocks',async()=>{
  let count=0,signal;
  const session=load('src/client/core/session.js','createSession',{fetch:(url,options)=>{count++;signal=options.signal;return new Promise(()=>{});}})({},{});
  await assert.rejects(session.request('/api/cabinet/changes',{method:'PATCH',body:'{}',timeoutMs:10}),e=>e.outcomeUnknown===true&&/неизвестен/.test(e.message));assert.equal(count,1);assert.equal(signal.aborted,true);
  const body=load('src/client/core/session.js','createSession',{fetch:async()=>({ok:true,json:()=>new Promise(()=>{})})})({},{});
  await assert.rejects(body.request('/read',{timeoutMs:10}),e=>e.outcomeUnknown===false);
  const controller=new AbortController();controller.abort();await assert.rejects(session.request('/read',{signal:controller.signal}),e=>!e.outcomeUnknown);assert.equal(count,1);
});
function storeFixture(){
  const state={account:{id:'owner',organizationId:'org'},data:[{id:'p',name:'Before',visits:[],appointments:[]}],services:[],revision:1};
  const actions={};Object.assign(actions,load('src/client/core/cabinet-store.js','createCabinetStore')(state,actions));actions.rememberCabinet({patients:state.data,services:[],partialWrites:true});return {state,actions};
}
test('lost acknowledgement is reconciled by GET with no duplicate mutation',async()=>{
  const f=storeFixture();let saved,posts=0;
  f.actions.request=async(url,options)=>{if(options){posts++;saved=JSON.parse(options.body).patients[0].after;throw Object.assign(Error('lost'),{outcomeUnknown:true});}return {patients:[saved],revision:2};};
  f.state.data[0].notes='Saved';await assert.rejects(f.actions.save());f.actions.rollback();assert.equal(f.actions.cabinetSaveStatus(),'check');
  const result=await f.actions.recoverCabinetSave();assert.equal(result.status,'saved');assert.equal(posts,1);assert.equal(f.state.data[0].notes,'Saved');assert.equal(f.actions.cabinetSaveStatus(),null);
});
test('retry preserves original IDs and payload even after rollback or form changes',async()=>{
  const f=storeFixture(),before=structuredClone(f.state.data[0]);let original,sends=0;
  f.actions.request=async(url,options)=>{if(options){sends++;if(sends===1){original=options.body;throw Object.assign(Error('offline'),{outcomeUnknown:true});}assert.equal(options.body,original);const body=JSON.parse(options.body);return {patients:body.patients.map(c=>c.after),services:[],revision:2};}return {patients:[before],revision:1};};
  f.state.data[0].visits.push({id:'stable-visit',date:'2026-10-05'});await assert.rejects(f.actions.save());f.actions.rollback();
  assert.equal((await f.actions.recoverCabinetSave()).status,'retry');assert.equal(sends,1);f.state.data[0].visits.push({id:'do-not-submit'});
  await assert.rejects(f.actions.save(),/Сначала/);assert.equal((await f.actions.recoverCabinetSave({retry:true})).status,'saved');assert.equal(sends,2);assert.equal(f.state.data[0].visits.length,1);assert.equal(f.state.data[0].visits[0].id,'stable-visit');
});
test('browser transport retry can report 409 after a successful first commit',async()=>{
  const f=storeFixture();let saved,sends=0;
  f.actions.request=async(url,options)=>{if(options){sends++;saved=JSON.parse(options.body).patients[0].after;throw Object.assign(Error('transport retry conflict'),{status:409});}return {patients:[saved],revision:2};};
  f.state.data[0].visits.push({id:'one-visit'});await assert.rejects(f.actions.save());f.actions.rollback();
  assert.equal(f.actions.cabinetSaveStatus(),'check');assert.equal((await f.actions.recoverCabinetSave()).status,'saved');assert.equal(sends,1);assert.equal(f.state.data[0].visits.length,1);
});
test('late first commit wins against an explicit retry without creating a duplicate',async()=>{
  const f=storeFixture(),before=structuredClone(f.state.data[0]);let after,sends=0,committed=false;
  f.actions.request=async(url,options)=>{if(options){sends++;if(sends===1){after=JSON.parse(options.body).patients[0].after;throw Object.assign(Error('lost'),{outcomeUnknown:true});}committed=true;throw Object.assign(Error('conflict'),{status:409});}return {patients:[committed?after:before],revision:committed?2:1};};
  f.state.data[0].visits.push({id:'single-visit'});await assert.rejects(f.actions.save());f.actions.rollback();await f.actions.recoverCabinetSave();
  assert.equal((await f.actions.recoverCabinetSave({retry:true})).status,'saved');assert.equal(f.state.data[0].visits.length,1);assert.equal(sends,2);
});
test('normalized photos and concurrent edits require explicit review; stale accounts cannot adopt them',async()=>{
  const f=storeFixture();f.actions.request=async(url,options)=>{if(options)throw Object.assign(Error('lost'),{outcomeUnknown:true});return {patients:[{id:'p',name:'Changed elsewhere',visits:[],appointments:[]}],revision:2};};
  f.state.data[0].name='Draft';await assert.rejects(f.actions.save());f.actions.rollback();assert.equal((await f.actions.recoverCabinetSave()).status,'review');assert.equal(f.state.data[0].name,'Before');
  await f.actions.recoverCabinetSave({acceptCurrent:true});assert.equal(f.state.data[0].name,'Changed elsewhere');
  f.state.data[0].name='Another draft';await assert.rejects(f.actions.save());f.actions.rollback();const reply=deferred();f.actions.request=()=>reply.promise;const check=f.actions.recoverCabinetSave();f.state.account={id:'other'};reply.resolve({patients:[{id:'p',name:'Wrong scope'}],revision:3});assert.equal((await check).status,'none');assert.equal(f.state.data[0].name,'Changed elsewhere');
});
