const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const selected = (result, key) => result.dialogue.fields.find(row => row.key === key)?.value;
function fixture(role='salon_admin') {
  const f=dialogueFixture({role});
  f.c.current.accountId=role==='owner'?'owner':role==='cosmetologist'?'staff':'admin';
  f.members.splice(0,f.members.length,
    {accountId:'owner',displayName:'Ирина Орлова',role:'owner',status:'active'},
    {accountId:'staff',displayName:'Мария Соколова',role:'cosmetologist',status:'active'},
    {accountId:'admin',displayName:'Ольга Администратор',role:'salon_admin',status:'active'});
  if(role==='cosmetologist')f.patients[0].createdBy='staff';
  f.services.splice(0,f.services.length,
    {id:'owner-primary',name:'Первичная консультация',duration:30,staffId:'owner'},
    {id:'staff-primary',name:'Первичная консультация',duration:30,staffId:'staff'});
  f.c.platform.workspaceSettings=()=>({enabled:false,mode:'separate',staffRules:[],rooms:[{id:'main',name:'Общий',active:true,staffIds:['owner','staff'],preventOverlap:false}]});
  return f;
}
const noSave=f=>assert.ok(f.patients.every(row=>row.appointments.length===0));
const start=(f,extra={})=>f.start({query:'Анну Семенову',date:day,time:'10:00',...extra});
const choose=(f,label)=>f.answer({choice:f.result.dialogue.options.find(row=>row.label.includes(label)).id}).result;

test('client field understands one natural identification wrapper and preserves the appointment draft',()=>{
  const f=fixture();const first=start(f,{query:undefined,duration:15});assert.equal(first.dialogue.step,'client');
  const next=f.answer({text:'Это Анна Семёнова.'}).result;
  assert.match(selected(next,'client'),/Анна Семёнова/);assert.equal(next.dialogue.step,'staff');
  assert.equal(selected(next,'date'),day);assert.equal(selected(next,'time'),'10:00');assert.equal(selected(next,'duration'),'15 мин');noSave(f);
});

test('staff field understands directional and possessive prepositions without fuzzy names',()=>{
  for(const text of ['к Ирине Орловой','у Ирины Орловой']){
    const f=fixture();start(f);assert.equal(f.result.dialogue.step,'staff');
    const next=f.answer({text}).result;assert.equal(selected(next,'staff'),'Ирина Орлова',text);assert.equal(next.dialogue.step,'service');
    choose(f,'Первичная');assert.equal(f.answer({text:'да'}).result.action.staffId,'owner');noSave(f);
  }
});

test('service field understands a natural appointment preposition or affirmative prefix',()=>{
  for(const text of ['на первичную консультацию','да, первичная консультация']){
    const f=fixture();start(f,{staffQuery:'Ирине Орловой'});assert.equal(f.result.dialogue.step,'service');
    const next=f.answer({text}).result;assert.equal(next.dialogue.step,'review',text);assert.equal(selected(next,'service'),'Первичная консультация');
    const final=f.answer({text:'да'}).result;assert.deepEqual(final.action.serviceIds,['owner-primary']);assert.equal(final.action.duration,30);noSave(f);
  }
});

test('self reference resolves only an eligible current owner or employee and still requires confirmation',()=>{
  for(const role of ['owner','cosmetologist']){
    const f=fixture(role);start(f,{staffQuery:'Несуществующий Специалист'});assert.equal(f.result.dialogue.step,'staff');
    const next=f.answer({text:'ко мне'}).result;assert.equal(selected(next,'staff'),role==='owner'?'Ирина Орлова':'Мария Соколова');
    assert.equal(next.dialogue.step,'service');assert.equal(next.action,null);choose(f,'Первичная');
    const done=f.answer({text:'да'}).result;assert.equal(done.action.staffId,f.c.current.accountId);noSave(f);
  }
});

test('an administrator self reference never chooses a performer and an employee cannot name a foreign performer',()=>{
  const admin=fixture();start(admin);const next=admin.answer({text:'ко мне'}).result;
  assert.equal(next.dialogue.step,'staff');assert.equal(selected(next,'staff'),undefined);assert.equal(next.action,null);
  assert.deepEqual(next.dialogue.options.map(row=>row.label),['Ирина Орлова','Мария Соколова']);
  const staff=fixture('cosmetologist');start(staff,{staffQuery:'Ирине Орловой'});
  const denied=staff.answer({text:'к Ирине Орловой'}).result;assert.equal(denied.dialogue.step,'staff');assert.equal(selected(denied,'staff'),undefined);
  assert.deepEqual(denied.dialogue.options.map(row=>row.label),['Мария Соколова']);noSave(admin);noSave(staff);
});

test('wrapped ambiguous names and service titles stay choices rather than first-match selection',()=>{
  const f=fixture();f.members.push({accountId:'second',displayName:'Ирина Петрова',role:'cosmetologist',status:'active'});
  start(f);const names=f.answer({text:'к Ирине'}).result;assert.equal(names.dialogue.step,'staff');assert.equal(selected(names,'staff'),undefined);
  assert.deepEqual(names.dialogue.options.map(row=>row.label),['Ирина Орлова','Ирина Петрова']);
  choose(f,'Орлова');f.services.push({id:'owner-repeat',name:'Повторная консультация',duration:20,staffId:'owner'});
  const services=f.answer({text:'на консультацию'}).result;assert.equal(services.dialogue.step,'service');assert.equal(selected(services,'service'),undefined);
  assert.deepEqual(services.dialogue.options.map(row=>row.label).sort(), ['Первичная консультация · 30 мин', 'Повторная консультация · 20 мин'].sort());noSave(f);
});

test('negative alternatives initials and unrelated field wrappers never replace a selected value',()=>{
  for(const text of ['это не Анна, а Ольга','это Анна или Ольга','это А. Семёнова','к Анне Семёновой']){
    const f=fixture();start(f,{query:undefined});const next=f.answer({text}).result;
    assert.equal(next.dialogue.step,'client',text);assert.equal(selected(next,'client'),undefined,text);assert.equal(next.action,null);noSave(f);
  }
  const f=fixture();start(f,{staffQuery:'Ирине Орловой',serviceQuery:'Первичную консультацию'});
  const before=f.result.dialogue.fields;const next=f.answer({text:'не Анна, а Ольга'}).result;
  assert.deepEqual(next.dialogue.fields,before);assert.equal(next.action,null);noSave(f);
});

test('a literal catalog title has priority over interpreting its leading word as a reply wrapper',()=>{
  const f=fixture();f.services.push({id:'literal',name:'На первичную консультацию',duration:45,staffId:'owner'});
  start(f,{staffQuery:'Ирине Орловой'});const next=f.answer({text:'На первичную консультацию'}).result;
  assert.equal(next.dialogue.step,'review');assert.equal(selected(next,'service'),'На первичную консультацию');
  const final=f.answer({text:'да'}).result;assert.deepEqual(final.action.serviceIds,['literal']);assert.equal(final.action.duration,45);noSave(f);
});
