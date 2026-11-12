const test=require('node:test');const assert=require('node:assert/strict');
const {expandClientSource}=require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const {initialEntities}=require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const cases=[
 ['Запиши гульнарумухомидианову завтра на консультацию в 12:30.','Гульнара Мухамедьянова','гульнарумухомидианову'],
 ['На консультацию завтра в 12:30 запиши мухомидиановугульнару.','Гульнара Мухамедьянова','мухомидиановугульнару'],
 ['Запиши аделинумухомидианову завтра в 12:30 на консультацию.','Аделина Мухамедьянова','аделинумухомидианову'],
];
test('unlisted given-name forms locate the complete joined raw name in either order without rewriting the surname',()=>{
 for(const [raw,query,expected] of cases){
  assert.equal(expandClientSource(raw,query,{serviceQuery:'консультацию'}),expected);
  const value=initialEntities({intent:'prepareAppointment',query,serviceQuery:'консультация',date:'2099-01-05',time:'12:30'},raw,{date:'2099-01-05',time:'12:30'});
  assert.equal(value.query,expected);assert.equal(value.serviceQuery,'консультацию');assert.equal(value.date,'2099-01-05');assert.equal(value.time,'12:30');
 }
});
test('joined source location remains bounded and cannot discard ambiguous alternatives or protected performer text',()=>{
 for(const raw of ['Запиши гульнарумухомидианову или Гульнару Хабибуллину','Если гульнарумухомидианову','Запиши гульнарумухомидианову и аделинумухомидианову'])assert.equal(expandClientSource(raw,'Гульнара Мухамедьянова'),'');
 assert.equal(expandClientSource('Запиши гульнарумухомидианову','Гульнара',{staffQuery:'гульнарумухомидианову'}),'');
 assert.equal(expandClientSource('Запиши Гульнару-Мухомидианову','Гульнара'),'');
 assert.equal(expandClientSource('Запиши гульнаруabc','Гульнара'),'');
});
