const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { emailMessage } = require('../src/server/modules/notifications/email-message.cjs');
const { DatabaseSync } = require('node:sqlite');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const { platformInspection } = require('./helpers/platform-inspection.cjs');
const root = path.resolve(__dirname, '..');
const password = 'Synthetic-invitation-password-2026';
const mailToken = mail => new URLSearchParams(new URL(mail.url).hash.slice(1)).get('invite');
async function until(fn) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw Error('Invitation UI timeout'); await new Promise(r => setTimeout(r, 15)); }
}
async function fixture(t, { mail = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-email-invites-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({email:'owner@example.test', password, displayName:'Тестовый владелец', organizationName:'Тестовая организация'});
  platform.verifyEmail(owner.verificationToken);
  const other = await platform.registerOwner({email:'existing@example.test', password, displayName:'Существующий сотрудник', organizationName:'Другая организация'});
  platform.verifyEmail(other.verificationToken);
  const provision = async (email, role) => {
    const invite = platform.createInvitation({organizationId:owner.organizationId, invitedBy:owner.accountId, role});
    return platform.acceptInvitation({token:invite.token, email, password, displayName:'Тестовый сотрудник'});
  };
  const admin = await provision('admin@example.test', 'salon_admin');
  const staff = await provision('staff@example.test', 'cosmetologist');
  const outbox = [], windows = [], delivery = { send: async () => {} };
  const server = createMultiServer({dataDir:dir, telegramBot:null, supportBot:null,
    telegramAutostart:false, supportAutostart:false,
    sendMail:mail ? async (email, url, meta) => {outbox.push({email, url, ...meta}); await delivery.send();} : null});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Each explicit API test client keeps the context issued by its own login.
  // Browser bridges below keep real client headers and never inject this scope.
  const contexts = new Map();
  async function request(route, body, cookie='', method=body ? 'POST' : 'GET') {
    if (body && route === '/api/auth/invitations/accept')
      body = {privacyConsent:true, privacyConsentVersion:PRIVACY_VERSION, ...body};
    const response = await fetch(base + route, {method,
      headers:{Origin:base, Cookie:cookie, 'Content-Type':'application/json', 'X-Cartoteca-Request':'1', ...contexts.get(cookie)},
      body:body ? JSON.stringify(body) : undefined});
    const data=await response.json(),nextCookie=response.headers.get('set-cookie')?.split(';')[0];
    if(route==='/api/auth/login'&&response.ok&&data.user&&nextCookie)
      contexts.set(nextCookie,{'X-Cartoteca-Account-Id':data.user.id,'X-Cartoteca-Organization-Id':data.organizationId||''});
    return {status:response.status, data, cookie:nextCookie,
      retryAfter:response.headers.get('retry-after')};
  }
  const login = async email => (await request('/api/auth/login', {email, password})).cookie;
  const cookie = await login('owner@example.test');
  const invite = (email='new@example.test', role='cosmetologist', as=cookie) => request('/api/organization/invitations', {email, role}, as);
  function raw(callback) {
    const database = createPlatformDatabase(path.join(dir, 'platform'));
    try {return callback(database);} finally {database.db.close();}
  }
  function releaseCooldown() {
    raw(({db}) => {db.prepare("DELETE FROM login_limits WHERE key LIKE 'public:invitation:%'").run();
      db.prepare('UPDATE email_invitations SET attempted_at=?').run(Date.now()-61000);});
  }
  async function loginUi(url, as=cookie) {
    const errors=[], console = new VirtualConsole(); console.on('jsdomError', e => {if (!e.message.includes('navigation')) errors.push(e.message);});
    const w = new JSDOM(fs.readFileSync(assetPath('login.html'),'utf8'),
      {url, runScripts:'outside-only', virtualConsole:console, pretendToBeVisual:true}).window;
    windows.push(w);
    w.fetch=(route, options={})=>fetch(base+route,{...options,headers:{...options.headers,Origin:base,Cookie:as}});
    w.eval(fs.readFileSync(assetPath('login.js'),'utf8'));
    await until(()=>w.document.querySelector('#auth-submit').textContent==='Принять приглашение');
    return {w, errors, $:selector=>w.document.querySelector(selector)};
  }
  async function appUi(width) {
    const console = new VirtualConsole(); const errors=[];console.on('jsdomError',e=>errors.push(e.message));
    const w=new JSDOM(fs.readFileSync(assetPath('index.html'),'utf8'),{url:base,runScripts:'outside-only',virtualConsole:console,pretendToBeVisual:true}).window;
    windows.push(w);w.fetch=(route,options={})=>fetch(base+route,{...options,headers:{...options.headers,Origin:base,Cookie:cookie}});
    w.AbortController=AbortController;w.structuredClone=structuredClone;
    w.matchMedia=()=>({matches:width<=700,addEventListener(){}});w.confirm=()=>true;
    require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
    require('./helpers/client-bundle.cjs').evaluateClient(w);await until(()=>!w.document.body.classList.contains('app-loading'));
    w.document.querySelector('[data-view="settings"]').click();await until(()=>w.document.querySelector('#invite-member-form'));
    return {w, errors, $:selector=>w.document.querySelector(selector)};
  }
  t.after(async()=>{windows.forEach(w=>{w.dispatchEvent(new w.Event('pagehide'));w.close();});await new Promise(r=>server.close(r));platform.close();
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('cartoteca-email-invites-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {platform, owner, other, admin, staff, base, request, login, cookie, outbox, invite, raw, releaseCooldown, delivery, loginUi, appUi,
    inspect:()=>platformInspection(path.join(dir,'platform'))};
}

test('email invitation delivers metadata, grants nothing before acceptance, then creates only membership and account', async t=>{
  const f=await fixture(t), before=f.inspect();
  const response=await f.invite('new@example.test','salon_admin');assert.equal(response.status,201);
  assert.equal(response.data.inviteUrl,undefined);assert.doesNotMatch(JSON.stringify(response.data),/token_hash|passwordHash|#invite=/);
  assert.equal(f.inspect().accounts.length,before.accounts.length);
  const sent=f.outbox[0];assert.equal(sent.email,'new@example.test');assert.equal(sent.kind,'invitation');
  assert.equal(sent.organizationName,'Тестовая организация');assert.equal(sent.roleName,'Администратор');
  assert.ok(sent.url.startsWith(f.base+'/login.html#invite='));
  const token=mailToken(sent), info=await f.request('/api/auth/invitations/info',{token});
  assert.equal(info.status,200);assert.equal(info.data.existingAccount,false);assert.equal(info.data.passwordSetupRequired,true);assert.equal(info.data.email,sent.email);
  assert.equal((await f.request('/api/auth/invitations/accept',{token,email:'wrong@example.test',password,passwordConfirmation:password,displayName:'Новый'})).status,403);
  const accepted=await f.request('/api/auth/invitations/accept',{token,email:sent.email,password,passwordConfirmation:password,displayName:'Новый администратор'});
  assert.equal(accepted.status,200);assert.equal(accepted.data.role,'salon_admin');
  const access=await f.request('/api/organization/access',null,f.cookie);assert.equal(access.data.invitations[0].status,'accepted');
  const employeeCookie=await f.login(sent.email);assert.ok(employeeCookie);
  assert.equal((await f.request('/api/auth/session',null,employeeCookie)).data.user.role,'salon_admin');
  assert.equal(f.inspect().organizations.length,before.organizations.length);
  assert.equal((await f.request('/api/auth/invitations/accept',{token,email:sent.email,password,displayName:'Повтор'})).status,400);
  f.raw(({db})=>{const row=db.prepare('SELECT value FROM email_invitations').get();assert.equal(Buffer.from(row.value).includes(Buffer.from(sent.email)),false);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM platform_audit').all()),/new@example.test/);});
});

test('a recipient who already has an active organization requires a separate email before sending another invitation',async t=>{
  const f=await fixture(t),before=f.inspect(),memberships=f.platform.memberships(f.other.accountId);
  const identity=f.raw(({db})=>Buffer.from(db.prepare('SELECT value FROM accounts WHERE id=?').get(f.other.accountId).value));
  const response=await f.invite('existing@example.test');
  assert.equal(response.status,409);assert.match(response.data.error,/другой.*почт/i);
  assert.equal(f.outbox.length,0);assert.deepEqual(f.inspect(),before);
  assert.deepEqual(f.platform.memberships(f.other.accountId),memberships);
  f.raw(({db})=>{
    assert.deepEqual(Buffer.from(db.prepare('SELECT value FROM accounts WHERE id=?').get(f.other.accountId).value),identity);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM email_invitations').get().n,0);
  });
  const logged=await f.platform.login('existing@example.test',password);
  assert.equal(logged.account.displayName,'Существующий сотрудник');
  assert.equal(f.platform.session(logged.token).organizationId,f.other.organizationId);
});

test('an invitation issued before registration was completed cannot later add a second active organization',async t=>{
  const f=await fixture(t),email='became-established@example.test';
  const recipient=await f.platform.registerOwner({email,password,displayName:'Существующий владелец',organizationName:'Единственная организация'});
  assert.equal((await f.invite(email)).status,201);
  const token=mailToken(f.outbox[0]);f.platform.verifyEmail(recipient.verificationToken);
  const before=f.raw(({db})=>JSON.stringify(Object.fromEntries(['accounts','organizations','memberships','invitations','email_invitations','platform_audit']
    .map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()]))));
  const info=await f.request('/api/auth/invitations/info',{token});
  assert.equal(info.status,409);assert.match(info.data.error,/другой.*почт/i);
  for(const supplied of ['Wrong-synthetic-password',password]){
    const response=await f.request('/api/auth/invitations/accept',{token,email,password:supplied,displayName:'Не заменять'});
    assert.equal(response.status,409);assert.match(response.data.error,/другой.*почт/i);
  }
  assert.equal(f.raw(({db})=>JSON.stringify(Object.fromEntries(['accounts','organizations','memberships','invitations','email_invitations','platform_audit']
    .map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()])))),before);
  assert.equal(f.platform.memberships(recipient.accountId).length,1);
  assert.equal(f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId)[0].status,'sent');
});

test('no mail creates no invitation; failed/pending/manual links cannot be accepted through HTTP',async t=>{
  const f=await fixture(t,{mail:false});assert.equal((await f.invite()).status,503);
  assert.deepEqual(f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId),[]);
  const noMailUi=await f.appUi(390);
  assert.equal(noMailUi.$('#invite-member-form button[type="submit"]').disabled,true);
  assert.match(noMailUi.$('#team-settings').textContent,/Отправка писем.*не настроена/);
  const legacy=f.platform.createInvitation({organizationId:f.owner.organizationId,invitedBy:f.owner.accountId,role:'cosmetologist',email:'legacy@example.test'});
  assert.equal((await f.request('/api/auth/invitations/accept',{token:legacy.token,email:'legacy@example.test',password,displayName:'Legacy',requireEmailDelivery:false})).status,400);
  const mailed=await fixture(t);mailed.delivery.send=async()=>{throw Error('SMTP secret must not leak');};
  const failed=await mailed.invite();assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed.data),/SMTP secret/);
  const token=mailToken(mailed.outbox[0]);assert.equal((await mailed.request('/api/auth/invitations/info',{token})).status,400);
  assert.equal(mailed.platform.emailInvitations(mailed.owner.organizationId,mailed.owner.accountId)[0].status,'failed');
});

