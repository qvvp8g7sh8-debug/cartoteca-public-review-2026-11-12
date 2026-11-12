const test=require('node:test');
const assert=require('node:assert/strict');
const {intentRequestConstraints}=require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const {initialTemporalConstraints}=require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const clock={date:'2026-10-16',hour:10,minute:0};
function makeCases(){
  const dates=[['завтра','2026-10-17'],['18 октября 2026 года','2026-10-18'],['на 2026-10-19','2026-10-19'],['на 20.10.2026','2026-10-20']];
  const clocks=[['в 14:30','14:30'],['в девять утра','09:00'],['в шесть часов вечера','18:00'],['в 14, 30','14:30']];
  const durations=[['на 30 минут',30],['длительностью сорок пять минут',45],['на полчаса',30]],rows=[];
  for(let d=0;d<durations.length;d++)for(let t=0;t<clocks.length;t++)for(let order=0;order<4;order++){
    const date=dates[(d+t+order)%dates.length],clock=clocks[t],duration=durations[d],staff=order%2?'на первичную консультацию к Ирине Орловой':'к Ирине Орловой на первичную консультацию';
    const texts=[`Запиши Анну Семёнову ${staff} ${date[0]} ${clock[0]} ${duration[0]}.`,`Запиши Анну Семёнову ${date[0]} ${duration[0]} ${clock[0]} ${staff}.`,`${date[0]}, ${clock[0]}, запиши Анну Семёнову ${staff} ${duration[0]}.`,`Запиши ${date[0]} ${clock[0]} Анну Семёнову ${duration[0]} ${staff}.`];
    rows.push({id:'case-'+String(rows.length+1).padStart(2,'0'),order,durationForm:d,clockForm:t,text:texts[order],expected:{duration:duration[1],date:date[1],time:clock[1]}});
  }
  return rows;
}
for(const row of makeCases())test('initial clause order '+row.id,()=>{
  const intent={intent:'prepareAppointment',date:'2026-10-25',time:'17:00',duration:60};
  const result={...intentRequestConstraints(intent,row.text),...initialTemporalConstraints(intent,row.text,clock)};
  assert.deepEqual(result,row.expected,row.text);
});
