const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../src/client/modules/printing.js'),'utf8');
const photosSource=fs.readFileSync(path.join(__dirname,'../src/client/modules/photos.js'),'utf8');
function fixture(t){
  const w=new JSDOM('<section id="patient-print"></section>',{url:'http://print.example.test',runScripts:'outside-only'}).window;t.after(()=>w.close());w.eval(source);
  const state={workspace:{members:[{accountId:'staff',displayName:'Тестовый сотрудник'}]},account:{id:'owner',displayName:'Владелец'},SERVICE_CATEGORIES:[{id:'consultation',title:'Консультации'},{id:'care',title:'Уходовые услуги'}],services:[{id:'s1',name:'ИЗМЕНЁННЫЙ КАТАЛОГ',price:99999}]};
  const actions={$:s=>w.document.querySelector(s),formatDate:d=>d,formatMinutes:n=>n+' мин.',roomName:id=>id==='main'?'Основной кабинет':''};w.eval(photosSource);Object.assign(actions,w.createPhotos(state,actions),w.createPrinting(state,actions));
  const p={id:'p',name:'Вымышленный клиент',phone:'+7 900 000-00-00',birth:'1990-01-02',allergies:'',notes:'',visits:[],appointments:[]};
  return {w,state,actions,p,root:actions.$('#patient-print'),render(){actions.buildPrintCard(p);}};
}
function service(id='s1',overrides={}){return {id,name:'Консультация',category:'consultation',product:'',duration:30,price:1000,...overrides};}
test('optional patient birth date accepts missing or empty values but rejects invalid calendar dates',()=>{
  const {validateState}=require('../src/server/modules/cabinet/validation.cjs');
  for(const birth of [undefined,'','1990-01-02','2000-02-29'])assert.doesNotThrow(()=>validateState({revision:0,patients:[{id:'birth-test',name:'Synthetic',birth,visits:[],appointments:[]}],services:[]}));
  for(const birth of ['1990-02-30','2001-02-29','not-a-date',null])assert.throws(()=>validateState({revision:0,patients:[{id:'birth-test',name:'Synthetic',birth,visits:[],appointments:[]}],services:[]}),/Некорректная дата/);
});
test('print includes populated birth date or an explicit missing-date placeholder',t=>{
  const h=fixture(t);h.render();assert.match(h.root.textContent,/Дата рождения1990-01-02/);
  h.p.birth='';h.render();assert.match(h.root.textContent,/Дата рожденияНе указано/);assert.doesNotMatch(h.root.textContent,/1990-01-02/);
  delete h.p.birth;h.render();assert.match(h.root.textContent,/Дата рожденияНе указано/);assert.doesNotMatch(h.root.textContent,/1990-01-02/);
});
test('print uses complete saved procedure snapshots, including duplicate names and zero prices',t=>{
  const h=fixture(t);h.p.visits=[{id:'v',date:'2026-10-01',procedure:'Консультация + Консультация',type:'Консультации',serviceItems:[service(),service('s2',{product:'Средство по снимку',duration:45,price:0})],photos:[]}];h.render();
  const rows=[...h.root.querySelectorAll('.print-service-row')];assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.cells[0].textContent),['Консультация','Консультация']);
  assert.equal(rows[1].cells[1].textContent,'Консультации');assert.equal(rows[1].cells[2].textContent,'45 мин.');assert.match(rows[1].cells[3].textContent,/0.*₽/);assert.doesNotMatch(h.root.textContent,/Средство по снимку/);
  assert.doesNotMatch(h.root.textContent,/ИЗМЕНЁННЫЙ КАТАЛОГ|99999|Консультация \+ Консультация/);assert.equal(h.root.querySelector('h3')?.textContent,'Телефон');
  assert.match(h.root.textContent,/не подтверждают оплату/);assert.equal(h.root.querySelectorAll('thead th[scope="col"]').length,4);
});
test('print includes actual time, duration and staff; linked room is explicitly planned',t=>{
  const h=fixture(t);h.p.visits=[{id:'v',date:'2026-10-01',time:'14:15',duration:90,staffId:'staff',appointmentId:'a',procedure:'Уход',photos:[]}];
  h.p.appointments=[{id:'a',status:'completed',completedVisitId:'v',roomId:'main',time:'14:00',duration:120,staffId:'owner',service:'НЕ ПЕЧАТАТЬ ПЛАН'}];h.render();
  assert.match(h.root.textContent,/14:15/);assert.match(h.root.textContent,/90 мин\./);assert.match(h.root.textContent,/Тестовый сотрудник/);assert.match(h.root.textContent,/Кабинет по записиОсновной кабинет/);
  assert.doesNotMatch(h.root.textContent,/14:00|120 мин\.|НЕ ПЕЧАТАТЬ ПЛАН/);
  h.p.visits[0].roomId='main';h.render();assert.doesNotMatch(h.root.textContent,/Кабинет по записи/);assert.match(h.root.textContent,/КабинетОсновной кабинет/);
});
test('print never substitutes planned procedures or time for a factual legacy visit',t=>{
  const h=fixture(t);h.p.visits=[{id:'v',date:'2026-10-01',procedure:'Старая услуга',appointmentId:'a',photos:[]}];
  h.p.appointments=[{id:'a',status:'completed',completedVisitId:'v',time:'16:30',duration:120,serviceItems:[service()],roomId:'main'}];h.render();
  assert.match(h.root.textContent,/Старая услуга/);assert.doesNotMatch(h.root.textContent,/16:30|120 мин\.|Консультация|Цена по каталогу/);assert.equal(h.root.querySelector('.print-services'),null);
  h.p.appointments[0].completedVisitId='another';h.render();assert.doesNotMatch(h.root.textContent,/Основной кабинет/);
  h.p.appointments[0].completedVisitId='v';h.p.appointments[0].status='scheduled';h.render();assert.doesNotMatch(h.root.textContent,/Основной кабинет/);
});
test('print retains legacy details and actual overrides while removing empty and duplicate fields',t=>{
  const h=fixture(t),v={id:'v',date:'2026-10-01',procedure:'Старая услуга + Консультация',type:'Старый тип',reaction:'Старая реакция',product:'Фактическое средство',zones:'Лицо',amount:'',notes:'Заметка',serviceItems:[service()],photos:[]};h.p.visits=[v];h.render();
  for(const s of ['Старая услуга','Заметка'])assert.ok(h.root.textContent.includes(s),s);
  assert.doesNotMatch(h.root.textContent,/Количество|Старый тип|Старая реакция|Фактическое средство|Лицо|Важная информация/);
  v.procedure='Консультация';v.type='Консультации';v.serviceItems[0].product='Фактическое средство';h.render();
  assert.equal([...h.root.querySelectorAll('h3')].some(n=>n.textContent==='Тип'||n.textContent==='Препарат / средство'),false);
  v.procedure='Произвольное описание';h.render();assert.match(h.root.textContent,/Произвольное описание/);
});
test('print groups protected photographs three per row, retaining full captions and literal text',t=>{
  const h=fixture(t),long='НАЧАЛО\n'+('Подробная рекомендация\n'.repeat(400))+'КОНЕЦ',caption='<img src=x onerror=alert(1)> '+long;
  h.p.visits=[{id:'v',date:'2026-10-01',procedure:'Уход',notes:long,photos:Array.from({length:6},(_,i)=>({data:'/api/photos/'+String(i).padStart(32,'0'),caption}))}];h.render();
  assert.deepEqual([...h.root.querySelectorAll('.print-photo-row')].map(r=>r.children.length),[3,3]);assert.equal(h.root.querySelectorAll('img').length,6);
  assert.equal(h.root.querySelectorAll('.print-photo-row-long').length,2);
  assert.ok(h.root.textContent.includes(long));assert.equal(h.root.querySelector('figcaption').textContent,caption);assert.equal(h.root.querySelectorAll('[onerror]').length,0);
  h.p.visits[0].photos[0].data='https://external.example.test/track';h.render();assert.equal(h.root.querySelector('img').getAttribute('src'),null);
});
test('print sorts factual visits by date and time and does not expose unresolvable identifiers',t=>{
  const h=fixture(t);h.p.visits=[{id:'v1',date:'2026-10-01',time:'09:00',procedure:'Раннее посещение',staffId:'SECRET_STAFF_ID',roomId:'SECRET_ROOM_ID',photos:[]},{id:'v2',date:'2026-10-01',time:'17:00',procedure:'Позднее посещение',photos:[]}];
  h.p.appointments=[{id:'future',date:'2030-01-01',service:'БУДУЩАЯ ЗАПИСЬ'}];h.render();
  assert.match(h.root.querySelector('.print-visit h2').textContent,/Позднее посещение/);assert.match(h.root.textContent,/Имя недоступно|Название недоступно/);assert.doesNotMatch(h.root.textContent,/SECRET_|БУДУЩАЯ ЗАПИСЬ/);
});