test('resend rotates token, throttles duplicates, expiry and revoke forbid acceptance',async t=>{
  const f=await fixture(t);const first=await f.invite(),id=first.data.access.invitations[0].id,old=mailToken(f.outbox[0]);
  const resend=()=>f.request('/api/organization/invitations/resend',{invitationId:id},f.cookie);
  const limited=await resend();assert.equal(limited.status,429);assert.ok(Number(limited.retryAfter)>0);assert.equal(f.outbox.length,1);
  f.releaseCooldown();assert.equal((await resend()).status,200);const current=mailToken(f.outbox[1]);assert.notEqual(old,current);
  assert.equal((await f.request('/api/auth/invitations/info',{token:old})).status,400);
  assert.equal((await f.request('/api/auth/invitations/info',{token:current})).status,200);
  f.raw(({db})=>db.prepare('UPDATE invitations SET expires_at=? WHERE token_hash=(SELECT token_hash FROM email_invitations WHERE id=?)').run(Date.now()-1,id));
  assert.equal(f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId)[0].status,'expired');
  assert.equal((await f.request('/api/auth/invitations/info',{token:current})).status,400);
  f.releaseCooldown();assert.equal((await resend()).status,200);const newest=mailToken(f.outbox[2]);
  assert.equal((await f.request('/api/organization/invitations/revoke',{invitationId:id},f.cookie)).status,200);
  assert.equal((await f.request('/api/auth/invitations/accept',{token:newest,email:'new@example.test',password,displayName:'Новый'})).status,400);
  assert.deepEqual(f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId),[]);
  assert.equal((await resend()).status,404);f.releaseCooldown();assert.equal((await resend()).status,404);
});

