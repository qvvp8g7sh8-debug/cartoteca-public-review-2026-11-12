const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),{setTimeout:delay}=require('node:timers/promises');
const {PRIVACY_VERSION}=require('../src/shared/privacy-consent.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,'../src/client',file),'utf8');
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await delay(10);}throw Error('UI timeout');};
test('public exit tries closing even without opener; refused closing never redirects or schedules a blank page', t=>{
  const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());
  w.eval(read('public/flow.js'));
  const leave=w.eval('leavePublicBookingPage'),events=[];
  const browser={opener:null,closed:false,close(){events.push('close');},setTimeout(){assert.fail('Exit must not schedule a delayed redirect');},location:{replace(){assert.fail('Exit must not redirect the booking page');}}};
  leave(browser);assert.deepEqual(events,['close']);
  events.length=0;browser.close=()=>{events.push('close');browser.closed=true;};
  leave(browser);assert.deepEqual(events,['close']);
  events.length=0;browser.closed=false;browser.close=()=>{throw Error('Synthetic close denied');};
  assert.doesNotThrow(()=>leave(browser));assert.deepEqual(events,[]);
});
test('public exit returns through real history, skips booking entries and avoids source redirects', t=>{
  const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());
  w.eval(read('public/flow.js'));
  const leave=w.eval('leavePublicBookingPage'),offset=w.eval('publicBookingReturnOffset');
  const events=[],timers=[];
  const browser={opener:null,closed:false,document:{referrer:'https://source.example/page'},
    history:{length:3,go(delta){events.push(delta);}},
    location:{href:'https://booking.example/booking.html?organization=synthetic',replace(url){events.push(url);}},
    navigation:{currentEntry:{index:2},entries:()=>[
      {index:0,url:'https://booking.example/'},{index:1,url:'https://booking.example/booking.html?organization=old'},
      {index:2,url:'https://booking.example/booking.html?organization=synthetic'}]},
    close(){events.push('close');},setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(id){events.push('clear:'+id);},
    addEventListener(){assert.fail('History traversal does not install fallback listeners');}};
  assert.equal(offset(browser),-2);leave(browser);assert.deepEqual(events,[-2]);
  assert.deepEqual(timers,[]);
  browser.navigation=undefined;assert.equal(offset(browser),-1);
  browser.document.referrer='';assert.equal(offset(browser),0);
  browser.document.referrer='https://booking.example/booking.html?organization=old';assert.equal(offset(browser),0);
  browser.document.referrer='javascript:alert(1)';assert.equal(offset(browser),0);
  browser.document.referrer='https://source.example/page';browser.history.length=1;assert.equal(offset(browser),0);
  browser.history.length=3;browser.navigation={currentEntry:{index:1},entries:()=>[
    {index:0,url:'https://booking.example/booking.html?organization=old'},
    {index:1,url:browser.location.href}]};assert.equal(offset(browser),0);
  browser.navigation={currentEntry:{index:2},entries:()=>[
    {index:0,url:null,getState:()=>({})},
    {index:1,url:null,getState:()=>({cartotecaPublicBooking:true})},
    {index:2,url:browser.location.href}]};assert.equal(offset(browser),-2);
  browser.navigation.entries=()=>[
    {index:0,url:null,getState:()=>({cartotecaPublicBooking:true})},
    {index:1,url:null,getState:()=>({cartotecaPublicBooking:true})},
    {index:2,url:browser.location.href}];assert.equal(offset(browser),0);
  events.length=0;timers.length=0;browser.navigation=undefined;browser.opener={};
  leave(browser);assert.deepEqual(events,['close']);assert.deepEqual(timers,[]);
  events.length=0;timers.length=0;browser.opener=null;
  leave(browser);assert.deepEqual(events,[-1]);assert.deepEqual(timers,[]);
});
test('booking history marker preserves existing state and requires no addresses or storage',t=>{
  const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());
  w.eval(read('public/flow.js'));
  const mark=w.eval('markPublicBookingEntry');let saved;
  const browser={navigation:{currentEntry:{getState:()=>({existing:1})},updateCurrentEntry(value){saved=value;}}};
  mark(browser);assert.deepEqual(JSON.parse(JSON.stringify(saved)),{state:{existing:1,cartotecaPublicBooking:true}});
  saved=null;browser.navigation.currentEntry.getState=()=>7;mark(browser);assert.equal(saved,null);
  assert.doesNotThrow(()=>mark({}));
});
test('paused public page displays one administrator phone and no booking form', t=>{
  const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());
  w.eval(read('public/receipt.js'));w.eval(read('public/view.js'));
  const root=w.document.querySelector('main'),view=w.eval('createPublicBookingView')(root);
  view.unavailable({name:'Synthetic organization',phone:'+79000000001',phoneLabel:'Телефон администратора'},'paused');
  assert.match(root.textContent,/Онлайн-запись временно закрыта/);
  assert.match(root.textContent,/Телефон администратора/);
  assert.equal(root.querySelector('.booking-contact-phone').textContent,'+7 900 000-00-01');
  assert.equal(root.querySelector('.booking-contact-phone').getAttribute('href'),'tel:+79000000001');
  assert.equal(root.querySelector('form'),null);
});
function fixture(t,width=390,customizeRequest=null){
  const w=new JSDOM('<main id="public-booking"></main>',{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/booking.html?organization=synthetic'}).window;t.after(()=>w.close());Object.defineProperty(w,'innerWidth',{value:width});
  w.opener={}; // Explicit script-opened window: X is available, while mocked close may be refused.
  for(const file of ['phone','flow','receipt','view','page']) w.eval(read('public/'+file+'.js'));
  const exits=[];w.leavePublicBookingPage=()=>exits.push(true);
  const info={organization:{name:'<script>Organization</script>',city:'City',timeZone:'Europe/Moscow'},services:[{id:'s',name:'<img src=x>Service',duration:30,price:120,staffIds:['staff']}],members:[{id:'staff',name:'Staff',specialty:'Test'}],challenge:'synthetic-challenge',reservationMinutes:30};
  let posts=[],fail=false,availabilityFail=false,datesResolve,dateCalls=0;
  info.privacyConsentVersion=PRIVACY_VERSION;
  const request=async(url,options)=>{
    if(url.includes('/info'))return info;
    if(url.includes('/dates')){dateCalls++;if(datesResolve)return new Promise(r=>datesResolve=r);return {dates:['2030-01-01']};}
    if(url.includes('/availability')){if(availabilityFail)throw Error('Synthetic availability failure');return {slots:[{date:'2030-01-01',time:'09:00',duration:30,staffId:'staff'}],requestedTimes:['09:00','10:00']};}
    if(url.includes('/requests')){posts.push(JSON.parse(options.body));if(fail)throw Error('Synthetic network timeout');return {status:info.bookingMode==='classic'?'booked':posts.at(-1).kind==='other-time'?'requested':'pending'};}
    throw Error('Unexpected request');
  };
  const page=w.eval('createPublicBookingPage')(w.document.querySelector('main'),w.eval('createPublicBookingView'),
    customizeRequest ? (url,options)=>customizeRequest(url,options,request) : request);
  const $=s=>w.document.querySelector(s),change=el=>el.dispatchEvent(new w.Event('change',{bubbles:true}));
  const depart=()=>w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:true}));
  const back=()=>w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));
  return {w,page,posts,exits,depart,back,$,change,info,get dateCalls(){return dateCalls;},get fail(){return fail;},set fail(v){fail=v;},set availabilityFail(v){availabilityFail=v;},set datesResolve(v){datesResolve=v;}};
}
test('wizard keeps one step visible, preserves drafts on back, and closes without submitting',async t=>{
  const f=fixture(t);await f.page.initialize();f.$('#booking-month').value='2030-01';
  assert.equal(f.$('#booking-services-section').hidden,false);
  assert.equal(f.$('#booking-date-section').hidden,true);
  assert.equal(f.$('[data-booking-next="2"]').disabled,true);
  assert.equal(f.$('[data-booking-close]').hidden,false);
  f.$('[data-booking-close]').click();
  assert.equal(f.$('main').hidden,false);assert.equal(f.posts.length,0);
  assert.equal(f.$('[data-booking-resume]'),null);assert.equal(f.exits.length,1);
  f.depart();f.back();
  const service=f.$('[data-booking-service]');service.checked=true;f.change(service);
  await until(()=>f.$('[data-booking-date]'));
  assert.equal(f.$('#booking-date-section').hidden,true);
  f.$('[data-booking-next="2"]').click();
  assert.equal(f.$('#booking-services-section').hidden,true);
  assert.equal(f.$('[data-booking-next="3"]').disabled,true);
  f.$('[data-booking-date]').click();await until(()=>f.$('[data-booking-time]'));
  assert.match(f.$('[data-booking-period=morning]').textContent,/Утро.*12:00/);
  assert.equal(f.$('[data-booking-period=day]').disabled,true);
  assert.equal(f.$('[data-booking-period=evening]').disabled,true);
  f.$('[data-booking-time]').click();
  assert.equal(f.$('#booking-contact-section').hidden,true);
  f.$('[data-booking-next="3"]').click();
  f.$('[name=firstName]').value='Synthetic';
  f.$('[name=phone]').value='89991234567';
  f.$('[name=phone]').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  assert.equal(f.$('[name=phone]').value,'+7 999 123-45-67');
  assert.equal(f.$('[name=consent]').checked,false);
  assert.equal(f.$('.booking-legal a').closest('label'),null);
  f.$('[data-booking-back="2"]').click();f.$('[data-booking-back="1"]').click();
  assert.equal(f.$('[data-booking-service]').checked,true);
  f.$('[data-booking-next="2"]').click();f.$('[data-booking-next="3"]').click();
  assert.equal(f.$('[name=firstName]').value,'Synthetic');
  assert.equal(f.$('[name=phone]').value,'+7 999 123-45-67');
  f.$('[data-booking-close]').click();f.depart();f.back();
  assert.equal(f.$('#booking-contact-section').hidden,false);
  assert.equal(f.posts.length,0);
});

