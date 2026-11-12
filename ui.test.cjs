const { assetPath } = require('./tests/helpers/interface-assets.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = __dirname;
const { createServer } = require(path.join(root, 'serve.cjs'));
const credentials = { email: 'ui@example.test', password: 'UI-test-password-2026' };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(condition) {
  const deadline = Date.now() + 6000;
  while (!condition()) { if (Date.now() > deadline) throw Error('Timed out waiting for UI'); await pause(); }
}
async function harness(t, signedIn = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-ui-'));
  const server = createServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const calls = [], windows = [];
  const h = {
    dir,
    failSave: false,
    calls,
    async request(route, options = {}) {
      if (h.failSave && route === '/api/cabinet' && options.method === 'PUT') throw new TypeError('Failed to fetch');
      const result = await fetch(base + route, { ...options, headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1', Origin: base, Cookie: cookie, ...options.headers } });
      const set = result.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      calls.push({ route, method: options.method || 'GET', status: result.status });
      return result;
    },
    dom(page, storage = {}, confirm = true, width = 1024) {
      const errors = [], alerts = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
      const dom = new JSDOM(fs.readFileSync(assetPath(page + '.html'), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole });
      const w = dom.window;
      w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
      w.fetch = h.request;
      w.AbortController = AbortController;
      w.structuredClone = structuredClone;
      w.confirm = () => confirm;
      w.alert = text => alerts.push(text);
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, JSON.stringify(value));
      if(page==='index')w.eval(fs.readFileSync(assetPath('security.js'),'utf8'));
      (page === 'index' ? require('./tests/helpers/client-bundle.cjs').evaluateClient(w) : w.eval(fs.readFileSync(assetPath(page === 'index' ? 'app.js' : 'login.js'), 'utf8')));
      windows.push(w);
      return { w, errors, alerts, $: selector => w.document.querySelector(selector) };
    }
  };
  if (signedIn) await h.request('/api/auth/setup', { method: 'POST', body: JSON.stringify(credentials) });
  t.after(async () => {
    for (const w of windows) w.close();
    await new Promise(resolve => server.close(resolve));
    if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('cartoteca-ui-'))fs.rmSync(dir,{recursive:true,force:true});
  });
  return h;
}
const oldPatients = [{ id: 'p-ui', name: 'Тест переноса', phone: '', visits: [{ id: 'v-ui', date: '2026-09-15', photos: [{ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==' }] }], appointments: [{ id: 'a-ui', date: '2026-09-15', time: '09:15', duration: 90 }] }];
const oldServices = [{ id: 's-ui', name: 'Услуга', duration: '60 минут', price: 1000, product: 'Тестовое средство' }];
const legacy = { 'cosmetology-card-demo-v1': oldPatients, 'cosmetology-services-v1': oldServices };

async function printFixture(t,width=390,photos=false){
 const h=await harness(t);
 const patients=[{id:'print-a',name:'Print Alpha',phone:'Test telephone',birth:'1990-01-02',allergies:'Test allergies',notes:'Test patient notes',visits:[{id:'visit-first',date:'2026-09-14',type:'Test type',procedure:'Completed procedure',product:'Test product',amount:'Test amount',zones:'Test zones',reaction:'Test reaction',notes:'Visit notes',photos:photos?[oldPatients[0].visits[0].photos[0],oldPatients[0].visits[0].photos[0]]:[]},{id:'visit-second',date:'2026-09-13',procedure:'Earlier procedure',photos:[]}],appointments:[{id:'future',date:'2030-01-01',time:'10:00',service:'FUTURE-APPOINTMENT-EXCLUDED'}]},{id:'print-b',name:'Print Beta',notes:'OTHER-PATIENT-PRIVATE',visits:[],appointments:[]}];
 assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({patients,services:[],revision:0})})).status,200);
 const ui=h.dom('index',{},true,width);await until(()=>!ui.w.document.body.classList.contains('app-loading'));ui.$('[data-view="clients"]').click();ui.$('[data-client-filter="all"]').click();ui.$('[data-patient="print-a"]').click();
 const prints=[];ui.w.print=()=>prints.push(ui.$('#patient-print').textContent);return {h,ui,prints,patients};
}
test('clients scroll as one alphabetic list and card search stays empty until typing',async t=>{
 const h=await harness(t);
 const patients=[
  {id:'boris',name:'Борис Антонов',phone:'+7 900 000-00-01',visits:[],appointments:[{id:'future',date:'2030-01-01',time:'10:00',duration:60,service:'Тест'}]},
  {id:'anna-y',name:'Анна Яковлева',phone:'+7 900 000-00-02',visits:[{id:'recent',date:new Date().toLocaleDateString('en-CA'),procedure:'Тест',photos:[]}],appointments:[]},
  {id:'anna-b',name:'Анна Белова',phone:'+7 900 000-00-03',visits:[{id:'old',date:'2020-01-01',procedure:'Тест',photos:[]}],appointments:[]}
 ];
 assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({patients,services:[],revision:0})})).status,200);
 const ui=h.dom('index',{},true,1440);await until(()=>!ui.w.document.body.classList.contains('app-loading'));
 ui.$('[data-view="clients"]').click();
 assert.equal(ui.$('.pager'),null);
 assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Борис Антонов']);
 ui.$('[data-client-filter="all"]').click();
 assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Анна Белова','Анна Яковлева','Борис Антонов']);
 ui.$('[data-patient-sort="last"]').click();
 assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Антонов Борис','Белова Анна','Яковлева Анна']);
 ui.$('[data-client-filter="appointment"]').click();assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Антонов Борис']);
 ui.$('[data-client-filter="recent"]').click();assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Яковлева Анна']);
 ui.$('[data-client-filter="inactive"]').click();assert.deepEqual([...ui.w.document.querySelectorAll('.client-list-row strong')].map(x=>x.textContent),['Антонов Борис','Белова Анна']);
 ui.$('[data-client-filter="all"]').click();ui.$('[data-view="card"]').click();assert.equal(ui.$('#patient-list').children.length,0);
 ui.$('#search').value='Яковлева';ui.$('#search').dispatchEvent(new ui.w.Event('input',{bubbles:true}));
 assert.deepEqual([...ui.w.document.querySelectorAll('.search-result-row strong')].map(x=>x.textContent),['Анна Яковлева']);
 assert.deepEqual(ui.errors,[]);
});
test('simplified visit editing preserves old type and reaction at mobile and desktop widths',async t=>{
 for(const width of [390,1440]){
  const {h,ui}=await printFixture(t,width,false),edit=ui.$('[data-edit-visit="visit-first"]');edit.closest('details').querySelector('summary').click();edit.click();
  assert.equal(ui.$('[name="type"]'),null);assert.equal(ui.$('[name="reaction"]'),null);assert.equal(ui.$('.visit-duration-field').nextElementSibling,ui.$('#visit-procedures-field'));
  assert.doesNotMatch(ui.$('#form-content').textContent,/Фото уменьшаются|Реакция после визита/);
  ui.$('[name="notes"]').value='Updated visit notes';ui.$('#editor-form').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!ui.$('#editor').open);
  const saved=await (await h.request('/api/cabinet')).json(),visit=saved.patients.find(p=>p.id==='print-a').visits.find(v=>v.id==='visit-first');
  assert.equal(visit.type,'Test type');assert.equal(visit.reaction,'Test reaction');assert.equal(visit.notes,'Updated visit notes');assert.equal(visit.procedure,'Completed procedure');
  assert.doesNotMatch(ui.$('#patient-print').textContent,/Test type|Test reaction/);assert.deepEqual(ui.errors,[]);
 }
});