test('invitation management is scoped to organization and allowed roles',async t=>{
  const f=await fixture(t),adminCookie=await f.login('admin@example.test'),staffCookie=await f.login('staff@example.test'),otherCookie=await f.login('existing@example.test');
  for (const email of ['first,last@example.test','alice@example.test;attacker','name<mail@example.test>'])
    assert.equal((await f.invite(email)).status,400);
  assert.equal(f.outbox.length,0);
  assert.equal((await f.invite('no@example.test','cosmetologist',staffCookie)).status,403);
  assert.equal((await f.invite('no@example.test','salon_admin',adminCookie)).status,403);
  const own=await f.invite('nextadmin@example.test','salon_admin'),id=own.data.access.invitations[0].id;
  assert.equal((await f.request('/api/organization/invitations/revoke',{invitationId:id},adminCookie)).status,403);
  assert.equal((await f.request('/api/organization/invitations/revoke',{invitationId:id},otherCookie)).status,404);
  assert.equal((await f.request('/api/organization/invitations/resend',{invitationId:id},staffCookie)).status,403);
  assert.equal((await f.invite('nextstaff@example.test','cosmetologist',adminCookie)).status,201);
});

test('revocation during delivery or password hashing cannot later grant access',async t=>{
  const f=await fixture(t);let release;
  f.delivery.send=()=>new Promise(resolve=>{release=resolve;});const sending=f.invite();await until(()=>release);
  const row=f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId)[0];
  assert.equal((await f.request('/api/auth/invitations/info',{token:mailToken(f.outbox[0])})).status,400);
  assert.equal((await f.request('/api/organization/invitations/revoke',{invitationId:row.id},f.cookie)).status,200);
  release();assert.equal((await sending).status,409);assert.deepEqual(f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId),[]);
  f.delivery.send=async()=>{};await f.invite('hashing@example.test');const token=mailToken(f.outbox.at(-1));
  const hashRow=f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId).find(r=>r.email==='hashing@example.test');
  const accepting=f.platform.acceptEmailInvitation({token,email:'hashing@example.test',password,passwordConfirmation:password,displayName:'Новый'});
  f.platform.revokeEmailInvitation({organizationId:f.owner.organizationId,actorId:f.owner.accountId,invitationId:hashRow.id});
  await assert.rejects(accepting,{status:400});
  assert.equal(f.inspect().accounts.some(a=>a.email==='hashing@example.test'),false);
});