test('booking X is hidden without an opener or known return history and the form stays usable',async t=>{
  const f=fixture(t);f.w.opener=null;await f.page.initialize();
  assert.equal(f.$('[data-booking-close]').hidden,true);
  assert.equal(f.$('main').hidden,false);
  assert.equal(f.$('#booking-services-section').hidden,false);
  assert.equal(f.posts.length,0);assert.equal(f.exits.length,0);
});
test('unknown delivery stays locked on explicit browser Back and retries the same submission',async t=>{
  const f=fixture(t);await selectSlot(f);f.fail=true;
  const form=f.$('#booking-contact-form');form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>f.posts.length===1);await delay(10);
  assert.equal(f.$('[data-booking-close]').disabled,false);
  const frozen=structuredClone(f.posts[0]);
  f.$('[data-booking-close]').click();assert.equal(f.$('main').hidden,false);
  assert.equal(f.posts.length,1);assert.equal(f.$('[name=phone]').disabled,true);
  f.depart();f.back();assert.equal(f.$('[name=phone]').disabled,true);
  f.fail=false;form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>f.$('#booking-result').hidden===false);
  assert.deepEqual(f.posts[0],f.posts[1]);
  assert.deepEqual(f.posts[1],frozen);
});
test('receipt can be closed after completion without cancelling or submitting again',async t=>{
  const f=fixture(t);await selectSlot(f);
  f.$('#booking-contact-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>f.$('[data-booking-result-close]'));
  assert.equal(f.$('[data-booking-result-close]').disabled,false);
  f.$('[data-booking-result-close]').click();
  assert.equal(f.$('main').classList.contains('booking-exited'),false);
  assert.equal(f.$('main').hidden,false);assert.equal(f.exits.length,1);
  assert.equal(f.$('#booking-flow').hidden,true);
  assert.match(f.$('#booking-result').textContent,/Ожидает подтверждения/);
  assert.equal(f.$('#booking-exit'),null);
  f.$('#booking-contact-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(f.posts.length,1);
  f.depart();f.back();
  assert.equal(f.$('main').classList.contains('booking-exited'),false);
  assert.equal(f.w.document.activeElement.id,'booking-result');
});
test('failed public time loading stays visible and can be retried without changing date',async t=>{
  const f=fixture(t);await selectSlot(f);f.availabilityFail=true;
  f.$('[data-booking-back="2"]').click();
  f.$('[data-booking-date]').click();
  await until(()=>f.$('#booking-times-refresh').textContent==='Повторить загрузку');
  assert.equal(f.$('#booking-time-area').hidden,false);
  assert.equal(f.$('#booking-contact-section').hidden,true);
  f.availabilityFail=false;f.$('#booking-times-refresh').click();
  await until(()=>f.$('[data-booking-time]'));
  assert.equal(f.$('#booking-time-area').getAttribute('aria-busy'),'false');
  f.$('[data-booking-time]').click();f.$('[data-booking-next="3"]').click();assert.equal(f.$('#booking-contact-section').hidden,false);
});
test('delayed month change does not hide time or contacts after input already loaded the month',async t=>{
  const f=fixture(t);await f.page.initialize();const service=f.$('[data-booking-service]');
  service.checked=true;f.change(service);await until(()=>f.dateCalls===1);await delay(10);
  f.$('[data-booking-next="2"]').click();
  const month=f.$('#booking-month');month.value='2030-01';
  month.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  await until(()=>f.$('[data-booking-date]'));
  f.$('[data-booking-date]').click();await until(()=>f.$('[data-booking-time]'));
  f.$('[data-booking-time]').click();f.$('[data-booking-next="3"]').click();const calls=f.dateCalls;
  f.change(month);await delay(10);
  assert.equal(f.dateCalls,calls);
  assert.equal(f.$('#booking-time-area').hidden,false);
  assert.equal(f.$('#booking-contact-section').hidden,false);
});
async function selectSlot(f,other=false){
  await f.page.initialize();f.$('#booking-month').value='2030-01';const service=f.$('[data-booking-service]');service.checked=true;f.change(service);await until(()=>f.$('[data-booking-date]'));
  f.$('[data-booking-next="2"]').click();
  f.$('[data-booking-date]').click();await until(()=>f.$('[data-booking-time]'));
  if(other){f.$('#booking-other-time').click();f.$('[data-booking-requested-time="10:00"]').click();}
  else f.$('[data-booking-time]').click();
  f.$('[data-booking-next="3"]').click();
  f.$('[name=firstName]').value='Client';f.$('[name=phone]').value='89990000000';f.$('[name=consent]').checked=true;
}
function deferredDates(t) {
  const calls = [];
  const f = fixture(t, 390, (url, options, next) => {
    if (!url.includes('/dates')) return next(url, options);
    return new Promise((resolve, reject) => {
      const call = { url, signal: options.signal, resolve };
      calls.push(call);
      options.signal.addEventListener('abort', () => reject(new f.w.DOMException('Cancelled', 'AbortError')), { once: true });
    });
  });
  return { f, calls };
}
test('identical pending dates share a request; a different month aborts and discards stale work', async t => {
  const { f, calls } = deferredDates(t);
  await f.page.initialize(); f.$('#booking-month').value = '2030-01';
  const service = f.$('[data-booking-service]'); service.checked = true; f.change(service);
  await until(() => calls.length === 1);
  f.change(f.$('#booking-staff')); await delay(10);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  const month = f.$('#booking-month'); month.value = '2030-02';
  month.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await until(() => calls.length === 2);
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve({ dates: ['2030-01-01'] });
  calls[1].resolve({ dates: ['2030-02-01'] });
  await until(() => f.$('[data-booking-date="2030-02-01"]'));
  assert.equal(f.$('[data-booking-date="2030-01-01"]'), null);
  assert.equal(f.posts.length, 0);
});
test('refused closing preserves unfinished reads; actual departure cancels and browser Back reloads without submitting or discarding contacts', async t => {
  const { f, calls } = deferredDates(t);
  await f.page.initialize(); f.$('#booking-month').value = '2030-01';
  const service = f.$('[data-booking-service]'); service.checked = true; f.change(service);
  await until(() => calls.length === 1);
  f.$('[name=firstName]').value = 'Synthetic draft';
  f.$('[data-booking-close]').click();
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(f.$('main').hidden, false);
  assert.equal(f.posts.length,0);
  f.depart();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(f.$('main').hidden, false);
  f.back(); await until(() => calls.length === 2);
  calls[1].resolve({ dates: ['2030-01-01'] });
  await until(() => f.$('[data-booking-date]'));
  assert.equal(f.$('[name=firstName]').value, 'Synthetic draft');
  assert.equal(f.$('[data-booking-service]').checked, true);
  assert.equal(f.posts.length, 0);
});
test('read cancellation reaches fetch and preserves AbortError instead of a submission-retry message', async t => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close()); w.eval(read('public/page.js'));
  let signal;
  w.fetch = (url, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new w.DOMException('Cancelled', 'AbortError')), { once: true });
  });
  const controller = new w.AbortController();
  const pending = w.eval('publicBookingRequest')('/synthetic', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
});
for (const width of [320,390,1440]) test('classic form offers immediate booking, hides other-time and recovers the same payload at '+width, async t=>{
  const f=fixture(t,width);f.info.bookingMode='classic';await selectSlot(f);
  assert.equal(f.$('#booking-other-time').hidden,true);
  assert.equal(f.$('#booking-contact-form button[type="submit"]').textContent,'Записаться');
  assert.doesNotMatch(f.$('.booking-submit-hint').textContent,/дождитесь подтверждения/);
  assert.match(f.$('.booking-submit-hint').textContent,/После сохранения.*сразу.*подтверждение/);
  f.fail=true;const form=f.$('#booking-contact-form');form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>f.posts.length===1);await delay(10);
  assert.equal(f.$('#booking-result').hidden,true);assert.equal(f.$('[name=phone]').disabled,true);
  f.fail=false;form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>f.$('#booking-result').hidden===false);
  assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.posts[1].bookingMode,'classic');
  assert.equal(f.$('#booking-result').dataset.state,'booked');
  assert.match(f.$('#booking-result').textContent,/Запись успешно создана.*Подтверждена организацией/);
  assert.doesNotMatch(f.$('#booking-result').textContent,/Резерв действует|Ожидает подтверждения/);
  assert.equal(f.$('#booking-flow').hidden,true);assert.equal(f.posts.length,2);
});
for(const width of [390,1440])test('public page auto-selects sole provider, escapes names and submits without account or Telegram at '+width,async t=>{
  const f=fixture(t,width);await selectSlot(f);assert.equal(f.$('#booking-staff-section').hidden,true);assert.equal(f.w.document.querySelectorAll('script,img').length,0);
  f.$('#booking-contact-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>f.posts.length===1);await delay(10);
  assert.equal(f.posts[0].staffId,'staff');assert.equal(f.posts[0].consent,true);assert.deepEqual(f.posts[0].serviceIds,['s']);assert.ok(!('duration' in f.posts[0]));
  assert.equal(f.posts[0].privacyConsentVersion,PRIVACY_VERSION);
  assert.match(f.$('#booking-page-status').textContent,/успешно отправлена/);assert.equal(f.$('#booking-contact-form button').disabled,true);
  assert.equal(f.$('#booking-flow').hidden,true);assert.equal(f.$('#booking-result').hidden,false);
  assert.equal(f.w.document.activeElement.id,'booking-result');
  assert.match(f.$('#booking-result').textContent,/Ожидает подтверждения/);
  assert.match(f.$('#booking-result').textContent,/автоматически.*не отправляется/);
  assert.match(f.$('#booking-result').textContent,/1 января 2030.*09:00/);
});
test('explicit challenge rejection renews only proof and waits for another submit', async t => {
  const sent = []; let reads = 0;
  const f = fixture(t, 390, async (url, options, request) => {
    if (url.includes('/info')) {
      reads++;
      return { ...await request(url, options), challenge: reads === 1 ? 'old-proof' : reads === 2 ? 'preflight-proof' : 'fresh-proof' };
    }
    if (url.includes('/requests')) {
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) throw Object.assign(Error('expired'), {
        status: 400, code: 'BOOKING_CHALLENGE_REJECTED',
      });
    }
    return request(url, options);
  });
  await selectSlot(f);
  const form = f.$('#booking-contact-form');
  const submit = () => form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => f.$('#booking-page-status').textContent.includes('Данные сохранены'));
  assert.equal(sent.length, 1); assert.equal(reads, 3);
  assert.equal(sent[0].challenge, 'preflight-proof');
  submit(); await until(() => f.$('#booking-result').hidden === false);
  assert.deepEqual(sent[1], { ...sent[0], challenge: 'fresh-proof' });
  assert.equal(sent[1].key, 'old-proof');
});