test('visit history uses compact collapsed rows without losing details, photographs or print content',async t=>{
 for(const width of [390,1440]){
  const {ui}=await printFixture(t,width,true),visits=[...ui.w.document.querySelectorAll('.visit-accordion')];
  assert.equal(visits.length,2);assert.ok(visits.every(v=>!v.open));
  assert.match(visits[0].querySelector('summary').textContent,/14 сентября 2026/);assert.match(visits[0].querySelector('summary').textContent,/Completed procedure/);
  assert.doesNotMatch(visits[0].querySelector('summary').textContent,/Test product|Test reaction|Visit notes/);
  assert.equal(visits[0].querySelectorAll('.thumbs img').length,2);
  visits[0].querySelector('summary').click();assert.equal(visits[0].open,true);assert.equal(ui.$('#editor').open,false);assert.equal(visits[1].open,false);
  assert.doesNotMatch(visits[0].querySelector('.visit-body').textContent,/Test product/);
  visits[0].querySelector('[data-edit-visit]').click();assert.equal(ui.$('#dialog-title').textContent,'Изменить посещение');assert.equal(ui.$('[name="notes"]').value,'Visit notes');ui.$('#cancel-editor').click();
  visits[0].querySelector('summary').click();assert.equal(visits[0].open,false);
  for(const value of ['Completed procedure','Visit notes','Earlier procedure'])assert.ok(ui.$('#patient-print').textContent.includes(value));
  assert.doesNotMatch(ui.$('#patient-print').textContent,/Test product|Test reaction/);
  const styles=ui.w.document.createElement('style');styles.textContent=fs.readFileSync(assetPath('style.css'),'utf8')+'\n'+fs.readFileSync(assetPath('ui-extra.css'),'utf8');ui.w.document.head.append(styles);
  assert.equal(ui.w.getComputedStyle(ui.w.document.documentElement).getPropertyValue('--compact-row-height'),'58px');
  const historyHeight=ui.w.getComputedStyle(visits[0].querySelector('summary')).minHeight;
  ui.$('[data-view="settings"]').click();
  // A real v2 settings wrapper uses the same native header style as history.
  const probe=ui.w.document.createElement('details');probe.className='settings-section settings-accordion compact-accordion';probe.innerHTML='<summary>Мой профиль</summary>';ui.w.document.body.append(probe);
  assert.equal(ui.w.getComputedStyle(probe.querySelector('summary')).minHeight,historyHeight);assert.ok(historyHeight.includes('--compact-row-height'));
  assert.deepEqual(ui.errors,[]);
 }
});

