const test=require('node:test');
const assert=require('node:assert/strict');
const {dialogueFixture,day}=require('./helpers/assistant-dialogue-fixture.cjs');
const value=(result,key)=>result.dialogue.fields.find(row=>row.key===key)?.value;
function start(f,constraints,intent={}) {
  const ticket=f.flow.beginCommand(f.c,f.member,f.state);
  let result=f.flow.start(f.c,{intent:'prepareAppointment',query:'Анну Семенову',serviceQuery:'Чистка',date:day,time:'10:00',...intent},f.state,f.member,f.clock,ticket,constraints);
  return {get result(){return result;},answer(operation){result=f.flow.continueDialogue(f.c,{dialogueId:result.dialogue.id,dialogueVersion:result.dialogue.version,...operation},f.state,f.member,f.clock);return result;}};
}
const noSave=f=>assert.equal(f.patients[0].appointments.length,0);

test('invalid or conflicting explicitly spoken duration requires an answer instead of the catalog default',()=>{
  for(const phrase of ['семь минут','ноль минут','1500 минут','15 или 30 минут']){
    const f=dialogueFixture();const d=start(f,{requireDuration:true},{duration:30});const first=d.result;
    assert.equal(first.dialogue.step,'duration',phrase);assert.equal(value(first,'duration'),undefined);assert.equal(first.action,null);
    assert.match(value(first,'client'),/Анна Семёнова/);assert.equal(value(first,'service'),'Чистка');assert.equal(value(first,'date'),day);assert.equal(value(first,'time'),'10:00');
    const review=d.answer({text:'30 минут'});assert.equal(review.dialogue.step,'review');assert.equal(value(review,'duration'),'30 мин');
    const ready=d.answer({text:'да'});assert.equal(ready.action.duration,30);assert.equal(ready.action.patientId,f.patients[0].id);noSave(f);
  }
});

test('required duration is asked before any free-slot choices and blocks an explicit slot request until supplied',()=>{
  const f=dialogueFixture();const d=start(f,{requireDuration:true},{time:undefined});
  assert.equal(d.result.dialogue.step,'duration');assert.equal(d.result.dialogue.options.length,0);
  const still=d.answer({text:'подбери свободное время'});assert.equal(still.dialogue.step,'duration');assert.equal(still.dialogue.options.length,0);assert.equal(still.action,null);
  const next=d.answer({text:'15 минут'});assert.equal(next.dialogue.step,'time');assert.ok(next.dialogue.options.length>0);noSave(f);
});

test('a trusted valid duration overrides a missing or different model value and preserves manual duration through a service edit',()=>{
  for(const modelDuration of [undefined,45]){
    const f=dialogueFixture();f.services.push({id:'massage',name:'Массаж',duration:60,staffId:'owner'});
    const d=start(f,{duration:15},{duration:modelDuration});assert.equal(d.result.dialogue.step,'review');assert.equal(value(d.result,'duration'),'15 мин');
    d.answer({text:'услугу на массаж'});assert.equal(value(d.result,'duration'),'15 мин');
    const final=d.answer({text:'да'});assert.deepEqual(final.action.serviceIds,['massage']);assert.equal(final.action.duration,15);noSave(f);
  }
});

test('the required duration marker survives performer and service edits with the chosen client date and time intact',()=>{
  const f=dialogueFixture();f.services.push({id:'massage',name:'Массаж',duration:60,staffId:'owner'});
  const d=start(f,{requireDuration:true});const original=d.result.dialogue.fields;
  d.answer({text:'специалиста на Тестовый Специалист'});assert.equal(d.result.dialogue.step,'duration');
  assert.equal(d.result.action,null);
  const required=d.answer({text:'услугу на Массаж'});assert.equal(required.dialogue.step,'duration');assert.equal(value(required,'duration'),undefined);assert.equal(value(required,'service'),'Массаж');
  for(const key of ['client','date','time'])assert.equal(value(required,key),original.find(row=>row.key===key).value);
  const review=d.answer({text:'полчаса'});assert.equal(review.dialogue.step,'review');
  const done=d.answer({text:'да'});assert.equal(done.action.duration,30);assert.deepEqual(done.action.serviceIds,['massage']);noSave(f);
});

test('invalid duration answers preserve required state and never expose a prepared action',()=>{
  const f=dialogueFixture();const d=start(f,{requireDuration:true});const entry=f.flow.get(f.c,f.member,f.state,d.result.dialogue.id),before=structuredClone(entry.data);
  for(const text of ['7 минут','0','1500 минут','15 или 30 минут']){
    try{d.answer({text});}catch(error){assert.equal(error.status,400);}
    assert.deepEqual(entry.data,before,text);assert.equal(d.result.action,null);assert.equal(d.result.dialogue.step,'duration');noSave(f);
  }
  const fixed=d.answer({text:'длительность на 45 минут'});assert.equal(fixed.dialogue.step,'review');assert.equal(d.answer({text:'да'}).action.duration,45);noSave(f);
});

test('trusted constraint validation is bounded while the legacy start contract keeps catalog defaults',()=>{
  for(const constraints of [{duration:0},{duration:7},{duration:1500},{duration:'30'},{duration:30,requireDuration:true}]){
    const f=dialogueFixture();const d=start(f,constraints);assert.equal(d.result.dialogue.step,'duration');assert.equal(value(d.result,'duration'),undefined);noSave(f);
  }
  const f=dialogueFixture();const d=start(f,{});assert.equal(d.result.dialogue.step,'review');assert.equal(value(d.result,'duration'),'30 мин');assert.equal(d.answer({text:'да'}).action.duration,30);noSave(f);
});