test('an invitation always shows acceptance even if another account is already logged in',async t=>{
  const f=await fixture(t);await f.invite();const h=await f.loginUi(f.outbox[0].url);
  assert.equal(h.$('#auth-email').value,'new@example.test');assert.equal(h.$('#auth-email').readOnly,true);
  assert.equal(h.$('#auth-name').required,true);assert.equal(h.$('#auth-repeat').required,true);
  assert.equal(h.$('#auth-password').autocomplete,'new-password');assert.equal(h.$('#auth-repeat').autocomplete,'new-password');
  assert.equal(h.$('#auth-password').minLength,12);assert.equal(h.$('#auth-password-label').textContent,'Придумайте пароль');
  assert.match(h.$('#auth-description').textContent,/Тестовая организация.*Сотрудник/);
  assert.match(h.$('#extra-message').textContent,/owner@example.test.*new@example.test/);
  assert.equal(h.w.location.hash,new URL(f.outbox[0].url).hash);assert.equal(h.$('#auth-organization').required,false);
  h.$('#auth-name').value='Новый сотрудник';h.$('#auth-password').value=password;h.$('#auth-repeat').value=password;
  assert.equal(h.$('#auth-privacy-consent').checked,false);
  h.$('#auth-privacy-consent').checked=true;
  h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.$('#extra-message').textContent.includes('Приглашение принято'));
  assert.equal(h.w.location.hash,'');
  assert.equal(h.$('#auth-submit').textContent,'Войти');assert.equal(h.$('#auth-name').required,false);
  assert.equal(h.$('#auth-repeat').required,false);assert.equal(h.$('#auth-repeat-field').hidden,true);assert.equal(h.$('#auth-password').value,'');
  assert.deepEqual(h.errors,[]);
});

