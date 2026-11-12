const test=require('node:test'),assert=require('node:assert/strict');
const {initialEntities,entityText}=require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const cases=[['Первичная консультация','Запиши Анну Семёнову завтра в 12:30 на первичную консултацию.','первичную консултацию'],['Миндальный пилинг','Запиши Анну Семёнову завтра в 12:30 на миндалный пилинг.','миндалный пилинг'],['Миндальный пилинг','Запиши Анну Семёнову завтра в 12:30 на миндальныйпилинг.','миндальныйпилинг']];
test('model canonical service text only locates the full original typo or joined source; it never replaces it',()=>{
 for(const [serviceQuery,raw,expected] of cases){const result=initialEntities({intent:'prepareAppointment',query:'Анна Семёнова',serviceQuery,date:'2099-01-05',time:'12:30'},raw,{date:'2099-01-05',time:'12:30'});assert.equal(result.serviceQuery,expected);assert.equal(result.query,'Анну Семёнову');assert.equal(result.date,'2099-01-05');assert.equal(result.time,'12:30');}
});
test('service provenance rejects different numeric qualifiers and distant or incomplete invented titles',()=>{
 for(const [query,raw] of [['Пилинг 15%','Запиши на пилинг 5%.'],['Пилинг1.5','Запиши на пилинг1,5.'],['Миндальный пилинг','Запиши на молочный пилинг.'],['Миндальный пилинг','Запиши на минд.']])assert.equal(entityText(raw,query,'service'),'');
});

test('initial service source cannot drop negation or alternatives; a final affirmative correction remains available',()=>{
 for(const raw of ['Запиши Анну не на миндалный пилинг завтра.','Запиши Анну не на миндальный пилинг завтра.','Запиши Анну на миндальный пилинг или молочный пилинг.']){const r=initialEntities({intent:'prepareAppointment',query:'Анна',serviceQuery:'Миндальный пилинг'},raw);assert.equal(r.serviceQuery,undefined,raw);}
 const r=initialEntities({intent:'prepareAppointment',query:'Анна',serviceQuery:'Молочный пилинг'},'Запиши Анну не на миндальный пилинг, а на молочный пилинг.');assert.equal(r.serviceQuery,'молочный пилинг');
});
