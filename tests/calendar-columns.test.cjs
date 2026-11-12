// Prepared regression coverage for the next explicitly authorized verification stage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(role = 'owner') {
  const state = { multiUser: true, calendarMode: 'day', calendarGrouping: 'staff',
    selectedScheduleStaff: '', selectedRoomId: '', calendarAnchorDate: new Date(2026,9,12),
    account: { id: 'a', displayName: 'Анна' }, workspace: { rooms: [
      {id:'r1',name:'Кабинет 1',active:true,staffIds:['a']},
      {id:'r2',name:'Кабинет 2',active:true,staffIds:['b']},
    ] } };
  const members = [{accountId:'a',displayName:'Анна'},{accountId:'b',displayName:'Елена'}];
  const records = [{id:'one',date:'2026-10-12',time:'10:00',duration:60,staffId:'a',roomId:'r1'},
    {id:'two',date:'2026-10-12',time:'10:30',duration:120,staffId:'b',roomId:'r2'}];
  const actions = { accountId:()=> 'a', accountRole:()=>role, calendarScheduleMembers:()=>role==='cosmetologist' ? members.slice(0,1) : members,
    calendarEvents:()=>records, isoDate:()=> '2026-10-12', roomName:(id)=>state.workspace.rooms.find(r=>r.id===id)?.name || '',
    esc:(s)=>String(s), setView:()=>{} };
  const source = fs.readFileSync(path.join(__dirname,'../src/client/modules/calendar-columns.js'),'utf8');
  const context = vm.createContext({state,actions});
  vm.runInContext(source+'\nthis.feature=createCalendarColumns(state,actions);',context);
  Object.assign(actions,context.feature);
  return {state,actions,records};
}
test('overlapping appointments belong to distinct daily staff columns, and weekly selection preserves date',()=>{
  const f=fixture(); f.actions.normalizeCalendarSelection();
  const columns=f.actions.calendarColumns([f.state.calendarAnchorDate]);
  assert.equal(columns.length,2);
  assert.equal(f.actions.calendarColumnEvents(f.records,columns[0])[0].id,'one');
  assert.equal(f.actions.calendarColumnEvents(f.records,columns[1])[0].id,'two');
  const date=f.state.calendarAnchorDate;
  f.actions.setCalendarMode('week');
  assert.equal(f.state.selectedScheduleStaff,'a');
  assert.equal(f.state.calendarAnchorDate,date);
  f.actions.setCalendarMode('day');
  assert.equal(f.state.selectedScheduleStaff,'');
});
test('room grouping offers a single room for the week and initializes both form identifiers',()=>{
  const f=fixture(); f.actions.changeCalendarGrouping('rooms');
  const columns=f.actions.calendarColumns([f.state.calendarAnchorDate]);
  assert.equal(f.actions.calendarColumnEvents(f.records,columns[1])[0].id,'two');
  const input=f.actions.calendarNewAppointment({dataset:{slotRoom:'r2',slotDate:'2026-10-12',slotTime:'10:30'}});
  assert.equal(input.staffId,'b'); assert.equal(input.roomId,'r2'); assert.equal(input.time,'10:30');
  f.actions.setCalendarMode('week');
  assert.equal(f.state.selectedRoomId,'r1');
  assert.doesNotMatch(f.actions.calendarSelectionHtml(),/Все кабинеты/);
});
test('employee sees own column and anonymous room occupancy without another employee identity',()=>{
  const f=fixture('cosmetologist');
  f.state.workspace.rooms=[{id:'shared',name:'Общий кабинет',active:true}];
  f.records.splice(0,f.records.length,{id:'own',date:'2026-10-12',staffId:'a',roomId:'shared'},
    {busy:true,date:'2026-10-12',roomId:'shared',time:'10:30',duration:60});
  f.actions.normalizeCalendarSelection();
  let columns=f.actions.calendarColumns([f.state.calendarAnchorDate]);
  assert.equal(columns.length,1); assert.equal(f.actions.calendarColumnEvents(f.records,columns[0]).length,2);
  assert.doesNotMatch(f.actions.calendarSelectionHtml(),/Елена|Все сотрудники/);
  f.actions.changeCalendarGrouping('rooms');
  columns=f.actions.calendarColumns([f.state.calendarAnchorDate]);
  assert.equal(columns[0].staffIds[0],'a');
  assert.equal(f.actions.calendarNewAppointment({dataset:{slotRoom:'shared'}}).staffId,'a');
});
test('existing records keep an inactive or unavailable employee visible in the day',()=>{
  const f=fixture(); f.records.push({id:'past-staff',date:'2026-10-12',staffId:'old'});
  const columns=f.actions.calendarColumns([f.state.calendarAnchorDate]);
  assert.equal(columns.length,3); assert.equal(columns[2].staffId,'old');
  assert.equal(f.actions.calendarColumnEvents(f.records,columns[2])[0].id,'past-staff');
});