test('history show-more click is wired and does not alter saved visits',async t=>{
 const h=await harness(t),visits=Array.from({length:11},(_,i)=>({id:'page-'+i,date:'2026-09-'+String(i+1).padStart(2,'0'),procedure:'Synthetic '+i,photos:[]}));
 assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({revision:0,services:[],patients:[{id:'page-p',name:'Synthetic',phone:'',visits,appointments:[]}]})})).status,200);
 const ui=h.dom('index');await until(()=>!ui.w.document.body.classList.contains('app-loading'));
 ui.$('[data-view="clients"]').click();ui.$('[data-client-filter="all"]').click();ui.$('[data-patient="page-p"]').click();
 await until(()=>ui.$('#more-visits'));
 assert.equal(ui.w.document.querySelectorAll('#visit-history-list .visit').length,5);
 const first=ui.$('#visit-history-list .visit');first.open=true;ui.$('#more-visits').click();
 assert.equal(ui.w.document.querySelectorAll('#visit-history-list .visit').length,10);assert.equal(first.open,true);
 ui.$('#more-visits').click();assert.equal(ui.$('#more-visits'),null);
 assert.equal(ui.w.document.querySelectorAll('#visit-history-list .visit').length,11);
 assert.equal((await (await h.request('/api/cabinet')).json()).patients[0].visits.length,11);assert.deepEqual(ui.errors,[]);
});

