const test=require('node:test');
const assert=require('node:assert/strict');
const {parseDateText}=require('../src/server/modules/assistant/language/time/temporal.cjs');
const {dialogueFixture,day}=require('./helpers/assistant-dialogue-fixture.cjs');
const clock={date:day,hour:8,minute:0};

test('exact dates do not hide inside words or choose an adjacent conflicting year',()=>{
  for(const text of ['prefix2099-01-06','2099-01-06suffix','текст2099-01-06','2099-01-06текст','2099-01-06, 2100','2099-01-06 2100','2100 2099-01-06','06.01.2099, 2100','6 января 2099, 2100','6 января 2099 года, 2100 года','6 января, 2100'])
    assert.equal(parseDateText(text,clock),null,text);
});

test('date fields retain selected data and manual-save boundary after embedded invalid date text',()=>{
  for(const text of ['prefix2099-01-06','2099-01-06suffix','текст2099-01-06','2099-01-06текст','2099-01-06, 2100']){
    const f=dialogueFixture();const first=f.start({query:'Анну Семенову',serviceQuery:'Чистка',time:'10:00'});
    assert.equal(first.dialogue.step,'date');const entry=f.flow.get(f.c,f.member,f.state,first.dialogue.id),before=structuredClone(entry.data);
    try{f.answer({text});}catch(error){assert.equal(error.status,400);}
    assert.deepEqual(entry.data,before,text);assert.equal(f.result.action,null);assert.equal(f.patients[0].appointments.length,0);
  }
});

test('valid explicit dates keep punctuation, datetime context and four-digit duration distinct from a year',()=>{
  for(const text of ['2099-01-06','на 2099-01-06.','(2099-01-06)','06.01.2099','6 января 2099 года','2099-01-06 в 14:30','Запиши Анну на 2099-01-06 на 1440 минут','Запиши Анну 6 января 2099 года на 1440 минут'])
    assert.equal(parseDateText(text,clock),'2099-01-06',text);
});

test('conflicting years cannot partially change an already reviewed appointment',()=>{
  for(const text of ['дата на 2099-01-06, 2100','поменяй дату на 06.01.2099, 2100','дата на 6 января 2099 года, 2100 года']){
    const f=dialogueFixture();const first=f.start({query:'Анну Семенову',serviceQuery:'Чистка',date:day,time:'10:00'});
    assert.equal(first.dialogue.step,'review');const entry=f.flow.get(f.c,f.member,f.state,first.dialogue.id),before=structuredClone(entry.data);
    const {result}=f.answer({text});
    assert.deepEqual(entry.data,before,text);assert.equal(result.dialogue.step,'review');
    assert.equal(result.action,null);assert.equal(f.patients[0].appointments.length,0);
  }
});
