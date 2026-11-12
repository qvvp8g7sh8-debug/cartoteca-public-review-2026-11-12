const { publicRoot } = require('./helpers/interface-assets.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {clientRelease,versionedHtml,supportTelegram,releaseFiles}=require('../src/server/http/client-release.cjs');
const {createMultiServer}=require('../multi-server.cjs'),{createPlatformStore}=require('../platform-store.cjs');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
test('release changes with public files only and versions every shell asset without exposing files',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-release-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of releaseFiles){const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file);}
  const first=await clientRelease(dir);assert.match(first,/^[a-f0-9]{16}$/);assert.equal(await clientRelease(dir),first);
  fs.writeFileSync(path.join(dir,'private.txt'),'synthetic private value');assert.equal(await clientRelease(dir),first);
  fs.writeFileSync(path.join(dir,'app.js'),'new public interface');assert.notEqual(await clientRelease(dir),first);
  const second=await clientRelease(dir);
  fs.writeFileSync(path.join(dir,'app-assistant.js'),'synthetic assistant update');
  assert.notEqual(await clientRelease(dir),second);
  const html=versionedHtml('<head><link href="style.css"><script src="app.js?old=1"></script><script src="https://example.test/no.js"></script></head>',first);
  assert.match(html,new RegExp('app.js\\?v='+first));assert.match(html,new RegExp('style.css\\?v='+first));assert.match(html,/name="cartoteca-build"/);assert.match(html,/https:\/\/example.test\/no.js/);assert.doesNotMatch(html,/old=1/);
  assert.equal(supportTelegram('@Help_Cartoteca'),'https://t.me/Help_Cartoteca');assert.equal(supportTelegram('https://t.me/Help_Cartoteca'),'https://t.me/Help_Cartoteca');
  for(const bad of ['https://evil.test/help','javascript:alert(1)','Help_Cartoteca?secret=1','/etc/passwd','abc','Help_Cartoteca/extra'])assert.equal(supportTelegram(bad),'');
});
test('real HTTP caches current versioned interface assets privately and keeps shells, API and errors no-store',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-cache-http-'));
  const p=createPlatformStore(path.join(dir,'platform'));const owner=await p.registerOwner({email:'cache@example.test',password:'Cache-test-password-2026',displayName:'Synthetic owner',organizationName:'Synthetic salon'});p.verifyEmail(owner.verificationToken);p.close();
  const server=createMultiServer({dataDir:dir,sendMail:null,telegramBot:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const infoResponse=await fetch(base+'/api/app/info');assert.equal(infoResponse.status,200);assert.equal(infoResponse.headers.get('cache-control'),'no-store');
  const info=await infoResponse.json();assert.deepEqual(Object.keys(info).sort(),['supportForm','supportTelegram','version']);assert.equal(info.version,await clientRelease(publicRoot));assert.equal(info.supportForm,false);
  const anonymous=await fetch(base+'/');assert.equal(anonymous.headers.get('cache-control'),'no-store');assert.match(await anonymous.text(),/<title>Вход/);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify({email:'cache@example.test',password:'Cache-test-password-2026'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const page of ['index.html','login.html','admin.html']){
    const response=await fetch(base+'/'+page,{headers:{Cookie:cookie}}),html=await response.text();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(html,new RegExp('content="'+info.version+'"'));
    const assets=[...html.matchAll(/(?:src|href)="([a-z-]+\.(?:js|css)\?v=[a-f0-9]{16})"/g)].map(m=>m[1]);assert.ok(assets.length>=3);
    for(const asset of assets)for(const method of ['GET','HEAD']){
      const r=await fetch(base+'/'+asset,{method,headers:{Cookie:cookie}});
      assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, max-age=31536000, immutable');
      if(method==='HEAD')assert.equal(await r.text(),'');
      const file=asset.split('?')[0];
      for(const suffix of ['', '?v=', '?v=stale']){
        const stale=await fetch(base+'/'+file+suffix,{method,headers:{Cookie:cookie}});
        assert.equal(stale.status,suffix === '?v=stale' ? 409 : 200);assert.equal(stale.headers.get('cache-control'),'no-store');
        if(method==='HEAD')assert.equal(await stale.text(),'');
      }
    }
  }
  for(const deferredFile of ['app-settings.js','app-assistant.js']) for(const method of ['GET','HEAD']) {
    const response=await fetch(base+'/'+deferredFile+'?v='+info.version,{method,headers:{Cookie:cookie}});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, max-age=31536000, immutable');
    if(method==='HEAD')assert.equal(await response.text(),'');
    for(const suffix of ['', '?v=', '?v=stale']){
      const stale=await fetch(base+'/'+deferredFile+suffix,{method,headers:{Cookie:cookie}});
      assert.equal(stale.status,409);assert.equal(stale.headers.get('cache-control'),'no-store');
    }
  }
  for(const route of ['/api/cabinet','/app.js','/app-settings.js','/app-assistant.js','/runtime/platform/platform.sqlite','/sw.js']){
    const r=await fetch(base+route);assert.ok([401,404].includes(r.status));assert.equal(r.headers.get('cache-control'),'no-store');
  }
});
function supportFixture(t,{clipboard=true,submitImpl=null}={}){
  const old='1111111111111111',next='2222222222222222',w=new JSDOM('<head><meta name="cartoteca-build" content="'+old+'"></head><body><main id="workspace"></main><dialog id="editor"></dialog><div id="global-view"></div></body>',{url:'https://local.test/'}).window;t.after(()=>w.close());
  let reloads=0,fetches=0,copy='',response={version:next,supportTelegram:'https://t.me/Help_Cartoteca'};const notices=[],opened=[];
  w.open=(...args)=>{opened.push(args);return null;};
  const state={busy:false,currentView:'settings',uploadItems:[],account:{email:'DO_NOT_INCLUDE',id:'PRIVATE_ACCOUNT'},data:[{name:'PRIVATE_PATIENT',phone:'PRIVATE_PHONE'}]};
  const actions={$:s=>w.document.querySelector(s),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),toast:s=>notices.push(s),settingsSectionHtml:(title,id,content)=>'<details><summary>'+title+'</summary><div id="'+id+'">'+content+'</div></details>'};
  const factories=vm.runInNewContext(read('src/client/modules/settings-guard.js')+'\n'+read('src/client/modules/settings-help.js')+'\n'+read('src/client/modules/support-requests.js')+'\n'+read('src/client/modules/support.js')+';({createSupport,createSupportRequests,createSettingsHelp,createSettingsGuard})',{document:w.document,window:w,navigator:{onLine:true,clipboard:clipboard?{writeText:async text=>{copy=text;}}:undefined},location:{reload:()=>reloads++},fetch:async(url,opts)=>{fetches++;if(url.startsWith('/api/support/requests')&&submitImpl)return submitImpl(url,opts);if(response===null)throw Error('Synthetic offline');return {ok:true,json:async()=>response};},URL,AbortController,AbortSignal,setTimeout,clearTimeout});
  Object.assign(actions,factories.createSettingsHelp(state,actions));
  Object.assign(actions,factories.createSupportRequests(state,actions));const api=factories.createSupport(state,actions);w.document.querySelector('#global-view').innerHTML='<section class="settings-panel">'+api.supportSettingsHtml()+'</section>';api.bindSupportEvents();
  Object.assign(actions,factories.createSettingsGuard(state,actions));actions.bindSettingsGuardEvents();
  return {w,state,actions,api,notices,opened,get reloads(){return reloads;},get fetches(){return fetches;},get copy(){return copy;},set response(value){response=value;}};
}
test('support sends safe diagnostics automatically without report fields or copy buttons',async t=>{
  const f=supportFixture(t);await f.api.checkAppVersion(true);const $=f.actions.$;
  assert.equal($('#support-open-telegram').disabled,false);assert.equal($('#support-contact').hidden,true);assert.equal($('#support-chat-fallback').rel,'noopener noreferrer');
  for(const selector of ['#support-report','#support-version','#support-include-details','#support-copy-report','#support-copy-message','#support-copy-text'])assert.equal($(selector),null);
  $('#support-description').value='Synthetic question';$('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  const text=new URL(f.opened[0][0]).searchParams.get('text');assert.match(text,/Версия интерфейса: 1111111111111111/);assert.match(text,/Экран:/);assert.doesNotMatch(text,/PRIVATE_|DO_NOT_INCLUDE|cookie|token|password/i);assert.equal(f.copy,'');
  f.response={version:'1111111111111111',supportTelegram:'https://evil.test/'};await f.api.checkAppVersion(true);assert.equal($('#support-open-telegram').disabled,true);assert.match($('#support-contact').textContent,/пока не подключена/);
});
test('one-field support form validates and opens only an explicit Telegram draft, without fake delivery or private data',async t=>{
  const f=supportFixture(t);await f.api.checkAppVersion(true);const $=f.actions.$;
  const submit=()=>$('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  submit();assert.equal(f.opened.length,0);assert.equal($('#support-description').getAttribute('aria-invalid'),'true');assert.match($('#support-message').textContent,/Напишите/);
  $('#support-description').value='Не сохраняется запись: 12:00 & <проверка> ?';submit();assert.equal(f.opened.length,1);
  const [href,target,flags]=f.opened[0],url=new URL(href),text=url.searchParams.get('text');
  assert.equal(url.origin,'https://t.me');assert.equal(url.pathname,'/Help_Cartoteca');assert.match(text,/12:00 & <проверка> \?/);assert.match(text,/Версия интерфейса/);assert.doesNotMatch(text,/PRIVATE_|DO_NOT_INCLUDE/);
  assert.equal(target,'_blank');assert.equal(flags,'noopener,noreferrer');assert.equal($('#support-chat-fallback').href,href);assert.match($('#support-message').textContent,/ничего ещё не отправлено/);assert.equal($('#support-description').value,'Не сохраняется запись: 12:00 & <проверка> ?');
  submit();assert.match(new URL(f.opened[1][0]).searchParams.get('text'),/Версия интерфейса/);
  $('#support-description').value='x'.repeat(1501);submit();assert.equal(f.opened.length,2);assert.match($('#support-message').textContent,/1500/);
});
test('support draft survives version checks and view changes without Telegram or clipboard',async t=>{
  const f=supportFixture(t,{clipboard:false});await f.api.checkAppVersion(true);const $=f.actions.$;
  $('#support-description').value='Без связи не сохраняется запись';$('#support-description').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  f.response={version:'1111111111111111',supportTelegram:''};await f.api.checkAppVersion(true);assert.equal($('#support-description').value,'Без связи не сохраняется запись');assert.equal($('#support-include-details'),null);
  $('#global-view').innerHTML='<section class="settings-panel">'+f.api.supportSettingsHtml()+'</section>';await f.api.checkAppVersion();assert.equal($('#support-description').value,'Без связи не сохраняется запись');assert.equal($('#support-include-details'),null);
  $('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(f.opened.length,0);assert.match($('#support-message').textContent,/пока недоступна/);
  assert.equal($('#support-copy-message'),null);assert.equal($('#support-description').readOnly,false);
  f.state.account={id:'another',organizationId:'another'};$('#global-view').innerHTML='<section class="settings-panel">'+f.api.supportSettingsHtml()+'</section>';assert.equal($('#support-description').value,'');
});
test('new release prompts but never auto-reloads; open editors, unsaved settings and in-flight saves block update',async t=>{
  const f=supportFixture(t);await f.api.checkAppVersion(true);const $=f.actions.$;
  assert.ok($('#app-version-notice'));assert.equal(f.reloads,0);assert.equal(f.fetches,1);
  f.w.dispatchEvent(new f.w.Event('focus'));await new Promise(r=>setImmediate(r));assert.equal(f.fetches,1);
  $('#editor').open=true;$('#support-reload').click();assert.equal(f.reloads,0);$('#editor').open=false;
  f.state.busy=true;$('#support-reload').click();assert.equal(f.reloads,0);f.state.busy=false;
  const form=f.w.document.createElement('form');form.innerHTML='<input name="setting" value="saved"><select name="period"><option>Default</option><option>Other</option></select>';$('.settings-panel').append(form);f.actions.markSettingsSaved(form);
  form.querySelector('input').value='unsaved';$('#support-reload').click();assert.equal(f.reloads,0);
  form.querySelector('input').value='saved';form.querySelector('select').selectedIndex=1;$('#support-reload').click();assert.equal(f.reloads,0);
  form.querySelector('select').selectedIndex=0;$('#support-reload').click();assert.equal(f.reloads,1);assert.ok(f.notices.length>=4);
});
test('confirmed settings permit reload without reopening; further edits still block it',async t=>{
  const f=supportFixture(t);await f.api.checkAppVersion(true);const $=f.actions.$;
  const form=f.w.document.createElement('form');form.innerHTML='<input name="city" value="initial"><input type="checkbox" name="enabled"><select name="period"><option>First</option><option>Second</option></select>';
  $('.settings-panel').append(form);f.actions.markSettingsSaved(form);
  form.elements.city.value='Saved city';form.elements.enabled.checked=true;form.elements.period.selectedIndex=1;
  $('#support-reload').click();assert.equal(f.reloads,0);
  f.actions.markSettingsSaved(form);$('#support-reload').click();assert.equal(f.reloads,1);
  assert.equal(form.elements.city.defaultValue,'initial');assert.equal(form.elements.enabled.defaultChecked,false);
  form.elements.city.value='Further draft';$('#support-reload').click();assert.equal(f.reloads,1);
});
test('support privacy help combines reply channel and diagnostics warning, without clearing cache',async t=>{
  const f=supportFixture(t,{clipboard:false});await f.api.checkAppVersion(true);
  f.response={version:'1111111111111111',supportTelegram:'',supportForm:true};await f.api.checkAppVersion(true);
  const w=f.w,source=read('src/client/modules/support.js');assert.doesNotMatch(source,/localStorage\.clear|caches\.delete|serviceWorker\.unregister|Clear-Site-Data/);
  const privacy=w.document.querySelector('#support-privacy-help [data-settings-help]');assert.match(privacy.dataset.helpText,/почту вашей учётной записи/);assert.match(privacy.dataset.helpText,/пароли, токены/);assert.match(privacy.dataset.helpText,/Автоматически прикладываются/);
  assert.equal(w.document.querySelector('#support-contact [data-settings-help]'),null);assert.equal(w.document.querySelector('#support-contact').hidden,true);assert.equal(w.document.querySelector('#support-report'),null);
});

test('server support works on HTTP crypto, retains retry key across resize and sends no clinical data',async t=>{
  const calls=[];let first=true;
  const f=supportFixture(t,{submitImpl:async(url,opts)=>{calls.push(JSON.parse(opts.body));if(first){first=false;throw TypeError('Synthetic connection loss');}return {ok:true,json:async()=>({receipt:{id:'22222222-2222-4222-8222-222222222222',replyEmail:'synthetic@example.test',deliveries:{telegram:'sent'}}})};}});
  f.response={version:'1111111111111111',supportTelegram:'',supportForm:true};await f.api.checkAppVersion(true);const $=f.actions.$;
  // Emulate HTTP Wi-Fi where randomUUID is unavailable but getRandomValues works.
  Object.defineProperty(f.w.crypto,'randomUUID',{value:undefined});
  assert.equal($('#support-open-telegram').textContent,'Отправить');
  $('#support-description').value='Не сохраняется вымышленная запись';$('#support-description').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  const submit=()=>$('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  submit();await new Promise(r=>setImmediate(r));assert.match($('#support-message').textContent,/дубль не создастся/);assert.equal($('#support-description').readOnly,false);
  Object.defineProperty(f.w,'innerWidth',{value:390,configurable:true});submit();submit();await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.deepEqual(calls[0].diagnostics,calls[1].diagnostics);
  assert.equal(calls[0].diagnostics.version,'1111111111111111');assert.equal(calls[0].diagnostics.view,'settings');assert.equal(calls[0].diagnostics.online,true);assert.ok(calls[0].diagnostics.width>0);assert.ok(calls[0].diagnostics.height>0);
  assert.doesNotMatch(JSON.stringify(calls),/PRIVATE_|DO_NOT_INCLUDE|email|cookie|token/);assert.equal(f.opened.length,0);
  assert.equal($('#support-description').value,'');assert.match($('#support-message').textContent,/передано поддержке/);assert.match($('#support-message').textContent,/synthetic@example.test/);assert.equal($('#support-open-telegram').disabled,false);
  assert.match($('#support-message').textContent,/Сообщение успешно отправлено/);assert.equal($('#support-message').dataset.status,'success');
});

test('support editor remains usable after navigating during a submission',async t=>{
  let release;
  const waiting=new Promise(r=>release=r);
  const f=supportFixture(t,{submitImpl:async()=>{await waiting;return {ok:true,json:async()=>({receipt:{id:'33333333-3333-4333-8333-333333333333',replyEmail:'synthetic@example.test',deliveries:{telegram:'sent'}}})};}});
  f.response={version:'1111111111111111',supportTelegram:'',supportForm:true};await f.api.checkAppVersion(true);const $=f.actions.$;
  $('#support-description').value='Synthetic question';$('#support-description').dispatchEvent(new f.w.Event('input',{bubbles:true}));$('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  $('#global-view').innerHTML='<section class="settings-panel">'+f.api.supportSettingsHtml()+'</section>';await f.api.checkAppVersion(true);assert.equal($('#support-description').readOnly,true);
  release();await new Promise(r=>setImmediate(r));assert.equal($('#support-description').readOnly,false);assert.equal($('#support-open-telegram').disabled,false);assert.equal($('#support-description').value,'');
});

test('support confirmation distinguishes acceptance, delivery and failure on mobile and desktop',async t=>{
  for(const width of [390,1440]){
    let deliveries={telegram:'pending',email:'pending'};
    const f=supportFixture(t,{submitImpl:async()=>({ok:true,json:async()=>({receipt:{id:'44444444-4444-4444-8444-444444444444',replyEmail:'synthetic@example.test',deliveries:{...deliveries}}})})});
    Object.defineProperty(f.w,'innerWidth',{value:width,configurable:true});
    const style=f.w.document.createElement('style');style.textContent=read('src/client/styles/settings.css');f.w.document.head.append(style);
    f.response={version:'1111111111111111',supportForm:true};await f.api.checkAppVersion(true);const $=f.actions.$;
    $('#support-description').value='Synthetic delivery check';$('#support-description').dispatchEvent(new f.w.Event('input',{bubbles:true}));
    $('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
    const message=$('#support-message');assert.equal(message.dataset.status,'pending');assert.match(message.textContent,/Сообщение принято/);assert.doesNotMatch(message.textContent,/успешно отправлено/);
    assert.equal(message.getAttribute('aria-live'),'polite');assert.equal(message.getAttribute('aria-atomic'),'true');
    deliveries={telegram:'sent',email:'failed'};await f.actions.refreshSupportReceipt();
    assert.equal(message.dataset.status,'success');assert.match(message.textContent,/Сообщение успешно отправлено/);assert.match(message.textContent,/Почтовая копия не доставлена/);
    assert.equal(f.w.getComputedStyle(message).backgroundColor,'rgb(237, 247, 240)');assert.equal(f.w.getComputedStyle(message).whiteSpace,'pre-line');
    $('#support-description').value='A new question';$('#support-description').dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(message.textContent,'');assert.equal(message.dataset.status,'');
    deliveries={telegram:'failed',email:'waiting'};
    $('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(message.dataset.status,'pending');
    deliveries={telegram:'failed',email:'sent'};await f.actions.refreshSupportReceipt();assert.equal(message.dataset.status,'success');
    deliveries={telegram:'failed',email:'failed'};await f.actions.refreshSupportReceipt();
    assert.equal(message.dataset.status,'error');assert.doesNotMatch(message.textContent,/успешно отправлено/);assert.match(message.textContent,/сохранено в картотеке/);
  }
});

test('support errors never reuse a previous success and preserve the unsent draft',async t=>{
  let fail=false;
  const f=supportFixture(t,{submitImpl:async()=>{if(fail)throw TypeError('Synthetic offline');return {ok:true,json:async()=>({receipt:{id:'55555555-5555-4555-8555-555555555555',replyEmail:'synthetic@example.test',deliveries:{telegram:'sent'}}})};}});
  f.response={version:'1111111111111111',supportForm:true};await f.api.checkAppVersion(true);const $=f.actions.$;
  const submit=()=>$('#support-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
  $('#support-description').value='First question';submit();await new Promise(r=>setImmediate(r));assert.equal($('#support-message').dataset.status,'success');
  submit();assert.equal($('#support-message').dataset.status,'error');assert.doesNotMatch($('#support-message').textContent,/успешно отправлено/);
  fail=true;$('#support-description').value='Keep this unsent question';submit();await new Promise(r=>setImmediate(r));
  assert.equal($('#support-description').value,'Keep this unsent question');assert.equal($('#support-message').dataset.status,'error');assert.match($('#support-message').textContent,/дубль не создастся/);assert.doesNotMatch($('#support-message').textContent,/успешно отправлено/);
});