test('existing recipient form asks for current password without name or password repetition',async t=>{
  const f=await fixture(t);
  f.raw(({db})=>db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.other.organizationId));
  await f.invite('existing@example.test','salon_admin');const h=await f.loginUi(f.outbox[0].url);
  assert.equal(h.$('#auth-name').closest('label').hidden,true);assert.equal(h.$('#auth-name').required,false);
  assert.equal(h.$('#auth-repeat-field').hidden,true);assert.equal(h.$('#auth-repeat').required,false);
  assert.equal(h.$('#auth-password').autocomplete,'current-password');assert.match(h.$('#auth-help').textContent,/прежний пароль/);
});

test('an unfinished recipient creates and confirms a first password while keeping their account',async t=>{
  const f=await fixture(t),email='unfinished@example.test';
  const pending=await f.platform.registerOwner({email,password,displayName:'Незавершённое имя',organizationName:'Незавершённая организация'});
  await f.invite(email,'salon_admin');const token=mailToken(f.outbox[0]);
  const info=(await f.request('/api/auth/invitations/info',{token})).data;
  assert.equal(info.existingAccount,true);assert.equal(info.passwordSetupRequired,true);
  const h=await f.loginUi(f.outbox[0].url),replacement='Replacement-invitation-password-2026',payloads=[];
  const fetch=h.w.fetch;h.w.fetch=(route,options={})=>{if(route==='/api/auth/invitations/accept')payloads.push(JSON.parse(options.body));return fetch(route,options);};
  assert.equal(h.$('#auth-name').closest('label').hidden,false);assert.equal(h.$('#auth-name').required,true);
  assert.equal(h.$('#auth-name').value,'');assert.equal(h.$('#auth-name').autocomplete,'off');assert.equal(h.$('#auth-repeat-field').hidden,false);
  assert.equal(h.$('#auth-repeat').required,true);assert.equal(h.$('#auth-password').autocomplete,'new-password');
  assert.equal(h.$('#auth-repeat').autocomplete,'new-password');assert.equal(h.$('#auth-password').minLength,12);
  assert.equal(h.$('#auth-password-label').textContent,'Придумайте пароль');assert.doesNotMatch(h.$('#auth-help').textContent,/прежний пароль/);
  assert.equal(h.$('#auth-privacy-consent').required,true);assert.match(h.$('#extra-message').textContent,/Пароль текущего аккаунта не нужен/);
  h.$('#auth-name').value='Подтверждённое имя';h.$('#auth-password').value=replacement;h.$('#auth-repeat').value='Different-synthetic-password';
  h.$('#auth-privacy-consent').checked=true;h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(payloads.length,0);assert.match(h.$('#auth-error').textContent,/совпада/);
  h.$('#auth-repeat').value=replacement;h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.$('#extra-message').textContent.includes('Приглашение принято'));
  assert.equal(payloads.length,1);assert.equal(payloads[0].passwordConfirmation,replacement);
  assert.equal(f.inspect().accounts.find(a=>a.email===email).id,pending.accountId);
  const memberships=f.platform.memberships(pending.accountId);
  assert.equal(memberships.length,2);assert.equal(memberships.filter(member=>member.status==='active').length,1);
  assert.equal(memberships.find(member=>member.organizationId===pending.organizationId).status,'suspended');
  assert.equal(f.platform.organization(pending.organizationId).status,'suspended');assert.deepEqual(h.errors,[]);
});

