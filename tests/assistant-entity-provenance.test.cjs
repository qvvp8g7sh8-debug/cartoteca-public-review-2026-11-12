const test=require('node:test'),assert=require('node:assert/strict');
const {entityText,initialEntities}=require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {serviceMatches}=require('../src/server/modules/assistant/language/services/service-matching.cjs');
const {resolveService}=require('../src/server/modules/assistant/actions/availability-context.cjs');
const {initialTemporalConstraints}=require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {dialogueFixture,day}=require('./helpers/assistant-dialogue-fixture.cjs');

test('proposals retain source spelling for declensions aliases and joined names without inventing an identity',()=>{
 for(const [request,proposal,expected]of [['Запиши Анну Семёнову завтра','Анна Семёнова','Анну Семёнову'],['Запиши Аню Семёнову','Анна Семёнова','Аню Семёнову'],['Запиши анюсеменову завтра','Анна Семёнова','анюсеменову'],['Для Артема Макартичана на завтра','Артем Макартичан','Артема Макартичана']])assert.equal(entityText(request,proposal,'client'),expected,request);
 for(const [request,proposal]of [['Запиши Артема Макартичана','Артём Мкртычян'],['Запиши Анну Семёнову','Жанна Семёнова'],['Запиши Юлю','Анна'],['не Полина','Неполина']])assert.equal(entityText(request,proposal,'client'),'',request);
});
test('services use the same source proof and catalog word forms for plural cases and reordered words',()=>{
 for(const [request,proposal,expected]of [['На консультаций завтра','консультация','консультаций'],['На консультацию первичную','Первичная консультация','консультацию первичную'],['Хочу пилинга','Пилинг','пилинга'],['Запиши на массажем','Массаж','массажем']])assert.equal(entityText(request,proposal,'service'),expected,request);
 assert.equal(entityText('На консультацию','Миндальный пилинг','service'),'');
 assert.equal(entityText('На пилинг','Миндальный пилинг','service'),'');
});
test('an unsupported initial model field is left missing while verified fields and temporal data remain available',()=>{
 const input={intent:'prepareAppointment',query:'Жанна',serviceQuery:'Консультация',staffQuery:'Ирина Орлова',date:'2026-10-17',time:'12:30'};
 const result=initialEntities(input,'Запиши Анну на консультацию завтра в12:30',{date:'2026-10-17',time:'12:30'});
 assert.deepEqual(result,{intent:'prepareAppointment',serviceQuery:'консультацию',date:'2026-10-17',time:'12:30'});
 assert.equal(input.query,'Жанна');
});
test('phone formatting changes preserve exactly spoken digits and complete token boundaries',()=>{
 assert.equal(entityText('Номер +7 (999) 111-22-33','79991112233','client'),'+7 (999) 111-22-33');
 assert.equal(entityText('Номер +7 (999) 111-22-33','89991112233','client'),'');
 assert.equal(entityText('Номер 1799911122334','79991112233','client'),'');
});
test('whole service words can be reordered and declined without prefixes token reuse or service guesses',()=>{
 for(const text of ['первичную консультацию','консультацию первичную','первичных консультаций'])assert.equal(serviceMatches('Первичная консультация',text),true,text);
 for(const text of ['консул','первичная первичная','молочную консультацию','не консультацию','консультацию или пилинг'])assert.equal(serviceMatches('Первичная консультация',text),false,text);
 for(const [catalog,text]of [['Миндальный пилинг','пилинга миндального'],['Массаж','массажа'],['Массаж','массажем']])assert.equal(serviceMatches(catalog,text),true,text);
 const services=[{id:'a',name:'Миндальный пилинг'},{id:'m',name:'Молочный пилинг'}];assert.deepEqual(resolveService(services,'пилинга').map(x=>x.id),['a','m']);
 assert.equal(serviceMatches('IPL','ipl'),true);assert.equal(serviceMatches('IPL','ipla'),false);
});