test('print contains only selected patient and factual visits on phone and desktop',async t=>{
 for(const width of [390,1440]){
  const {h,ui,prints}=await printFixture(t,width);assert.equal(ui.$('#export-data'),null);assert.equal(ui.$('#import-data'),null);assert.equal(ui.$('#import-input'),null);
  const calls=h.calls.length;ui.$('#print-patient').click();await until(()=>prints.length===1);
  for(const value of ['Print Alpha','Test telephone','Test allergies','Test patient notes','Completed procedure','Visit notes','Earlier procedure'])assert.ok(prints[0].includes(value),value);
  assert.doesNotMatch(prints[0],/Test product|Test amount|Test zones|Test reaction/);
  for(const value of ['Print Beta','OTHER-PATIENT-PRIVATE','FUTURE-APPOINTMENT-EXCLUDED','Скачать копию','Безопасность'])assert.equal(prints[0].includes(value),false,value);
  assert.equal(ui.$('#patient-print button'),null);assert.equal(ui.$('#patient-print input'),null);assert.equal(h.calls.slice(calls).some(c=>c.method!=='GET'),false);assert.deepEqual(ui.errors,[]);
 }
});
test('empty card prints; switching patient replaces every part of the printable DOM',async t=>{
 const {ui,prints}=await printFixture(t);ui.$('[data-view="clients"]').click();ui.$('[data-client-filter="all"]').click();assert.equal(ui.$('#patient-print').textContent,'');ui.$('[data-patient="print-b"]').click();ui.$('#print-patient').click();await until(()=>prints.length===1);
 assert.match(prints[0],/Print Beta/);assert.match(prints[0],/Посещений пока нет/);assert.equal(prints[0].includes('Alpha'),false);assert.equal(ui.$('#patient-print img'),null);
 ui.$('[data-view="settings"]').click();await until(()=>ui.$('.settings-panel')&&ui.$('[data-view="settings"]').getAttribute('aria-current')==='page');assert.equal(ui.$('#patient-print').textContent,'');ui.w.dispatchEvent(new ui.w.Event('beforeprint'));assert.equal(ui.$('#patient-print').textContent,'');assert.deepEqual(ui.errors,[]);
});
test('print reflects saved edits and retains full long text as text rather than markup',async t=>{
 const {ui,prints}=await printFixture(t);ui.$('[data-tab="profile"]').click();ui.$('#edit-profile').click();
 const long='LONG_START\n'+('Длинная строка и переносы.\n'.repeat(400))+'<img src=x onerror=alert(1)>\nLONG_END';
 ui.$('[name="notes"]').value=long;ui.$('#editor-form').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!ui.$('#editor').open);ui.$('#print-patient').click();await until(()=>prints.length===1);
 assert.ok(prints[0].includes(long));assert.equal(ui.$('#patient-print img'),null);assert.equal(prints[0].includes('Test patient notes'),false);assert.deepEqual(ui.errors,[]);
});
test('print waits for all photographs and preserves its DOM when print returns early',async t=>{
 const {ui,prints}=await printFixture(t,390,true);ui.$('#print-patient').click();const images=[...ui.w.document.querySelectorAll('#patient-print img')];assert.equal(images.length,2);assert.equal(prints.length,0);assert.equal(ui.$('#print-patient').disabled,true);
 Object.defineProperty(images[0],'naturalWidth',{value:100});images[0].dispatchEvent(new ui.w.Event('load'));await pause();assert.equal(prints.length,0);
 Object.defineProperty(images[1],'naturalWidth',{value:100});images[1].dispatchEvent(new ui.w.Event('load'));await until(()=>prints.length===1);assert.match(ui.$('#patient-print').textContent,/Print Alpha/);assert.equal(ui.$('#print-patient').disabled,false);assert.deepEqual(ui.errors,[]);
});
test('failed photograph blocks incomplete printing and provides retry feedback',async t=>{
 const {ui,prints}=await printFixture(t,390,true);ui.$('#print-patient').click();ui.$('#patient-print img').dispatchEvent(new ui.w.Event('error'));await until(()=>!ui.$('#print-patient').disabled);
 assert.equal(prints.length,0);assert.equal(ui.$('#print-status').hidden,false);assert.match(ui.$('#print-status').textContent,/Не удалось загрузить все фотографии/);assert.deepEqual(ui.errors,[]);
});
test('switching patients cancels outstanding photo preparation without printing the wrong person',async t=>{
 const {ui,prints}=await printFixture(t,390,true);ui.$('#print-patient').click();const oldImages=[...ui.w.document.querySelectorAll('#patient-print img')];ui.$('[data-view="clients"]').click();ui.$('[data-client-filter="all"]').click();ui.$('[data-patient="print-b"]').click();await pause();
 for(const img of oldImages){Object.defineProperty(img,'naturalWidth',{value:100});img.dispatchEvent(new ui.w.Event('load'));}await pause();assert.equal(prints.length,0);
 ui.$('#print-patient').click();await until(()=>prints.length===1);assert.match(prints[0],/Print Beta/);assert.equal(prints[0].includes('Alpha'),false);assert.deepEqual(ui.errors,[]);
});