test('a rejected invitation acceptance preserves the first-password form and permits retry',async t=>{
  const f=await fixture(t);await f.invite('retry@example.test','salon_admin');
  const h=await f.loginUi(f.outbox[0].url),replacement='Retry-synthetic-invitation-password',payloads=[];
  const fetch=h.w.fetch;h.w.fetch=(route,options={})=>{
    if(route==='/api/auth/invitations/accept'){
      payloads.push(JSON.parse(options.body));
      if(payloads.length===1)return Promise.resolve(new Response(JSON.stringify({error:'Синтетический отказ принятия.'}),{status:400,headers:{'Content-Type':'application/json'}}));
    }
    return fetch(route,options);
  };
  h.$('#auth-name').value='Сотрудник после повтора';h.$('#auth-password').value=replacement;
  h.$('#auth-repeat').value=replacement;h.$('#auth-privacy-consent').checked=true;
  h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.$('#auth-error').textContent==='Синтетический отказ принятия.'&&!h.$('#auth-submit').disabled);
  assert.equal(h.$('#auth-name').value,'Сотрудник после повтора');assert.equal(h.$('#auth-email').value,'retry@example.test');
  assert.equal(h.$('#auth-password').value,replacement);assert.equal(h.$('#auth-repeat').value,replacement);
  assert.equal(h.$('#auth-privacy-consent').checked,true);assert.equal(h.$('#auth-repeat-field').hidden,false);
  assert.equal(h.$('#auth-submit').textContent,'Принять приглашение');
  assert.equal(f.inspect().accounts.some(account=>account.email==='retry@example.test'),false);
  h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.$('#extra-message').textContent.includes('Приглашение принято'));
  assert.equal(payloads.length,2);assert.deepEqual(payloads[1],payloads[0]);
  assert.equal(h.$('#auth-error').textContent,'');assert.equal(h.$('#auth-submit').textContent,'Войти');
  assert.equal(h.$('#auth-password').value,'');assert.equal(h.$('#auth-repeat').value,'');assert.deepEqual(h.errors,[]);
});

test('first-password acceptance logs in with the new password and selects the invited organization before opening the cabinet',async t=>{
  const f=await fixture(t),email='ui-login@example.test',replacement='New-ui-synthetic-invitation-password';
  const pending=await f.platform.registerOwner({email,password,displayName:'Незавершённый получатель',organizationName:'Собственная организация'});
  await f.invite(email,'salon_admin');const h=await f.loginUi(f.outbox[0].url),routes=[],bodies=[];
  let browserCookie=f.cookie,shellSession=null;
  h.w.fetch=async(route,options={})=>{
    const routeName=route.split('?')[0];routes.push(routeName);
    if(options.body)bodies.push({route:routeName,body:JSON.parse(options.body)});
    if(routeName==='/index.html')shellSession=(await f.request('/api/auth/session',null,browserCookie)).data;
    const response=await fetch(f.base+route,{...options,headers:{...options.headers,Origin:f.base,Cookie:browserCookie}});
    const nextCookie=response.headers.get('set-cookie');if(nextCookie)browserCookie=nextCookie.split(';')[0];
    return response;
  };
  h.$('#auth-name').value='Получатель приглашения';h.$('#auth-password').value=replacement;
  h.$('#auth-repeat').value=replacement;h.$('#auth-privacy-consent').checked=true;
  h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.$('#extra-message').textContent.includes('Приглашение принято'));
  assert.equal(h.$('#auth-email').value,email);assert.equal(h.$('#auth-email').readOnly,true);
  assert.equal(h.$('#auth-password').value,'');assert.equal(h.$('#auth-repeat').value,'');
  assert.equal(h.$('#auth-password').autocomplete,'current-password');assert.equal(h.$('#auth-repeat-field').hidden,true);
  h.$('#auth-password').value=replacement;
  h.$('#auth-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.w.document.title==='Картотека · кабинет');
  assert.deepEqual(routes,['/api/auth/invitations/accept','/api/auth/login','/api/auth/select-organization','/index.html']);
  assert.deepEqual(bodies.find(item=>item.route==='/api/auth/login').body,{email,password:replacement});
  assert.deepEqual(bodies.find(item=>item.route==='/api/auth/select-organization').body,{organizationId:f.owner.organizationId});
  assert.equal(shellSession.user.id,pending.accountId);assert.equal(shellSession.user.email,email);
  assert.equal(shellSession.user.organizationId,f.owner.organizationId);assert.equal(shellSession.user.role,'salon_admin');
  const memberships=f.platform.memberships(pending.accountId);
  assert.equal(memberships.length,2);assert.equal(memberships.filter(member=>member.status==='active').length,1);
  assert.equal(memberships.find(member=>member.organizationId===pending.organizationId).status,'suspended');
  assert.equal(f.platform.organization(pending.organizationId).status,'suspended');assert.deepEqual(h.errors,[]);
});

