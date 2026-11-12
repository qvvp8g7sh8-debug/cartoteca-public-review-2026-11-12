const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlatformDatabase } = require('./src/server/infrastructure/platform-database.cjs');
const { createPlatformStore, FREE_LIMITS } = require('./platform-store.cjs');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-platform-'));
  const store = createPlatformStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test('registers isolated owner organization on the free plan', async t => {
  const store = temporaryStore(t);
  const created = await store.registerOwner({
    email: 'Owner@example.ru', password: 'very-secure-password',
    displayName: 'Анна', organizationName: 'Студия Анны',
    businessType: 'salon', city: 'Казань', phone: '+7 900 123-45-67'
  });
  const authenticated = await store.authenticate('owner@example.ru', 'very-secure-password');
  assert.equal(authenticated.account.id, created.accountId);
  assert.equal(authenticated.memberships[0].role, 'owner');
  assert.equal(authenticated.memberships[0].organizationId, created.organizationId);
  assert.deepEqual(store.subscription(created.organizationId).limits, FREE_LIMITS);
  const admin = await store.bootstrapGlobalAdmin({ email: 'root@example.ru', password: 'global-secure-password', displayName: 'Главный' });
  const profile = store.admin.organization(admin.accountId, created.organizationId);
  assert.equal(Object.hasOwn(profile, 'businessType'), false);
  assert.equal(profile.city, 'Казань');
  assert.equal(profile.phone, '+7 900 123-45-67');
  assert.equal(profile.ownerName, 'Анна');
});

test('keeps organizations separate for different owners', async t => {
  const store = temporaryStore(t);
  const first = await store.registerOwner({ email: 'a@example.ru', password: 'first-secure-password', displayName: 'А', organizationName: 'Салон' });
  const second = await store.registerOwner({ email: 'b@example.ru', password: 'second-secure-password', displayName: 'Б', organizationName: 'Салон' });
  assert.notEqual(first.organizationId, second.organizationId);
  assert.notEqual((await store.authenticate('a@example.ru', 'first-secure-password')).memberships[0].slug,
    (await store.authenticate('b@example.ru', 'second-secure-password')).memberships[0].slug);
});

test('owner and salon administrator can invite cosmetologists', async t => {
  const store = temporaryStore(t);
  const owner = await store.registerOwner({ email: 'owner@example.ru', password: 'owner-secure-password', displayName: 'Владелец', organizationName: 'Кабинет' });
  const invite = store.createInvitation({ organizationId: owner.organizationId, invitedBy: owner.accountId, role: 'salon_admin', email: 'admin@example.ru' });
  const accepted = await store.acceptInvitation({ token: invite.token, email: 'admin@example.ru', password: 'admin-secure-password', displayName: 'Администратор' });
  assert.equal(accepted.role, 'salon_admin');
  const secondInvite = store.createInvitation({ organizationId: owner.organizationId, invitedBy: accepted.accountId, role: 'cosmetologist', email: 'specialist@example.ru' });
  assert.ok(secondInvite.token.length > 30);
  assert.throws(() => store.createInvitation({ organizationId: owner.organizationId, invitedBy: owner.accountId, role: 'assistant' }), /Недопустимая роль/);
});

test('rejects duplicate accounts, reused invites and invalid roles', async t => {
  const store = temporaryStore(t);
  const owner = await store.registerOwner({ email: 'owner@example.ru', password: 'owner-secure-password', displayName: 'Владелец', organizationName: 'Кабинет' });
  store.verifyEmail(owner.verificationToken);
  await assert.rejects(() => store.registerOwner({ email: 'OWNER@example.ru', password: 'another-secure-password', displayName: 'Другой', organizationName: 'Другой' }), /уже существует/);
  assert.throws(() => store.createInvitation({ organizationId: owner.organizationId, invitedBy: owner.accountId, role: 'owner' }), /Недопустимая роль/);
  const invite = store.createInvitation({ organizationId: owner.organizationId, invitedBy: owner.accountId, role: 'cosmetologist' });
  await store.acceptInvitation({ token: invite.token, email: 'staff@example.ru', password: 'staff-secure-password', displayName: 'Сотрудник' });
  await assert.rejects(() => store.acceptInvitation({ token: invite.token, email: 'again@example.ru', password: 'again-secure-password', displayName: 'Ещё' }), /недействительно/);
});

test('global administrator can only be bootstrapped once', async t => {
  const store = temporaryStore(t);
  await store.bootstrapGlobalAdmin({ email: 'root@example.ru', password: 'global-secure-password', displayName: 'Главный администратор' });
  const authenticated = await store.authenticate('root@example.ru', 'global-secure-password');
  assert.equal(authenticated.account.globalAdmin, true);
  assert.deepEqual(authenticated.memberships, []);
  await assert.rejects(() => store.bootstrapGlobalAdmin({ email: 'second@example.ru', password: 'second-secure-password', displayName: 'Второй' }), /уже создан/);
});