test('legacy malicious service price cannot inject attributes into the editor',async t=>{
 const h=await harness(t);const store=require('./storage.cjs').createStorage(h.dir);
 try{store.db.prepare('INSERT INTO services(id,value) VALUES(?,?)').run('unsafe',store.encode({id:'unsafe',name:'Test',duration:'60 минут',price:'" data-injected="yes'}));store.set('initialized',true);}finally{store.close();}
 const ui=h.dom('index');await until(()=>!ui.w.document.body.classList.contains('app-loading'));
 ui.$('[data-view="services"]').click();ui.$('#toggle-service-edit').click();ui.$('[data-edit-service="unsafe"]').click();assert.equal(ui.$('[name="price"]').hasAttribute('data-injected'),false);assert.equal(ui.$('[data-injected]'),null);assert.deepEqual(ui.errors,[]);
});
test('services are grouped, selectable and create an appointment with combined duration',async t=>{
 const h=await harness(t);
 const patients=[{id:'p-services',name:'Клиент Услуг',phone:'',visits:[],appointments:[]}];
 const services=[
  {id:'clean',name:'Комбинированная чистка',category:'cleansing',duration:'90 минут',product:'Средство',price:3000},
  {id:'care',name:'Увлажняющий уход',category:'care',duration:'45 минут',product:'',price:2000},
  {id:'consult',name:'Консультация',category:'consultation',duration:'30 минут',product:'Не показывать',price:1000}
 ];
 assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({patients,services,revision:0})})).status,200);
 const ui=h.dom('index');await until(()=>!ui.w.document.body.classList.contains('app-loading'));
 ui.$('[data-view="services"]').click();
 assert.match(ui.$('.service-category-nav').textContent,/Без группы/);assert.doesNotMatch(ui.$('.service-category-nav').textContent,/Уходовые|Чистки/);assert.ok(ui.$('.service-category-panel'));
 assert.equal(ui.w.document.querySelectorAll('.service-category-count').length,0);assert.equal(ui.$('[data-select-service="consult"]').textContent.includes('Не показывать'),false);
 ui.$('[data-service-category-tab="other"]').click();assert.equal(ui.$('[data-service-category-tab="other"]').getAttribute('aria-pressed'),'true');ui.$('[data-select-service="clean"]').click();
 ui.$('[data-select-service="care"]').click();
 assert.equal(ui.w.document.querySelectorAll('.selected-service-card').length,2);assert.match(ui.$('.service-selection-total').textContent,/135 минут/);assert.match(ui.$('.service-selection-total').textContent,/5\s000 ₽/);assert.ok(ui.$('.service-create-stack').contains(ui.$('.service-selection-total')));
 ui.$('[data-remove-selected-service="care"]').click();assert.equal(ui.w.document.querySelectorAll('.selected-service-card').length,1);assert.equal(ui.$('[data-select-service="care"]').getAttribute('aria-pressed'),'false');ui.$('[data-select-service="care"]').click();
 ui.$('#create-appointment-from-services').click();
 assert.equal(ui.$('[name="service"]').value,'Комбинированная чистка + Увлажняющий уход');assert.equal(ui.$('[name="duration"]').value,'135');
 ui.$('[name="patientId"]').value='p-services';ui.$('[name="date"]').value='2026-10-10';ui.$('[name="time"]').value='12:15';
 ui.$('#editor-form').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!ui.$('#editor').open);
 const saved=await(await h.request('/api/cabinet')).json();assert.equal(saved.patients[0].appointments[0].duration,135);assert.equal(saved.patients[0].appointments[0].service,'Комбинированная чистка + Увлажняющий уход');
 assert.deepEqual(ui.errors,[]);
});
test('malformed imported appointments are rejected and preserve the current cabinet and usable UI',async t=>{
 const h=await harness(t);const good={patients:[{id:'existing',name:'Existing',visits:[],appointments:[]}],services:oldServices,revision:0};assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify(good)})).status,200);
 const ui=h.dom('index');await until(()=>!ui.w.document.body.classList.contains('app-loading'));
 const invalid=structuredClone(good);invalid.patients[0].appointments=[null];
 assert.equal(ui.$('#import-input'),null);assert.equal(ui.$('#import-data'),null);assert.equal(ui.$('#export-data'),null);
 assert.equal((await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify(invalid)})).status,400);
 const saved=await(await h.request('/api/cabinet')).json();assert.equal(saved.revision,1);assert.deepEqual(saved.patients,good.patients);
 ui.$('[data-view="clients"]').click();ui.$('[data-client-filter="all"]').click();assert.match(ui.$('#patient-list').textContent,/Existing/);assert.deepEqual(ui.errors,[]);
});