for(const width of [390,1440]) test('team UI sends mail and renders status/revoke without manual link at width '+width,async t=>{
  const f=await fixture(t),h=await f.appUi(width),form=h.$('#invite-member-form');
  form.elements.email.value='ui@example.test';form.elements.role.value='salon_admin';
  form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>h.$('.team-invitation'));
  assert.match(h.$('#team-message').textContent,/отправлено на почту/);assert.equal(h.$('#invite-link'),null);
  assert.equal(h.$('.team-invitation').dataset.invitationStatus,'sent');assert.match(h.$('.team-invitation').textContent,/ui@example.test/);
  h.$('[data-invitation-action="revoke"]').click();await until(()=>!h.$('.team-invitation'));
  assert.equal(h.$('#team-invitations'),null);assert.match(h.$('#team-message').textContent,/отозвано/);
  assert.equal(h.$('[data-invitation-action="resend"]'),null);assert.deepEqual(h.errors,[]);
});

test('a stale revoke button refreshes an already removed invitation without restoring it',async t=>{
  const f=await fixture(t);await f.invite();const h=await f.appUi(390);
  const invitation=f.platform.emailInvitations(f.owner.organizationId,f.owner.accountId)[0];
  assert.equal((await f.request('/api/organization/invitations/revoke',{invitationId:invitation.id},f.cookie)).status,200);
  h.$('[data-invitation-action="revoke"]').click();
  await until(()=>h.$('#team-message')?.textContent==='Приглашение уже удалено.');
  assert.equal(h.$('.team-invitation'),null);assert.equal(h.$('#team-invitations'),null);
  assert.deepEqual(h.errors,[]);
});

test('accepted status and new employee refresh without overwriting invitation or specialty drafts',async t=>{
  const f=await fixture(t);await f.invite();const h=await f.appUi(390);
  h.$('#team-settings').closest('details').open=true;
  h.$('#invite-member-form').elements.email.value='draft@example.test';
  const specialty=h.$('[data-member-specialty] input');specialty.value='Несохранённая специальность';
  await f.request('/api/auth/invitations/accept',{token:mailToken(f.outbox[0]),email:'new@example.test',password,passwordConfirmation:password,displayName:'Новый сотрудник'});
  h.w.dispatchEvent(new h.w.Event('focus'));
  await until(()=>h.$('.team-invitation')?.dataset.invitationStatus==='accepted');
  assert.equal(h.$('#invite-member-form').elements.email.value,'draft@example.test');
  assert.equal(specialty.value,'Несохранённая специальность');assert.equal(specialty.isConnected,true);
  assert.match(h.$('.team-members').textContent,/Новый сотрудник/);
});