test('one-time global administrator setup token creates the admin and expires', async t => {
  const store = temporaryStore(t);
  const token = store.issueGlobalAdminBootstrap();
  assert.deepEqual(store.globalAdminBootstrapStatus(token), { exists:false, valid:true });
  await store.consumeGlobalAdminBootstrap(token, { email:'root@example.ru', password:'global-secure-password', displayName:'Главный администратор' });
  assert.deepEqual(store.globalAdminBootstrapStatus(token), { exists:true, valid:false });
  assert.equal((await store.login('root@example.ru','global-secure-password')).account.globalAdmin,true);
  await assert.rejects(() => store.consumeGlobalAdminBootstrap(token, { email:'other@example.ru', password:'another-secure-password', displayName:'Другой' }), /недействительна/);
});

test('global administrator manages organization access, tariffs and user status without cabinet data', async t => {
  const store=temporaryStore(t);
  const owner=await store.registerOwner({email:'owner@example.ru',password:'owner-secure-password',displayName:'Владелец',organizationName:'Кабинет'});store.verifyEmail(owner.verificationToken);
  const admin=await store.bootstrapGlobalAdmin({email:'root@example.ru',password:'global-secure-password',displayName:'Главный'});
  const ownerLogin=await store.login('owner@example.ru','owner-secure-password');
  store.admin.updateProfile(admin.accountId,owner.organizationId,{requestId:crypto.randomUUID(),expectedRevision:0,changes:{name:'Студия красоты',businessType:'salon',city:'Москва',phone:'+7 999 111-22-33'}});
  store.admin.updateSubscription(admin.accountId,owner.organizationId,{requestId:crypto.randomUUID(),expectedRevision:0,reason:'Ручные тестовые условия',plan:'paid',limits:{patients:250,photos:5000,publicBooking:true,automaticNotifications:false}});
  const organization=store.admin.organization(admin.accountId,owner.organizationId);
  assert.equal(organization.plan,'paid');assert.equal(organization.limits.patients,250);assert.equal(organization.limits.automaticNotifications,false);
  assert.equal(organization.name,'Студия красоты');assert.equal(Object.hasOwn(organization,'businessType'),false);assert.equal(organization.city,'Москва');assert.equal(organization.phone,'+7 999 111-22-33');
  store.admin.updateAccountAccess(admin.accountId,owner.accountId,{requestId:crypto.randomUUID(),expectedRevision:store.admin.account(admin.accountId,owner.accountId).revision,reason:'Тест блокировки',status:'suspended'});assert.equal(store.session(ownerLogin.token),null);
  assert.equal(store.admin.account(admin.accountId,owner.accountId).status,'suspended');
  assert.throws(()=>store.admin.updateAccountAccess(admin.accountId,admin.accountId,{}),/собственную/);
});