const permutations=[['client','service','time'],['client','time','service'],['service','client','time'],['service','time','client'],['time','client','service'],['time','service','client']];
for(const role of ['owner','salon_admin','cosmetologist'])test('field order matrix preserves all slots and explicit confirmation for '+role,()=>{
 let cases=0;
 for(const order of permutations)for(const date of ['сегодня','5 января 2099 года',day])for(const time of ['в12:30','в12-30','в двенадцать тридцать дня'])for(const heard of ['Анну Семёнову','анюсеменову']){
  const f=dialogueFixture({role});if(role==='cosmetologist')f.members[0].role=role;
  f.services[0]={id:'consult',name:'Первичная консультация',duration:30,staffId:'owner'};
  const parts={client:heard,service:'на консультацию первичную',time};
  const phrase='Запиши '+date+' '+order.map(key=>parts[key]).join(' ');
  const entities=initialEntities({intent:'prepareAppointment',query:'Анна Семёнова',serviceQuery:'Первичная консультация'},phrase);
  assert.ok(entities.query,phrase);assert.ok(entities.serviceQuery,phrase);
  const constraints=initialTemporalConstraints({intent:'prepareAppointment'},phrase,f.clock);
  assert.equal(constraints.date,day,phrase);assert.equal(constraints.time,'12:30',phrase);
  let result=f.start({...entities,...constraints});
  if(heard==='анюсеменову'){assert.equal(result.dialogue.step,'client',phrase);assert.equal(result.action,null);assert.equal(result.dialogue.options.length,1);result=f.answer({text:'да'}).result;}
  if(result.dialogue.step==='staff')result=f.answer({choice:result.dialogue.options[0].id}).result;
  assert.equal(result.dialogue.step,'review',phrase);const action=f.answer({text:'открой форму'}).result.action;
  assert.equal(action.patientId,f.patients[0].id,phrase);assert.equal(action.staffId,'owner');assert.equal(action.date,day);assert.equal(action.time,'12:30');assert.equal(action.duration,30);assert.deepEqual(action.serviceIds,['consult']);assert.equal(f.patients[0].appointments.length,0);cases++;
 }
 assert.equal(cases,108);
});
test('unspoken initial dates clocks and manual durations cannot be fabricated by a model',()=>{
 const p={intent:'prepareAppointment',query:'Анна Семёнова',serviceQuery:'Первичная консультация',date:'2099-01-05',time:'12:30',duration:45};
 const v=initialEntities(p,'Запиши Анну Семёнову на первичную консультацию');
 assert.deepEqual(v,{intent:'prepareAppointment',query:'Анну Семёнову',serviceQuery:'первичную консультацию'});
});

test('literal evidence returns exact raw spelling and excludes pieces of compound names',()=>{
assert.equal(entityText('Запиши Артёма  Макартичана','артема макартичана','client'),'Артёма  Макартичана');
for(const raw of ['Анна-Мария','Анна’Мария',"Анна'Мария",'Анна—Мария'])assert.equal(entityText(raw,'Анна','client'),'');
});
test('vague temporal words do not prove fabricated model values',()=>{
for(const raw of ['время уточню','длительность уточню','нев12:30','при12:30','на12часоввечера'])assert.deepEqual(initialEntities({intent:'prepareAppointment',time:'12:30',date:'2099-01-05',duration:45},raw),{intent:'prepareAppointment'},raw);
});

test('initial proposals cannot drop a spoken surname or replace it with model spelling',()=>{
for(const query of ['Артема','Артем Макартичан','Артём Мкртычян'])assert.equal(initialEntities({intent:'prepareAppointment',query,serviceQuery:'Первичная консультация'},'Запиши Артема Макартичана на первичную консультацию завтра в12:30').query,'Артема Макартичана');
assert.equal(initialEntities({intent:'prepareAppointment',query:'Анна'},'Запиши Анну—Марию на завтра').query,undefined);
});