test('a replacement administrator receives separate access after the previous administrator is suspended',async t=>{
  const f=await fixture(t), oldCookie=await f.login('admin@example.test');
  const cabinet=(await f.request('/api/cabinet',null,f.cookie)).data;
  cabinet.patients.push({id:'history',name:'Тестовый клиент',createdBy:f.admin.accountId,appointments:[],
    visits:[{id:'old-visit',date:'2020-01-01',procedure:'Старая услуга',staffId:f.admin.accountId,photos:[],notes:'Сохранённая история'}]});
  assert.equal((await f.request('/api/cabinet',cabinet,f.cookie,'PUT')).status,200);
  assert.equal((await f.request('/api/organization/members',{accountId:f.admin.accountId,role:'salon_admin',status:'suspended'},f.cookie)).status,200);
  assert.equal((await f.request('/api/organization/access',null,oldCookie)).status,401);
  const invitation=await f.invite('replacement@example.test','salon_admin');assert.equal(invitation.status,201);
  const accepted=await f.request('/api/auth/invitations/accept',{token:mailToken(f.outbox[0]),email:'replacement@example.test',password,passwordConfirmation:password,displayName:'Новый администратор'});
  assert.equal(accepted.status,200);assert.notEqual(accepted.data.accountId,f.admin.accountId);
  const newCookie=await f.login('replacement@example.test');assert.ok(newCookie);
  const members=(await f.request('/api/organization/access',null,f.cookie)).data.members;
  assert.equal(members.find(m=>m.accountId===f.admin.accountId).status,'suspended');
  assert.equal(members.find(m=>m.accountId===accepted.data.accountId).role,'salon_admin');
  const history=(await f.request('/api/cabinet',null,newCookie)).data.patients.find(p=>p.id==='history');
  assert.equal(history.visits[0].notes,'Сохранённая история');
  assert.equal(history.visits[0].staffId,f.admin.accountId);
});

test('invitation email provides a button, role, safe organization name and plain text fallback',()=>{
  const message=emailMessage('https://example.test/login.html#invite=synthetic',{kind:'invitation',organizationName:'<img src=x onerror=alert(1)>',roleName:'Администратор'});
  assert.match(message.text,/Администратор/);assert.match(message.text,/7 дней/);assert.match(message.html,/Принять приглашение/);
  assert.doesNotMatch(message.html,/<img/);assert.match(message.html,/&lt;img/);assert.match(message.text,/https:\/\/example.test/);
  assert.equal(emailMessage('synthetic',{kind:'verify'}).subject,'Подтверждение регистрации в картотеке');
});

test('schema 8 snapshots schema 7, preserves accounts and rolls back a failed migration',async t=>{
  // Isolated database only: never downgrade the running fixture used by HTTP.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-invite-migration-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  let platform=createPlatformStore(dir);
  const owner=await platform.registerOwner({email:'migration@example.test',password,displayName:'Migration',organizationName:'Migration'});platform.verifyEmail(owner.verificationToken);platform.close();
  let raw=createPlatformDatabase(dir), original=Buffer.from(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(owner.accountId).value);
  require('./helpers/platform-inspection.cjs').dropAdminSchema(raw.db);raw.db.exec('DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; PRAGMA user_version=7');raw.db.close();
  platform=createPlatformStore(dir);platform.close();raw=createPlatformDatabase(dir);
  assert.equal(raw.db.prepare('PRAGMA user_version').get().user_version,11);
  assert.deepEqual(Buffer.from(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(owner.accountId).value),original);raw.db.close();
  const backupDir=path.join(dir,'migration-backups'), saved=fs.readdirSync(backupDir).find(n=>n.startsWith('before-008-'));
  const snapshot=new DatabaseSync(path.join(backupDir,saved,'platform.sqlite'),{readOnly:true});
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,7);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');snapshot.close();
  const count=fs.readdirSync(backupDir).length;platform=createPlatformStore(dir);platform.close();assert.equal(fs.readdirSync(backupDir).length,count);
  raw=createPlatformDatabase(dir);require('./helpers/platform-inspection.cjs').dropAdminSchema(raw.db);raw.db.exec('DROP TABLE email_invitations; CREATE TABLE email_invitations(bad TEXT); PRAGMA user_version=7');raw.db.close();
  assert.throws(()=>createPlatformStore(dir),/already exists/);raw=createPlatformDatabase(dir);
  assert.equal(raw.db.prepare('PRAGMA user_version').get().user_version,7);
  assert.deepEqual(Buffer.from(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(owner.accountId).value),original);raw.db.close();
});
