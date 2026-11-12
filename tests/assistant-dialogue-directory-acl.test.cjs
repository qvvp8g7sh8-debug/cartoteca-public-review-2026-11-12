const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createStorage}=require('../storage.cjs');
const {createAssistantDialogue}=require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {resolveClient}=require('../src/server/modules/assistant/language/names/name-directory.cjs');
const {day}=require('./helpers/assistant-dialogue-fixture.cjs');
function fixture(t){
  const parent=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(parent,'cartoteca-assistant-directory-acl-'));
  const storage=createStorage(directory);
  t.after(()=>{storage.close();assert.equal(path.dirname(directory),parent);assert.ok(path.basename(directory).startsWith('cartoteca-assistant-directory-acl-'));assert.equal(fs.realpathSync(directory),directory);fs.rmSync(directory,{recursive:true,force:true});});
  const patient=(firstName,lastName,createdBy,extra={})=>({id:randomUUID(),firstName,lastName,name:firstName+' '+lastName,phone:'+79991112233',createdBy,visits:[],appointments:[],...extra});
  const own=patient('Анна','Семёнова','staff-a');
  const hidden=patient('Анна','Семенова','staff-b',{phone:'+79990008888'});
  const visited=patient('Мария','Орлова','owner',{visits:[{id:randomUUID(),date:'2026-10-01',staffId:'staff-a',procedure:'OWN-VISIT',photos:[]}]});
  const assigned=patient('Ольга','Петрова','owner',{visits:[{id:randomUUID(),date:'2026-10-02',staffId:'staff-b',procedure:'OTHER-VISIT-PRIVATE',photos:[]}],appointments:[{id:randomUUID(),date:'2099-01-06',time:'17:00',duration:30,staffId:'staff-a',roomId:'main',service:'Assigned service'}]});
  const members=[{accountId:'owner',displayName:'Ирина Владельцева',role:'owner',status:'active'},{accountId:'staff-a',displayName:'Мария Соколова',role:'cosmetologist',status:'active'},{accountId:'staff-b',displayName:'Елена Петрова',role:'cosmetologist',status:'active'},{accountId:'admin',displayName:'Ольга Администратор',role:'salon_admin',status:'active'}];
  const services=[{id:'own-service',name:'Чистка',staffId:'owner',duration:'30'},{id:'a-service',name:'Консультация',staffId:'staff-a',duration:'30'},{id:'b-service',name:'Консультация',staffId:'staff-b',duration:'45'}];
  storage.write({revision:0,services:services.map(row=>({...row,price:0})),patients:[own,hidden,visited,assigned]});
  const context=(role,accountId)=>({current:{organizationId:'synthetic-org',accountId,role,sessionId:randomUUID(),expiresAt:Date.now()+3600000},token:'synthetic-session',assertCurrent(){},tenantStore(org){assert.equal(org,'synthetic-org');return storage;},platform:{workspaceMembers:()=>members,organizationTimeZone:()=> 'Europe/Moscow',workspaceSettings:()=>({enabled:false,mode:'separate',staffRules:[],rooms:[{id:'main',name:'Общий',active:true,staffIds:['owner','staff-a','staff-b'],preventOverlap:false}]}),bookingRequests:{reserves:()=>[]},personalEvents:{occupancy:()=>[]},workSchedules:{view:()=>({days:{[day]:{status:'working',intervals:[['09:00','18:00']]}},closures:{}})}}});
  const dialogue=(c,intent)=>{const flow=createAssistantDialogue(),member={membershipId:randomUUID()},state={revision:1,policy:{commands:{prepareAppointment:true}}},clock={date:day,hour:8,minute:0};let result=flow.start(c,{intent:'prepareAppointment',...intent},state,member,clock,flow.beginCommand(c,member,state));return{get result(){return result;},answer(operation){result=flow.continueDialogue(c,{dialogueId:result.dialogue.id,dialogueVersion:result.dialogue.version,...operation},state,member,clock);return result;}};};
  return{storage,own,hidden,visited,assigned,context,dialogue};
}

test('real audience indexes retain admin visibility and employee hidden-namesake isolation',t=>{
  const f=fixture(t),before=f.storage.read();
  for(const [role,id] of [['owner','owner'],['salon_admin','admin']]){
    const c=f.context(role,id);assert.equal(f.storage.indexes.summaryRows(c.current).length,4);
    assert.equal(resolveClient(c,'Анну Семенову.').matches.length,2);
  }
  const employee=f.context('cosmetologist','staff-a');
  assert.equal(f.storage.indexes.summaryRows(employee.current).length,3);
  assert.deepEqual(resolveClient(employee,'Анну Семенову.').matches.map(row=>row.id),[f.own.id]);
  assert.deepEqual(resolveClient(employee,'+79990008888').matches,[]);
  assert.deepEqual(f.storage.read(),before);
});

test('existing visit or appointment assignment grants the same directory access without exposing another staff history',t=>{
  const f=fixture(t),c=f.context('cosmetologist','staff-a'),before=f.storage.read();
  assert.equal(resolveClient(c,'Марию Орлову').matches[0].id,f.visited.id);
  const projected=resolveClient(c,'Ольгу Петрову').matches[0];assert.equal(projected.id,f.assigned.id);assert.equal(projected.lastVisit,null);
  const flow=f.dialogue(c,{query:'Ольгу Петрову',serviceQuery:'Консультация',date:day,time:'10:00'});
  assert.equal(flow.result.dialogue.step,'review');assert.doesNotMatch(JSON.stringify(flow.result),/OTHER-VISIT-PRIVATE|OWN-VISIT/);
  const done=flow.answer({text:'да'});assert.equal(done.action.patientId,f.assigned.id);assert.equal(done.action.staffId,'staff-a');
  assert.deepEqual(f.storage.read(),before);
});

test('administrator selects another performer through real indexed client data and employee remains self scoped',t=>{
  const f=fixture(t),before=f.storage.read();
  const admin=f.dialogue(f.context('salon_admin','admin'),{query:'Мария Орлова',date:day,time:'10:00'});
  assert.equal(admin.result.dialogue.step,'staff');assert.equal(admin.result.dialogue.options.length,3);
  admin.answer({choice:admin.result.dialogue.options.find(row=>row.label==='Елена Петрова').id});
  admin.answer({choice:admin.result.dialogue.options.find(row=>row.label.startsWith('Консультация')).id});
  assert.equal(admin.answer({text:'да'}).action.staffId,'staff-b');
  const own=f.dialogue(f.context('cosmetologist','staff-a'),{query:'Мария Орлова',date:day,time:'10:00',staffQuery:'Елена Петрова'});
  assert.equal(own.result.dialogue.step,'staff');assert.deepEqual(own.result.dialogue.options.map(row=>row.label),['Мария Соколова']);
  assert.deepEqual(f.storage.read(),before);
});

test('fresh real index revocation before review cannot reuse a previously visible client',t=>{
  const f=fixture(t),flow=f.dialogue(f.context('cosmetologist','staff-a'),{query:'Анну Семенову',serviceQuery:'Консультация',date:day,time:'10:00'});
  assert.equal(flow.result.dialogue.step,'review');
  const external=f.storage.read();external.patients.find(row=>row.id===f.own.id).createdBy='staff-b';f.storage.write(external);
  const afterExternal=f.storage.read(),changed=flow.answer({text:'да'});
  assert.equal(changed.action,null);assert.equal(changed.dialogue.step,'client');assert.equal(changed.dialogue.fields.some(row=>row.key==='client'),false);
  assert.deepEqual(f.storage.read(),afterExternal);
});
