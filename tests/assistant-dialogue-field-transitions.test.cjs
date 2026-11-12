const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {dialogueFixture,day}=require('./helpers/assistant-dialogue-fixture.cjs');
const surnames=['Орлова','Петрова','Соколова','Морозова','Иванова','Кузнецова','Васильева','Смирнова','Попова','Федорова','Волкова','Алексеева','Романова','Николаева','Григорьева','Козлова','Зайцева','Беляева','Макарова','Павлова'];
const value=(result,key)=>result.dialogue.fields.find(row=>row.key===key)?.value;
function fixture(role='salon_admin'){
  const f=dialogueFixture({role});f.c.current.accountId=role==='salon_admin'?'admin':'owner';
  f.members[0].displayName='Ирина Орлова';
  f.c.platform.workspaceSettings=()=>({enabled:false,mode:'separate',staffRules:[],rooms:[{id:'main',name:'Общий',active:true,staffIds:f.members.map(row=>row.accountId),preventOverlap:false}]});
  f.c.platform.workSchedules.view=()=>({days:Object.fromEntries([day,'2099-01-06'].map(date=>[date,{status:'working',intervals:[['09:00','18:00']]}])),closures:{}});
  return f;
}
function start(f,intent={},constraints={}){
  let result=f.flow.start(f.c,{intent:'prepareAppointment',query:'Анна Семёнова',date:day,time:'10:00',...intent},f.state,f.member,f.clock,f.flow.beginCommand(f.c,f.member,f.state),constraints);
  return{get result(){return result;},answer(operation){result=f.flow.continueDialogue(f.c,{dialogueId:result.dialogue.id,dialogueVersion:result.dialogue.version,...operation},f.state,f.member,f.clock);return result;},entry(){return f.flow.get(f.c,f.member,f.state,result.dialogue.id);}};
}
const noSave=f=>assert.ok(f.patients.every(row=>row.appointments.length===0));
const choose=(d,label)=>d.answer({choice:d.result.dialogue.options.find(row=>row.label.includes(label)).id});

test('a visible client outside the first twelve options remains selectable by an exact natural answer',()=>{
  const f=fixture('owner'),original=f.patients[0];
  f.patients.splice(0,f.patients.length,...surnames.map(lastName=>({...original,id:randomUUID(),lastName,name:'Анна '+lastName,appointments:[]})));
  const d=start(f,{query:'Анна',serviceQuery:'Чистка'});assert.equal(d.result.dialogue.step,'client');assert.equal(d.result.dialogue.options.length,12);
  assert.ok(d.result.dialogue.options.every(row=>!row.label.includes('Павлова')));
  const next=d.answer({text:'это Анна Павлова'});assert.equal(next.dialogue.step,'review');assert.match(value(next,'client'),/Анна Павлова/);
  assert.equal(d.answer({text:'да'}).action.patientId,f.patients.at(-1).id);noSave(f);
});

test('an eligible performer outside the first twelve options is resolved from text before its own catalog is offered',()=>{
  const f=fixture();f.members.splice(0,f.members.length,...surnames.map((name,index)=>({accountId:'performer-'+index,displayName:'Ирина '+name,role:index===0?'owner':'cosmetologist',status:'active'})));
  f.services.splice(0,f.services.length,...f.members.map(member=>({id:'service-'+member.accountId,name:'Первичная консультация',duration:30,staffId:member.accountId})));
  const d=start(f,{staffQuery:'Ирина'});assert.equal(d.result.dialogue.step,'staff');assert.equal(d.result.dialogue.options.length,12);
  assert.ok(d.result.dialogue.options.every(row=>!row.label.includes('Павлова')));
  const next=d.answer({text:'к Ирине Павловой'});assert.equal(next.dialogue.step,'service');assert.equal(value(next,'staff'),'Ирина Павлова');
  choose(d,'Первичная');const done=d.answer({text:'да'});assert.equal(done.action.staffId,'performer-19');assert.deepEqual(done.action.serviceIds,['service-performer-19']);noSave(f);
});

test('a catalog service outside the current page remains selectable by its exact full title',()=>{
  const f=fixture('owner');f.services.splice(0,f.services.length,...surnames.map((name,index)=>({id:'service-'+index,name:'Консультация '+name,duration:30,staffId:'owner'})));
  f.services.unshift(...Array.from({length:5},(_,index)=>({id:'extra-'+index,name:'Консультация специалиста '+index,duration:30,staffId:'owner'})));
  const d=start(f);assert.equal(d.result.dialogue.step,'service');assert.equal(d.result.dialogue.options.length,24);
  assert.ok(d.result.dialogue.options.every(row=>!row.label.includes('Павлова')));
  const next=d.answer({text:'на Консультация Павлова'});assert.equal(next.dialogue.step,'review');assert.equal(value(next,'service'),'Консультация Павлова');
  assert.deepEqual(d.answer({text:'да'}).action.serviceIds,['service-19']);noSave(f);
});