test('phone modes provide a real month overview and time-sorted daily list',async t=>{
  const h=await harness(t),date=new Date().toLocaleDateString('en-CA');
  await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({revision:0,patients:[{id:'p',name:'Test person',visits:[],appointments:[{id:'late',date,time:'14:30',duration:90},{id:'early',date,time:'09:15',duration:30}]}],services:[]})});
  const ui=h.dom('index',{},true,390);await until(()=>!ui.w.document.body.classList.contains('app-loading'));
  assert.equal(ui.w.document.querySelectorAll('.app-nav-item svg').length,5);
  assert.equal(ui.$('[data-view="calendar"]').getAttribute('aria-current'),'page');
  ui.$('[data-calendar-mode="month"]').click();
  assert.equal(ui.w.document.querySelectorAll('[data-overview-date]').length,42);
  assert.match(ui.$('[data-overview-date="'+date+'"]').textContent,/2/);
  ui.$('[data-overview-date="'+date+'"]').click();assert.equal(ui.$('[data-calendar-mode="day"]').getAttribute('aria-pressed'),'true');
  ui.$('[data-calendar-mode="list"]').click();
  assert.deepEqual([...ui.w.document.querySelectorAll('.agenda-event')].map(e=>e.dataset.appointmentId),['early','late']);
  assert.equal(ui.$('.agenda-event').style.height,'');
  ui.$('[data-appointment-id="late"]').click();await until(()=>ui.$('[data-edit-appointment-action]'));assert.match(ui.$('.appointment-action-summary').textContent,/14:30/);ui.$('[data-edit-appointment-action]').click();await until(()=>ui.$('[name="time"]'));assert.equal(ui.$('[name="time"]').value,'14:30');assert.equal(ui.$('[name="duration"]').value,'90');
  ui.$('#cancel-editor').click();
  const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);const next=tomorrow.toLocaleDateString('en-CA');
  ui.$('[data-calendar-date="'+next+'"]').click();assert.ok(ui.$('.appointment-agenda .empty'));
  ui.$('#calendar-new').click();assert.equal(ui.$('[name="date"]').value,next);
  assert.deepEqual(ui.errors,[]);
});

test('current time line appears only on the displayed current day and early-hours toggle remains available',async t=>{
  const h=await harness(t),ui=h.dom('index',{},true,375);await until(()=>!ui.w.document.body.classList.contains('app-loading'));
  ui.$('.early-hours-control [data-toggle-early-hours]').click();assert.equal(ui.w.document.querySelectorAll('.time-labels div').length,24);
  assert.equal(ui.$('.current-time').hidden,false);assert.match(ui.$('.current-time span').textContent,/^\d{2}:\d{2}$/);
  const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);
  ui.$('[data-calendar-date="'+tomorrow.toLocaleDateString('en-CA')+'"]').click();assert.equal(ui.$('.current-time').hidden,true);
  ui.$('[data-view="settings"]').click();await until(()=>ui.$('.settings-panel')&&ui.$('[data-view="settings"]').getAttribute('aria-current')==='page');assert.equal(ui.w.document.body.classList.contains('calendar-screen'),false);
  assert.equal(ui.$('[data-view="settings"]').getAttribute('aria-current'),'page');
  assert.deepEqual(ui.errors,[]);
});

test('mobile calendar uses hourly lines, exact minutes and lanes across hour boundaries', async t => {
  const h=await harness(t);
  const date=new Date().toLocaleDateString('en-CA');
  const appointments=[{id:'a',time:'10:30',duration:90},{id:'b',time:'11:00',duration:60},{id:'c',time:'11:30',duration:15},{id:'early',time:'06:30',duration:90},{id:'later',time:'12:00',duration:30}];
  await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({revision:0,patients:appointments.map((a,i)=>({id:'p'+i,name:'Test '+i,visits:[],appointments:[{...a,date,service:'Test'}]})),services:[]})});
  const ui=h.dom('index',{},true,375);await until(()=>!ui.w.document.body.classList.contains('app-loading'));
  assert.equal(ui.$('[data-calendar-mode="day"]').classList.contains('active'),true);
  assert.equal(ui.w.document.querySelectorAll('.time-labels div').length,17);
  assert.equal(ui.$('.time-labels div').textContent,'07:00');
  const a=ui.$('[data-appointment-id="a"]'),b=ui.$('[data-appointment-id="b"]'),c=ui.$('[data-appointment-id="c"]');
  assert.equal(a.style.top,'36px');assert.equal(a.style.height,'108px');assert.equal(c.style.height,'18px');
  assert.equal(a.dataset.lanes,'3');assert.equal(b.dataset.lanes,'3');assert.notEqual(a.style.left,b.style.left);
  assert.equal(ui.$('[data-appointment-id="later"]').dataset.lanes,'1');
  assert.equal(ui.$('[data-appointment-id="early"]').style.height,'72px');
  ui.$('[data-toggle-early-hours]').click();assert.equal(ui.w.document.querySelectorAll('.time-labels div').length,24);
  assert.equal(ui.$('[data-appointment-id="early"]').style.height,'108px');
  ui.$('[data-toggle-month]').click();assert.ok(ui.$('.month-picker.is-open'));
  ui.$('[data-calendar-date="'+date+'"]').click();assert.equal(ui.$('.month-picker.is-open'),null);
  ui.$('#calendar-new').click();assert.equal(ui.$('[name="date"]').value,date);assert.equal(ui.$('#delete-appointment'),null);
  assert.equal(ui.w.document.querySelectorAll('[name="time"] option').length,288);
  assert.equal(ui.$('[name="time"] option:nth-child(2)').value,'00:05');
  assert.deepEqual([...ui.w.document.querySelectorAll('[name="duration"] option')].map(option=>Number(option.value)),Array.from({length:36},(_,i)=>(i+1)*5));
  ui.$('#cancel-editor').click();ui.$('[data-view="card"]').click();assert.ok(ui.w.document.body.classList.contains('has-patient'));
  ui.$('[data-view="clients"]').click();assert.equal(ui.w.document.body.classList.contains('has-patient'),false);
  assert.deepEqual(ui.errors,[]);
});