test('global administrator prepares email replacement without revoking access until confirmation', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-email-recovery-'));
  const store=createPlatformStore(directory),database=createPlatformDatabase(directory);
  t.after(()=>{database.db.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const owner=await store.registerOwner({email:'owner@example.ru',password:'owner-secure-password',displayName:'Владелец',organizationName:'Кабинет'});store.verifyEmail(owner.verificationToken);
  const second=await store.registerOwner({email:'second@example.ru',password:'second-secure-password',displayName:'Второй',organizationName:'Студия'});
  const admin=await store.bootstrapGlobalAdmin({email:'root@example.ru',password:'global-secure-password',displayName:'Главный'});
  const session=await store.login('owner@example.ru','owner-secure-password');
  const input={requestId:crypto.randomUUID(),expectedRevision:store.admin.account(admin.accountId,owner.accountId).revision,reason:'Подтверждена принадлежность аккаунта',identityConfirmed:true,email:' New.Owner@Example.ru '};
  const result=store.admin.prepareEmailRecovery(admin.accountId,owner.accountId,input,'https://example.test');
  assert.equal(result.pending,true);
  assert.ok(store.session(session.token));
  const job=store.admin.emailQueue.claim();
  const token=new URL(job.payload.link).hash.split('=')[1];
  assert.equal(store.admin.confirmEmailRecovery(decodeURIComponent(token)).ok,true);
  assert.equal(store.session(session.token),null);
  await assert.rejects(()=>store.login('owner@example.ru','owner-secure-password'),/Неверная почта/);
  assert.equal((await store.login('new.owner@example.ru','owner-secure-password')).account.id,owner.accountId);
  assert.equal(store.admin.account(admin.accountId,owner.accountId).email,'new.owner@example.ru');
  const next={...input,requestId:crypto.randomUUID(),expectedRevision:store.admin.account(admin.accountId,owner.accountId).revision,email:'second@example.ru'};
  assert.throws(()=>store.admin.prepareEmailRecovery(admin.accountId,owner.accountId,next,'https://example.test'),/уже существует/);
  assert.throws(()=>store.admin.prepareEmailRecovery(admin.accountId,admin.accountId,{...next,expectedRevision:0,email:'other-root@example.ru'},'https://example.test'),/Системную/);
  assert.ok(second.accountId);
});

test('requires verified email before creating a session', async t => {
  const store = temporaryStore(t);
  const owner = await store.registerOwner({ email: 'owner@example.ru', password: 'owner-secure-password', displayName: 'Владелец', organizationName: 'Кабинет' });
  await assert.rejects(() => store.login('owner@example.ru', 'owner-secure-password'), /Подтвердите/);
  store.verifyEmail(owner.verificationToken);
  assert.throws(() => store.verifyEmail(owner.verificationToken), /недействительна/);
  const login = await store.login('owner@example.ru', 'owner-secure-password', 'test browser');
  const session = store.session(login.token);
  assert.equal(session.accountId, owner.accountId);
  assert.equal(session.organizationId, owner.organizationId);
  assert.equal(session.role, 'owner');
  store.logout(login.token);
  assert.equal(store.session(login.token), null);
});

test('imports existing owner password hash without asking for the password again', async t => {
  const source = temporaryStore(t);
  const registered = await source.registerOwner({ email: 'legacy@example.ru', password: 'legacy-secure-password', displayName: 'Старый владелец', organizationName: 'Старая картотека' });
  source.verifyEmail(registered.verificationToken);
  const sourceLogin = await source.authenticate('legacy@example.ru', 'legacy-secure-password');
  assert.equal(sourceLogin.account.email, 'legacy@example.ru');

  const crypto = require('node:crypto');
  const { promisify } = require('node:util');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = (await promisify(crypto.scrypt)('imported-secure-password', salt, 64, { N:32768,r:8,p:3,maxmem:64*1024*1024 })).toString('hex');
  const importedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-import-'));
  const imported = createPlatformStore(importedDirectory);
  t.after(() => { imported.close(); fs.rmSync(importedDirectory, { recursive: true, force: true }); });
  const result = imported.importLegacyOwner({ email: 'imported@example.ru', displayName: 'Владелец', organizationName: 'Картотека', salt, passwordHash });
  const login = await imported.login('imported@example.ru', 'imported-secure-password');
  assert.equal(login.organizationId, result.organizationId);
  await assert.rejects(() => imported.login('imported@example.ru', 'wrong-password'), /Неверная/);
});

test('password recovery is single-use and revokes existing sessions', async t => {
  const store = temporaryStore(t);
  const owner = await store.registerOwner({ email: 'owner@example.ru', password: 'owner-secure-password', displayName: 'Владелец', organizationName: 'Кабинет' });
  store.verifyEmail(owner.verificationToken);
  const login = await store.login('owner@example.ru', 'owner-secure-password');
  const reset = store.requestPasswordReset('owner@example.ru');
  assert.equal(typeof reset, 'string');
  await store.resetPassword(reset, 'new-owner-secure-password');
  assert.equal(store.session(login.token), null);
  await assert.rejects(() => store.resetPassword(reset, 'another-secure-password'), /недействительна/);
  await assert.rejects(() => store.login('owner@example.ru', 'owner-secure-password'), /Неверная/);
  assert.ok((await store.login('owner@example.ru', 'new-owner-secure-password')).token);
  assert.equal(store.requestPasswordReset('unknown@example.ru'), null);
});

test('temporarily blocks login after five wrong passwords and persists the limit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-login-limit-'));
  let store = createPlatformStore(directory);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(directory, { recursive:true, force:true }); });
  const owner = await store.registerOwner({ email:'owner@example.ru', password:'owner-secure-password', displayName:'Владелец', organizationName:'Кабинет' });
  store.verifyEmail(owner.verificationToken);
  for (let attempt = 1; attempt < 5; attempt++) {
    await assert.rejects(() => store.login('owner@example.ru', 'wrong-password', 'browser', '192.0.2.10'), new RegExp(`Осталось попыток: ${5 - attempt}`));
  }
  await assert.rejects(() => store.login('owner@example.ru', 'wrong-password', 'browser', '192.0.2.10'), /заблокирован на 15 минут/);
  store.close();
  store = createPlatformStore(directory);
  await assert.rejects(() => store.login('owner@example.ru', 'owner-secure-password', 'browser', '192.0.2.11'), /Повторите вход через 15 мин/);
});

test('successful login clears earlier failed-attempt counters', async t => {
  const store = temporaryStore(t);
  const owner = await store.registerOwner({ email:'owner@example.ru', password:'owner-secure-password', displayName:'Владелец', organizationName:'Кабинет' });
  store.verifyEmail(owner.verificationToken);
  for (let attempt = 0; attempt < 4; attempt++) await assert.rejects(() => store.login('owner@example.ru', 'wrong-password', 'browser', '192.0.2.20'), /Неверная/);
  assert.ok((await store.login('owner@example.ru', 'owner-secure-password', 'browser', '192.0.2.20')).token);
  await assert.rejects(() => store.login('owner@example.ru', 'wrong-password', 'browser', '192.0.2.20'), /Осталось попыток: 4/);
});