test('directory overflow asks for a narrower name without treating a client beyond the page as unavailable',()=>{
  const f=fixture('owner'),original=f.patients[0],letters='абвгдежзийклмнопрстуфхцчшщэюя';
  f.patients.splice(0,f.patients.length,...Array.from({length:60},(_,index)=>{const lastName='Фамилия'+letters[Math.floor(index/letters.length)]+letters[index%letters.length];return{...original,id:randomUUID(),lastName,name:'Анна '+lastName,appointments:[]};}));
  const d=start(f,{query:'Анна',serviceQuery:'Чистка'});assert.equal(d.result.dialogue.step,'client');assert.equal(d.result.dialogue.options.length,0);assert.equal(d.result.dialogue.prompt,'Уточните полное имя или телефон клиента.');assert.equal(d.result.action,null);assert.equal(d.entry().data.patient,null);
  const chosen=f.patients.at(-1);const next=d.answer({text:'это '+chosen.name});assert.equal(next.dialogue.step,'review');assert.equal(d.answer({text:'да'}).action.patientId,chosen.id);noSave(f);
});

test('required duration survives an atomic performer service and date correction before a valid manual answer',()=>{
  const f=fixture('owner');f.members.push({accountId:'other',displayName:'Мария Соколова',role:'cosmetologist',status:'active'});f.services.push({id:'other-consult',name:'Первичная консультация',duration:60,staffId:'other'});
  const d=start(f,{serviceQuery:'Чистка'},{requireDuration:true});const client=value(d.result,'client');assert.equal(d.result.dialogue.step,'duration');
  const changed=d.answer({text:'специалиста на Марию Соколову, услугу на первичную консультацию, дату на завтра'});
  assert.equal(changed.dialogue.step,'duration');assert.equal(value(changed,'client'),client);assert.equal(value(changed,'staff'),'Мария Соколова');assert.equal(value(changed,'service'),'Первичная консультация');assert.equal(value(changed,'date'),'2099-01-06');assert.equal(value(changed,'time'),'10:00');assert.equal(value(changed,'duration'),undefined);
  const review=d.answer({text:'45 минут'});assert.equal(review.dialogue.step,'review');const done=d.answer({text:'да'});assert.equal(done.action.staffId,'other');assert.equal(done.action.duration,45);assert.equal(done.action.date,'2099-01-06');noSave(f);
});

test('failed multipart repairs preserve the required-duration marker and every previously selected field',()=>{
  const f=fixture('owner'),d=start(f,{serviceQuery:'Чистка'},{requireDuration:true});
  for(const text of ['дату на завтра, длительность на семь минут','дату на завтра, время на 25:00','длительность на 15 минут, длительность на 30 минут','не Анна, а Ольга']){
    const before=structuredClone(d.entry().data),next=d.answer({text});assert.deepEqual(d.entry().data,before,text);assert.equal(next.dialogue.step,'duration');assert.equal(next.action,null);noSave(f);
  }
});

test('suspended performer and removed catalog text cannot be resurrected from an old option list',()=>{
  const f=fixture();f.members.push({accountId:'other',displayName:'Мария Соколова',role:'cosmetologist',status:'active'});f.services.push({id:'other-consult',name:'Первичная консультация',duration:60,staffId:'other'});
  const d=start(f);const stale=d.result.dialogue.options.find(row=>row.label==='Мария Соколова');f.members.at(-1).status='suspended';
  assert.throws(()=>d.answer({choice:stale.id}),{status:403});const unchanged=d.answer({text:'к Марии Соколовой'});assert.equal(unchanged.dialogue.step,'staff');assert.equal(value(unchanged,'staff'),undefined);assert.ok(unchanged.dialogue.options.every(row=>row.label!=='Мария Соколова'));
  choose(d,'Ирина');const oldService=d.result.dialogue.options.find(row=>row.label.startsWith('Чистка'));f.services.splice(0,1);
  assert.throws(()=>d.answer({choice:oldService.id}),{status:409});const missing=d.answer({text:'на Чистку'});assert.equal(missing.dialogue.step,'service');assert.equal(value(missing,'service'),undefined);assert.equal(missing.action,null);noSave(f);
});

test('revoked live permission during a required-duration answer rolls back the draft and role changes fence the dialogue',()=>{
  const f=fixture('owner'),d=start(f,{serviceQuery:'Чистка'},{requireDuration:true}),before=structuredClone(d.entry().data);
  f.c.assertCurrent=()=>{const error=new Error('Synthetic revoked permission');error.status=403;throw error;};
  assert.throws(()=>d.answer({text:'30 минут'}),{status:403});assert.deepEqual(d.entry().data,before);assert.equal(d.result.dialogue.step,'duration');
  f.c.assertCurrent=()=>{};f.c.current.role='salon_admin';assert.throws(()=>d.answer({text:'30 минут'}),{status:409});noSave(f);
});

test('catalog duration changes never replace a required answer while a later valid answer remains authoritative',()=>{
  const f=fixture('owner'),d=start(f,{serviceQuery:'Чистка'},{requireDuration:true});f.services[0].duration=60;
  const still=d.answer({text:'помощь'});assert.equal(still.dialogue.step,'duration');assert.equal(value(still,'duration'),undefined);assert.equal(d.entry().data.durationSource,'required');
  d.answer({text:'15 минут'});f.services[0].duration=90;const done=d.answer({text:'да'});assert.equal(done.action.duration,15);assert.deepEqual(done.action.serviceIds,['clean']);noSave(f);
});