test('five simultaneous appointments have separate lanes and adjacent appointments share a lane', async t => {
  const h=await harness(t);const date=new Date().toLocaleDateString('en-CA');
  const appointments=Array.from({length:5},(_,i)=>({id:'overlap'+i,date,time:'10:15',duration:60}));
  appointments.push({id:'next',date,time:'11:15',duration:15});
  await h.request('/api/cabinet',{method:'PUT',body:JSON.stringify({revision:0,patients:[{id:'p',name:'Test',visits:[],appointments}],services:[]})});
  const ui=h.dom('index',{},true,430);await until(()=>!ui.w.document.body.classList.contains('app-loading'));
  const events=[...ui.w.document.querySelectorAll('[data-appointment-id^="overlap"]')];
  assert.equal(new Set(events.map(e=>e.style.left)).size,5);assert.ok(events.every(e=>e.dataset.lanes==='5'));
  assert.equal(ui.$('[data-appointment-id="next"]').dataset.lanes,'1');assert.deepEqual(ui.errors,[]);
});

test('login UI: first setup, mismatch feedback and subsequent password login', async t => {
  const h = await harness(t, false);
  const ui = h.dom('login');
  await until(() => !ui.$('#auth-form').hidden);
  assert.equal(ui.$('#auth-repeat-field').hidden, false);
  ui.$('#auth-email').value = credentials.email;
  ui.$('#auth-password').value = credentials.password;
  ui.$('#auth-repeat').value = 'different';
  ui.$('#auth-form').dispatchEvent(new ui.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(ui.$('#auth-error').textContent, /не совпадают/);
  ui.$('#auth-repeat').value = credentials.password;
  ui.$('#auth-form').dispatchEvent(new ui.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => h.calls.some(c => c.route === '/api/auth/setup' && c.status === 200));
  await until(() => ui.w.document.title === 'Картотека · кабинет');
  await h.request('/api/auth/logout', { method: 'POST', body: '{}' });
  const login = h.dom('login');
  await until(() => !login.$('#auth-form').hidden);
  assert.equal(login.$('#auth-repeat-field').hidden, true);
  login.$('#auth-email').value = credentials.email;
  login.$('#auth-password').value = 'wrong';
  login.$('#auth-form').dispatchEvent(new login.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Неверная/.test(login.$('#auth-error').textContent));
  login.$('#auth-password').value = credentials.password;
  login.$('#auth-form').dispatchEvent(new login.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => h.calls.some(c => c.route === '/api/auth/login' && c.status === 200));
  await until(() => login.w.document.title === 'Картотека · кабинет');
  assert.deepEqual(ui.errors.concat(login.errors), []);
});

test('migration and service edit persist; offline save retains the form; logout revokes access', async t => {
  const h = await harness(t);
  const ui = h.dom('index', legacy);
  await until(() => !ui.w.document.body.classList.contains('app-loading'));
  assert.equal(ui.w.localStorage.getItem('cosmetology-card-demo-v1'), null);
  assert.equal(ui.w.localStorage.getItem('cosmetology-services-v1'), null);
  let saved = await (await h.request('/api/cabinet')).json();
  assert.equal(saved.patients[0].name, oldPatients[0].name);assert.match(saved.patients[0].visits[0].photos[0].data,/^\/api\/photos\//);
  ui.$('[data-view="settings"]').click();
  await until(()=>ui.$('.settings-panel')&&ui.$('[data-view="settings"]').getAttribute('aria-current')==='page');
  assert.ok(ui.$('.account-settings').textContent.includes(credentials.email));
  assert.equal(ui.$('[data-edit-service]'),null);
  ui.$('[data-view="services"]').click();
  await until(() => ui.$('#toggle-service-edit'));
  ui.$('#toggle-service-edit').click();
  ui.$('[data-edit-service="s-ui"]').click();
  assert.equal(ui.$('[name="product"]'),null);
  assert.equal(ui.$('#form-content [name="description"]').value,'');
  ui.$('#form-content [name="description"]').value = 'Описание услуги';
  h.failSave = true;
  ui.$('#editor-form').dispatchEvent(new ui.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.$('[data-save-recovery="check"]'));
  assert.equal(ui.$('#editor').open, true);
  assert.equal(ui.$('#form-content [name="description"]').value, 'Описание услуги');
  saved = await (await h.request('/api/cabinet')).json();
  assert.equal(saved.services[0].product, 'Тестовое средство');
  h.failSave = false;
  ui.$('[data-save-recovery="check"]').click();
  await until(() => ui.$('[data-save-recovery="retry"]'));
  ui.$('[data-save-recovery="retry"]').click();
  await until(() => !ui.$('#editor').open);
  saved = await (await h.request('/api/cabinet')).json();
  assert.equal(saved.services[0].description, 'Описание услуги');
  assert.match(ui.$('#toast').textContent, /Сохранение подтверждено/);
  ui.$('[data-view="settings"]').click();
  await until(()=>ui.$('.settings-panel')&&ui.$('[data-view="settings"]').getAttribute('aria-current')==='page');
  ui.$('#logout-account').click();
  await until(() => h.calls.some(c => c.route === '/api/auth/logout'));
  assert.equal((await h.request('/api/cabinet')).status, 401);
  assert.deepEqual(ui.errors, []);
});

test('failed migration preserves browser data', async t => {
  const h = await harness(t);
  h.failSave = true;
  const ui = h.dom('index', legacy);
  await until(() => !ui.w.document.body.classList.contains('app-loading'));
  assert.deepEqual(JSON.parse(ui.w.localStorage.getItem('cosmetology-card-demo-v1')), oldPatients);
  assert.equal(ui.alerts.length, 1);
  const saved = await (await h.request('/api/cabinet')).json();
  assert.equal(saved.initialized, false);
  assert.deepEqual(saved.patients, []);
  assert.deepEqual(ui.errors, []);
});

test('declining migration preserves local cards without showing the retired migration control', async t => {
  const h = await harness(t);
  const ui = h.dom('index', legacy, false);
  await until(() => !ui.w.document.body.classList.contains('app-loading'));
  assert.notEqual(ui.w.localStorage.getItem('cosmetology-card-demo-v1'), null);
  ui.$('[data-view="settings"]').click();
  assert.equal(ui.$('#migrate-legacy'),null);
  assert.equal(h.calls.filter(c => c.route === '/api/cabinet' && c.method === 'PUT').length, 0);
});
test('security UI enables MFA and login requests second factor', async t => {
  const h=await harness(t);const ui=h.dom('index');await until(()=>!ui.w.document.body.classList.contains('app-loading'));ui.$('[data-view="settings"]').click();await until(()=>ui.$('#security-form'));
  assert.match(ui.$('#security-settings').textContent,/ожидает настройки почты/);
  ui.$('#security-form [name="password"]').value=credentials.password;
  ui.$('#security-form').dispatchEvent(new ui.w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:ui.$('#security-form button[value="prepare"]')}));
  await until(()=>ui.$('#mfa-confirm'));const secret=ui.$('#mfa-setup input[readonly]').value;
  const OTPAuth=require('otpauth');
  ui.$('#mfa-confirm input').value=new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate();
  ui.$('#mfa-confirm').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>ui.$('#mfa-done'));
  const code=ui.$('#mfa-setup textarea').value.split('\n')[0];assert.equal(code.length,20);
  ui.$('#mfa-done').click();await until(()=>ui.$('#security-form'));assert.match(ui.$('#security-settings').textContent,/Осталось резервных кодов: 10/);
  await h.request('/api/auth/logout',{method:'POST',body:'{}'});const login=h.dom('login');await until(()=>!login.$('#auth-form').hidden);
  login.$('#auth-email').value=credentials.email;login.$('#auth-password').value=credentials.password;login.$('#auth-form').dispatchEvent(new login.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!login.$('#verify-form').hidden);
  assert.equal((await h.request('/api/cabinet')).status,401);
  login.$('#verify-code').value=code;login.$('#verify-form').dispatchEvent(new login.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>h.calls.some(c=>c.route==='/api/auth/verify'&&c.status===200));assert.equal((await h.request('/api/cabinet')).status,200);assert.deepEqual(ui.errors.concat(login.errors),[]);
});
