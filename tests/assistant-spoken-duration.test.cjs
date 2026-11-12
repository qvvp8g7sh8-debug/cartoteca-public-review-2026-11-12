const test = require('node:test');
const assert = require('node:assert/strict');
const { spokenNumber } = require('../src/server/modules/assistant/language/time/spoken-number.cjs');
const { parseDuration } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('Russian whole numbers remain exact and respect each caller maximum', () => {
  for (const [text, value] of [['шестьдесят',60],['девяносто пять',95],['сто двадцать',120],['двести сорок пять',245],['тысяча',1000],['одна тысяча четыреста сорок',1440]]) {
    assert.equal(spokenNumber(text,1440),value,text);
    assert.equal(spokenNumber(text,59),null,text);
  }
  assert.equal(spokenNumber('ноль пять'),5);
  assert.equal(spokenNumber('двадцать три',23),23);
  assert.equal(spokenNumber('двадцать четыре',23),null);
  for (const text of ['первого','сто сто','двадцать двадцать','тысяча тысяча','тысяча или сорок','два три','сто 20'])
    assert.equal(spokenNumber(text,1440),null,text);
});

test('whole spoken minute durations and terminal sentence punctuation keep exact range and step', () => {
  for (const [text, value] of [['шестьдесят минут',60],['девяносто минут',90],['сто двадцать минут',120],['сто двадцать пять минут',125],['двести сорок минут',240],['одна тысяча четыреста сорок минут',1440],['на сорок пять минут.',45],['15.',15]])
    assert.equal(parseDuration(text),value,text);
});

test('explicit hours plus minutes are one duration and never a rounded or selected clock', () => {
  for (const [text, value] of [['один час тридцать минут',90],['час пятнадцать минут',75],['два часа и пять минут',125],['1ч30мин',90],['один час, тридцать минут',90],['двадцать четыре часа ноль минут',1440],['четверть часа',15],['три четверти часа',45],['1.5 часа',90],['1,25 часа',75]])
    assert.equal(parseDuration(text),value,text);
});

test('ambiguous, negative, unsupported fractional, non-step and excessive durations remain rejected', () => {
  for (const text of ['примерно час','около девяноста минут','час или полтора','от часа до двух','час три минуты','24 часа 5 минут','двадцать пять часов','ноль минут','одна минута','минус тридцать минут','1.5','1,5','-1.5 часа','1.01 часа','1.5 часа если можно','1.5 часа и сохрани','7,5 минут','14:30','сто минут двадцать минут','сто двадцать или сто тридцать минут'])
    assert.equal(parseDuration(text),null,text);
});

test('duration number extensions do not weaken time-of-day or ordinal ambiguity', () => {
  for (const text of ['шестьдесят','девяносто минут','сто двадцать','четырнадцать часов шестьдесят минут','два три','три четыре','двенадцать пять','в два три дня','первого'])
    assert.equal(parseTimeText(text),null,text);
  assert.equal(parseTimeText('четырнадцать тридцать'),'14:30');
  assert.equal(parseTimeText('два часа дня'),'14:00');
  assert.equal(parseTimeText('два часа'),'14:00');
  for (const [text,time] of [['на час','13:00'],['на два','14:00'],['на два часа','14:00'],['два ноль три','14:03'],['14 03','14:03'],['два три минуты','14:03'],['два часа три минуты','14:03'],['два десять','14:10']])
    assert.equal(parseTimeText(text),time,text);
});

test('natural compound duration fills the duration step, offers real windows and keeps Save manual', () => {
  const f=dialogueFixture();f.start({query:'Анну Семенову',date:day},{requireDuration:true});
  f.answer({text:'Чистка'});assert.equal(f.result.dialogue.step,'duration');
  const answer=f.answer({text:'один час тридцать минут'}).result;
  assert.equal(answer.dialogue.step,'time');assert.ok(answer.dialogue.options.length>0);assert.equal(answer.action,null);
  assert.equal(answer.dialogue.fields.find(row=>row.key==='duration').value,'90 мин');
  assert.equal(answer.dialogue.phase,'period');
  const slots=f.answer({text:'любое время'}).result;
  assert.equal(slots.dialogue.phase,'slots');assert.equal(slots.action,null);
  const current=f.flow.get(f.c,f.member,f.state,slots.dialogue.id);
  const selected=slots.dialogue.options.find(option=>current.options.get(option.id)?.kind==='slot');
  assert.ok(selected);
  const expected=structuredClone(current.options.get(selected.id).value);
  assert.equal(expected.date,day);assert.equal(expected.duration,90);
  f.answer({choice:selected.id});assert.equal(f.result.dialogue.step,'review');assert.equal(f.result.action,null);
  const ready=f.answer({text:'да'}).result;
  assert.equal(ready.action.type,'prepareAppointment');assert.equal(ready.action.duration,90);
  assert.equal(ready.action.patientId,f.patients[0].id);assert.equal(ready.action.staffId,'owner');
  assert.equal(ready.action.date,expected.date);assert.equal(ready.action.time,expected.time);
  assert.deepEqual(ready.action.serviceIds,['clean']);assert.equal(f.patients[0].appointments.length,0);
});

test('named duration corrections preserve selected identity and apply no part of an invalid compound patch', () => {
  const f=dialogueFixture();f.start({query:'Анну Семенову',serviceQuery:'Чистка',date:day,time:'10:00'});
  const first=f.result;f.answer({text:'длительность на девяносто минут'});
  assert.equal(f.result.dialogue.step,'review');assert.equal(f.result.dialogue.fields.find(row=>row.key==='duration').value,'90 мин');
  const entry=f.flow.get(f.c,f.member,f.state,f.result.dialogue.id),before=structuredClone(entry.data);
  const invalid=f.answer({text:'дату на завтра, длительность на час три минуты'}).result;
  assert.equal(invalid.action,null);assert.deepEqual(entry.data,before);
  assert.equal(invalid.dialogue.fields.find(row=>row.key==='client').value,first.dialogue.fields.find(row=>row.key==='client').value);
  assert.equal(f.patients[0].appointments.length,0);
  const repair=repairOperation(entry,'длительность на один час тридцать минут',f.clock);
  assert.deepEqual(repair.edits,[{field:'duration',text:'90'}]);
});

const { readDurationMinutes } = require('../src/server/modules/assistant/language/time/spoken-duration.cjs');
test('raw duration reader distinguishes explicit unsupported values before step and range validation',()=>{
  for(const [text,raw] of [['семь минут',7],['ноль минут',0],['1500 минут',1500],['шестьдесят минут',60],['девяносто минут',90],['один час тридцать минут',90],['100000 минут',100000],['1666 часов 40 минут',100000]]){
    assert.equal(readDurationMinutes(text),raw,text);
    if(raw<5||raw>1440||raw%5)assert.equal(parseDuration(text),null,text);
  }
});
test('raw duration reader consumes one whole expression and stays bounded without guessing context',()=>{
  for(const text of ['100001 минут','-7 минут','7,5 минут','от 5 до 10 минут','семь или десять минут','запиши Анну на семь минут','завтра в 14:30','утром семь минут'])
    assert.equal(readDurationMinutes(text),null,text);
});
