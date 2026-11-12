const test=require('node:test');
const assert=require('node:assert/strict');
const {initialTemporalConstraints}=require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const clock={date:'2026-10-16',hour:10,minute:0};
const rows=[
  ['spaced half-hour','в пол третьего дня','14:30'],
  ['declined half-hour','в половине третьего дня','14:30'],
  ['quarter-hour','в четверть третьего дня','14:15'],
  ['minutes before an hour','на без десяти шесть вечера','17:50'],
  ['explicit labelled minutes','в четырнадцать часов пятнадцать минут','14:15'],
  ['joined half-hour','в полтретьего дня','14:30'],
  ['oversized minute token','в четырнадцать часов 100000 минут',null],
  ['oversized hour token','в 100000 часов',null],
  ['unsupported seconds','в четырнадцать часов пятнадцать секунд',null],
];
for(const [id,clause,time] of rows)test('initial clock grammar bridge '+id,()=>{
  const text='Запиши завтра '+clause+' Анну Семёнову на 30 минут.';
  assert.deepEqual(initialTemporalConstraints({intent:'prepareAppointment'},text,clock),{date:'2026-10-17',time},text);
});