test('a second explicit challenge rejection stops renewal for the frozen draft', async t => {
  let reads = 0, posts = 0;
  const f = fixture(t, 390, async (url, options, request) => {
    if (url.includes('/info')) reads++;
    if (url.includes('/requests')) {
      posts++;
      throw Object.assign(Error('expired'), { status: 400, code: 'BOOKING_CHALLENGE_REJECTED' });
    }
    return request(url, options);
  });
  await selectSlot(f);
  const form = f.$('#booking-contact-form');
  const submit = () => form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => f.$('#booking-page-status').textContent.includes('Данные сохранены'));
  submit(); await until(() => f.$('#booking-page-status').textContent.includes('Откройте ссылку'));
  assert.equal(reads, 3); assert.equal(posts, 2);
  assert.equal(form.querySelector('button[type=submit]').disabled, true);
  assert.equal(f.$('[name=phone]').disabled, true);
});

test('manual retry after unknown delivery renews proof without changing the business snapshot', async t => {
  const sent = []; let reads = 0;
  const f = fixture(t, 390, async (url, options, request) => {
    if (url.includes('/info')) {
      reads++;
      return { ...await request(url, options), challenge: 'proof-' + reads };
    }
    if (url.includes('/requests')) {
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) throw Error('Synthetic unknown delivery');
      throw Object.assign(Error('expired'), { status: 400, code: 'BOOKING_CHALLENGE_REJECTED' });
    }
    return request(url, options);
  });
  await selectSlot(f);
  const form = f.$('#booking-contact-form');
  const submit = () => form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => sent.length === 1 && f.$('#booking-page-status').textContent.includes('Подтверждение не получено'));
  submit(); await until(() => sent.length === 2 && f.$('#booking-page-status').textContent.includes('Подтверждение не получено'));
  assert.equal(reads, 3);
  assert.equal(sent[0].key, 'proof-1');
  assert.equal(sent[0].challenge, 'proof-2');
  assert.equal(sent[1].challenge, 'proof-3');
  const business = ({ challenge, ...snapshot }) => snapshot;
  assert.deepEqual(business(sent[1]), business(sent[0]));
  assert.equal(f.$('[name=phone]').disabled, true);
});

