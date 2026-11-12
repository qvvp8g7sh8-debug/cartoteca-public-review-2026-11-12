const test=require('node:test');
const assert=require('node:assert/strict');
const {dialogueFixture,day}=require('./helpers/assistant-dialogue-fixture.cjs');
const {availabilityAction}=require('../src/server/modules/assistant/actions/availability-action.cjs');
function search(f,extra={}){const intent={intent:'availability',date:day,duration:30,...extra};const result=availabilityAction(f.c,intent,f.clock);const ticket=f.flow.beginCommand(f.c,f.member,f.state);return{original:result,view:f.flow.startAvailability(f.c,result,f.state,f.member,f.clock,ticket,intent)};}

test('read-only availability never promises assistant choice or form handoff when preparation is disabled',()=>{
  const f=dialogueFixture();f.state.policy.commands.prepareAppointment=false;
  const {original,view}=search(f);
  assert.match(original.text,/Выберите время/);
  assert.match(view.text,/только просмотр/iu);
  assert.match(view.text,/30 мин/u);assert.match(view.text,/5 января 2099 года/u);assert.equal(view.availability.from,day);assert.doesNotMatch(view.text,/\d{4}-\d{2}-\d{2}/u);
  assert.match(view.text,/календар/iu);assert.match(view.text,/не резервируются/iu);
  assert.doesNotMatch(view.text,/Выберите время|сохраните|в форме|подготовлю.*форм/iu);
  assert.equal(view.action,null);assert.equal(view.dialogue,undefined);assert.equal(view.slots,undefined);
  assert.ok(view.readOnlySlots.length>0&&view.readOnlySlots.length<=12);
  for(const slot of view.readOnlySlots)assert.deepEqual(Object.keys(slot).sort(),['date','duration','endTime','staffName','time']);
  assert.doesNotMatch(JSON.stringify(view.readOnlySlots),/staffId|roomId|serviceIds|patientId/);
  assert.equal(f.patients[0].appointments.length,0);
});

test('read-only availability reports the requested bounded period and duration without implying reservation',()=>{
  const f=dialogueFixture();f.state.policy.commands.prepareAppointment=false;
  const {view}=search(f,{endDate:'2099-01-06',duration:45});
  assert.match(view.text,/с 5 января 2099 года по 6 января 2099 года/u);assert.equal(view.availability.from,day);assert.equal(view.availability.to,'2099-01-06');assert.match(view.text,/45 мин/u);assert.doesNotMatch(view.text,/\d{4}-\d{2}-\d{2}/u);
  assert.match(view.text,/только просмотр/iu);assert.match(view.text,/не резервируются/iu);
  assert.equal(view.dialogue,undefined);assert.equal(view.action,null);assert.equal(f.patients[0].appointments.length,0);
});

test('enabled appointment preparation keeps current bounded choices and unavailable search keeps its original explanation',()=>{
  const f=dialogueFixture();const {original,view}=search(f);
  assert.equal(view.dialogue.step,'availability');assert.ok(view.dialogue.options.length>0);
  assert.equal(view.dialogue.prompt,original.text);assert.equal(view.readOnlySlots,undefined);
  f.state.policy.commands.prepareAppointment=false;
  const empty={text:'На выбранную дату график ещё не задан.',action:null,slots:[],availability:{from:day,to:day,duration:30}};
  const noSlots=f.flow.startAvailability(f.c,empty,f.state,f.member,f.clock,undefined,{intent:'availability',date:day});
  assert.equal(noSlots,empty);assert.equal(f.patients[0].appointments.length,0);
});

const {readOnlyAvailabilityText}=require('../src/server/modules/assistant/actions/readonly-availability.cjs');
test('read-only human dates retain year boundaries and never normalize an invalid civil date',()=>{
  const value={slots:[{date:'2099-12-31',duration:30}],availability:{from:'2099-12-31',to:'2100-01-01',duration:30}};
  assert.match(readOnlyAvailabilityText(value),/с 31 декабря 2099 года по 1 января 2100 года/u);
  const invalid=readOnlyAvailabilityText({slots:[{date:'2026-02-30',duration:30}]});
  assert.doesNotMatch(invalid,/марта|февраля|2026-02-30/u);
});