test('unknown delivery freezes the exact payload; retry sends the same key and contact, not a new request',async t=>{
  const f=fixture(t);await selectSlot(f);f.fail=true;const form=f.$('#booking-contact-form');form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>f.posts.length===1);await delay(10);
  assert.equal(f.$('[name=phone]').disabled,true);assert.equal(form.querySelector('button[type=submit]').disabled,false);
  f.$('[name=phone]').value='79999999999';f.fail=false;form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>f.posts.length===2);await delay(10);
  assert.deepEqual(f.posts[0],f.posts[1]);assert.match(f.$('#booking-page-status').textContent,/успешно отправлена/);
});
test('another-time selection clearly states no reserve and uses only a request, not a booked appointment',async t=>{
  const f=fixture(t);await selectSlot(f,true);assert.match(f.$('#booking-page-status').textContent,/не резервирует/);
  f.$('#booking-contact-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>f.posts.length===1);await delay(10);
  assert.equal(f.posts[0].kind,'other-time');assert.equal(f.posts[0].time,'10:00');assert.match(f.$('#booking-page-status').textContent,/не резервируется/);
  assert.match(f.$('#booking-result').textContent,/24 часов/);
});
test('publication switch is separate from rules, defaults off, saves revision and offers a stable public link',async t=>{
  const w=new JSDOM('<div id="booking-publication"></div>',{runScripts:'outside-only',url:'http://localhost/'}).window;t.after(()=>w.close());w.eval(read('modules/booking-publication.js'));
  const state={account:{id:'owner',organizationId:'o'},currentView:'settings',busy:false};let values;
  const actions={$:s=>w.document.querySelector(s),esc:v=>String(v),request:async(url,options)=>{values=JSON.parse(options.body);return {enabled:values.enabled,revision:1,path:'/booking.html?organization=o',canManage:true};}};
  w.eval(read('modules/settings-help.js'));Object.assign(actions,w.eval('createSettingsHelp')(state,actions));
  actions.refreshBookingHealth=async()=>{};
  actions.confirmAction=async()=>true;actions.markSettingsSaved=()=>{};
  w.eval('createBookingPublication')(state,actions).mountBookingPublication({publication:{enabled:false,revision:0,path:'/booking.html?organization=o',canManage:true},members:[{accountId:'owner',displayName:'Owner',role:'owner'}],staff:{}});
  assert.equal(w.document.querySelector('[data-booking-public-link]'),null);
  const form=w.document.querySelector('form');form.elements.enabled.checked=true;form.elements.enabled.dispatchEvent(new w.Event('change',{bubbles:true}));await until(()=>!state.busy&&values);
  assert.deepEqual(values,{enabled:true,revision:0});assert.equal(w.document.querySelector('[data-booking-public-link]').value,'http://localhost/booking.html?organization=o');
  assert.match(w.document.querySelector('[role=status]').textContent,/включена/);
});

test('publication synchronization refreshes revision and preserves a pending explicit decision',async t=>{
  const w=new JSDOM('<div id="booking-publication"></div>',{runScripts:'outside-only',url:'http://localhost/'}).window;t.after(()=>w.close());
  w.eval(read('modules/booking-publication.js'));w.eval(read('modules/settings-help.js'));
  const state={account:{id:'owner',organizationId:'o'},currentView:'settings',busy:false};let sent;
  const actions={$:s=>w.document.querySelector(s),esc:String,refreshBookingHealth:async()=>{},request:async(url,options)=>{sent=JSON.parse(options.body);return {...sent,canManage:true,path:'/booking.html?organization=o'};}};
  let decide;actions.confirmAction=()=>new Promise(resolve=>decide=resolve);actions.markSettingsSaved=()=>{};
  Object.assign(actions,w.eval('createSettingsHelp')(state,actions));
  const api=w.eval('createBookingPublication')(state,actions);
  const initial={enabled:true,revision:1,path:'/booking.html?organization=o',canManage:true};
  api.mountBookingPublication({publication:initial,members:[{accountId:'owner',role:'owner'}],staff:{}});
  let checkbox=w.document.querySelector('input[name=enabled]');
  api.syncBookingPublication({...initial,enabled:false,revision:2,disabledReason:'no_working_days',hasWorkingDays:false});
  checkbox=w.document.querySelector('input[name=enabled]');
  assert.equal(checkbox.checked,false);checkbox.focus();
  api.syncBookingPublication({...initial,enabled:true,revision:1});
  assert.equal(w.document.querySelector('input[name=enabled]').checked,false);
  checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.equal(checkbox.checked,false);
  api.syncBookingPublication({...initial,enabled:true,revision:3});
  assert.equal(w.document.querySelector('input[name=enabled]'),checkbox);
  decide(true);
  await until(()=>!state.busy&&sent);
  assert.deepEqual(sent,{enabled:true,revision:2});
});

test('no days and busy schedules have clear public states, contact and recovery without an empty calendar',async t=>{
  const f=fixture(t);
  f.info.organization.phone='8 (999) 000-00-00';
  f.info.health={available:false,reason:'no_working_days'};
  await f.page.initialize();
  assert.match(f.$('main').textContent,/нет открытых дней/);
  assert.equal(f.$('#booking-month'),null);
  assert.equal(f.$('a[href^="tel:"]').getAttribute('href'),'tel:+79990000000');
  f.info.health.reason='no_slots';
  f.$('[data-booking-retry]').click();
  await until(()=>f.$('#booking-unavailable-title').textContent.includes('Свободного времени'));
  f.info.health={available:true,nextDate:'2040-02-03'};
  f.$('[data-booking-retry]').click();
  await until(()=>f.$('#booking-month'));
  assert.equal(f.$('#booking-month').value,'2040-02');
  assert.equal(f.$('script,img'),null);
});

test('technical empty state is distinct from full schedule and phone URLs cannot inject markup', t=>{
  const f=fixture(t);
  const view=f.w.eval('createPublicBookingView')(f.$('main'));
  view.unavailable({name:'<img src=x>',phone:'javascript:alert(1)'},'unavailable',true);
  assert.match(f.$('main').textContent,/Не удалось загрузить/);
  assert.match(f.$('main').textContent,/не означает, что всё время занято/);
  assert.equal(f.$('img,script,a[href]'),null);
  assert.equal(f.$('[data-booking-retry]').disabled,false);
});

test('time choices use bounded button grids, periods and explicit expansion, with no long time select',async t=>{
  const f=fixture(t);await f.page.initialize();
  const view=f.w.eval('createPublicBookingView')(f.$('main'));
  const values=Array.from({length:96},(_,i)=>String(Math.floor(i/4)).padStart(2,'0')+':'+String(i%4*15).padStart(2,'0'));
  const availability={slots:values.map(time=>({time})),requestedTimes:values};
  view.times(availability);
  assert.equal(f.$('#booking-other-select'),null);
  assert.equal(f.w.document.querySelectorAll('[data-booking-time]').length,12);
  assert.equal(f.w.document.querySelectorAll('[data-booking-period]').length,3);
  assert.equal(f.$('#booking-times-more').hidden,false);
  view.moreTimes();view.times(availability);assert.equal(f.w.document.querySelectorAll('[data-booking-time]').length,24);
  view.timePeriod('evening');view.times(availability,'18:00');
  assert.equal(f.w.document.querySelectorAll('[data-booking-time]').length,12);
  assert.equal(f.$('[data-booking-time="18:00"]').getAttribute('aria-pressed'),'true');
  view.times(availability,'','other-time');
  assert.equal(f.w.document.querySelectorAll('[data-booking-time]').length,0);
  assert.equal(f.w.document.querySelectorAll('[data-booking-requested-time]').length,12);
  assert.match(f.$('#booking-time-note').textContent,/не резервируется/);
  view.times({slots:[{time:'13:15'}],requestedTimes:[]});
  assert.equal(f.$('[data-booking-time]').textContent,'13:15');assert.equal(f.$('#booking-times-more').hidden,true);
});

test('calendar aligns Monday-first dates and closed days remain disabled after unlock; month navigation resets selection',async t=>{
  const f=fixture(t);await selectSlot(f);
  assert.equal(f.$('#booking-days').firstElementChild.tagName,'SPAN'); // 1 Jan 2030 is Tuesday.
  assert.equal(f.w.document.querySelectorAll('#booking-days button').length,31);
  const view=f.w.eval('createPublicBookingView')(f.$('main'));view.lock(true);view.lock(false);
  assert.equal(f.$('#booking-days button:not([data-booking-date])').disabled,true);
  f.$('[data-booking-back="2"]').click();
  f.$('[data-booking-month-shift="1"]').click();await delay(20);
  assert.equal(f.$('#booking-month').value,'2030-02');assert.equal(f.$('#booking-contact-section').hidden,true);
});

test('hidden prices never render in catalog, total or receipt; null price is not described as a free service',async t=>{
  const f=fixture(t);f.info.showPrices=false;delete f.info.services[0].price;await selectSlot(f);
  assert.ok(!f.$('#booking-services').textContent.includes('₽'));assert.ok(!f.$('#booking-total').textContent.includes('₽'));
  f.$('#booking-contact-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await delay(20);
  assert.ok(!f.$('#booking-result').textContent.includes('₽'));assert.ok(!f.$('#booking-result').textContent.includes('NaN'));
  const view=f.w.eval('createPublicBookingView')(f.$('main'));view.mount(f.info);f.info.showPrices=true;f.info.services[0].price=null;
  view.catalog(f.info,['s']);assert.ok(!f.$('#booking-services').textContent.includes('0 ₽'));
});

test('receipt reflects terminal server status, never calls expired/rejected requests accepted and escapes public names',async t=>{
  const f=fixture(t);await f.page.initialize();const view=f.w.eval('createPublicBookingView')(f.$('main'));
  const expected={pending:'Ожидает подтверждения',requested:'Нужно согласовать',expired:'Резерв истёк',accepted:'Принята организацией',rejected:'Не подтверждена',cancelled:'Не подтверждена'};
  for(const [status,message] of Object.entries(expected)){
    view.success(f.info,{status,date:'2030-01-02',time:'11:00',duration:30},{serviceIds:['s'],staffId:'staff',date:'2030-01-01',time:'09:00'});
    assert.match(f.$('#booking-result').textContent,new RegExp(message));
    assert.match(f.$('#booking-result').textContent,/2 января 2030.*11:00/);
    assert.equal(f.w.document.querySelectorAll('script,img').length,0);
  }
  view.success(f.info,{status:'expired',date:'2030-01-02',time:'11:00',duration:30},{kind:'other-time',serviceIds:['s'],staffId:'staff'});
  assert.match(f.$('#booking-result').textContent,/Срок ожидания истёк/);
  assert.doesNotMatch(f.$('#booking-result').textContent,/Резерв истёк/);
});
