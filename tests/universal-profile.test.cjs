const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs');
const { invitationMessage, appointmentMessage } = require('../src/server/modules/notifications/telegram-messages.cjs');
const password = 'Universal-test-password-2026';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-universal-'));
  let platform = createPlatformStore(dir);
  t.after(() => { platform.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  async function owner(email, name) {
    const result = await platform.registerOwner({email, password, displayName: name, organizationName: name, businessType: 'organization'});
    platform.verifyEmail(result.verificationToken);
    return {...result, token: (await platform.login(email, password)).token};
  }
  const first = await owner('first@example.test', 'Первая организация');
  const second = await owner('second@example.test', 'Вторая организация');
  const invite = platform.createInvitation({organizationId: first.organizationId, invitedBy: first.accountId, role: 'cosmetologist'});
  const staff = await platform.acceptInvitation({token: invite.token, email: 'staff@example.test', password, displayName: 'Анна Пример'});
  staff.token = (await platform.login('staff@example.test', password)).token;
  const global = await platform.bootstrapGlobalAdmin({email: 'global@example.test', password, displayName: 'Оператор'});
  global.token = (await platform.login('global@example.test', password)).token;
  return {get platform() {return platform;}, first, second, staff, global,
    raw(callback) { const database = createPlatformDatabase(dir); try { return callback(database); } finally { database.db.close(); } },
    restart() {platform.close(); platform = createPlatformStore(dir);}};
}

test('same-name accounts update only their own profile and reject foreign target fields atomically', async t => {
  const f = await fixture(t), p = f.platform, sameName = 'Same synthetic person name';
  p.updateAccountProfile(f.first.token, {displayName: sameName, specialty: 'First specialty', expectedSpecialty: '',
    organization: {name: 'First private organization', city: 'First city', phone: '111'}});
  p.updateAccountProfile(f.second.token, {displayName: sameName, specialty: 'Second specialty', expectedSpecialty: '',
    organization: {name: 'Second private organization', city: 'Second city', phone: '222'}});
  assert.notEqual(f.first.accountId, f.second.accountId);
  assert.equal(p.accountProfile(f.first.token).account.displayName, sameName);
  assert.equal(p.accountProfile(f.second.token).account.displayName, sameName);
  const ownState = user => f.raw(({db}) => JSON.stringify({
    account: db.prepare('SELECT * FROM accounts WHERE id=?').get(user.accountId),
    organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(user.organizationId),
    memberships: db.prepare('SELECT * FROM memberships WHERE account_id=? ORDER BY organization_id').all(user.accountId),
    subscription: db.prepare('SELECT * FROM subscriptions WHERE organization_id=?').get(user.organizationId),
  }));
  const allState = () => f.raw(({db}) => JSON.stringify(Object.fromEntries(
    ['accounts','organizations','memberships','subscriptions','platform_audit'].map(table =>
      [table, db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()]))));
  const firstBefore = ownState(f.first);
  p.updateAccountProfile(f.second.token, {displayName: 'Second updated person', specialty: 'Second updated specialty',
    expectedSpecialty: 'Second specialty', organization: {name: 'Second updated organization', city: 'Second updated city', phone: '333'}});
  assert.equal(ownState(f.first), firstBefore);
  assert.equal(p.accountProfile(f.second.token).account.displayName, 'Second updated person');
  assert.equal(p.accountProfile(f.second.token).organization.name, 'Second updated organization');
  const secondBefore = ownState(f.second);
  p.updateAccountProfile(f.first.token, {displayName: 'First updated person', specialty: 'First updated specialty', expectedSpecialty: 'First specialty'});
  assert.equal(ownState(f.second), secondBefore);
  for (const injected of [
    {accountId: f.second.accountId}, {id: f.second.accountId}, {email: 'second@example.test'},
    {organizationId: f.second.organizationId}, {user: {id: f.second.accountId}},
  ]) {
    const before = allState();
    assert.throws(() => p.updateAccountProfile(f.first.token, {displayName: 'Must not write', ...injected}), {status: 400});
    assert.equal(allState(), before);
  }
  const beforeNestedTarget = allState();
  assert.throws(() => p.updateAccountProfile(f.first.token, {displayName: 'Must not write', specialty: 'Must roll back',
    expectedSpecialty: 'First updated specialty', organization: {id: f.second.organizationId, name: 'Foreign write', city: '', phone: ''}}), {status: 400});
  assert.equal(allState(), beforeNestedTarget);
  const firstLogin = await p.login('first@example.test', password), secondLogin = await p.login('second@example.test', password);
  assert.equal(firstLogin.account.id, f.first.accountId); assert.equal(secondLogin.account.id, f.second.accountId);
  assert.equal(p.session(firstLogin.token).organizationId, f.first.organizationId);
  assert.equal(p.session(secondLogin.token).organizationId, f.second.organizationId);
  assert.equal(p.accountProfile(firstLogin.token).account.displayName, 'First updated person');
  assert.equal(p.accountProfile(secondLogin.token).account.displayName, 'Second updated person');
});

test('specialty is organization scoped, optional, owner/self only and survives restart without changing credentials', async t => {
  const f = await fixture(t), p = f.platform;
  p.updateAccountProfile(f.staff.token, {displayName: 'Анна Пример', specialty: 'Тренер', expectedSpecialty: ''});
  assert.equal(p.accountProfile(f.staff.token).specialty, 'Тренер');
  const otherInvite = p.createInvitation({organizationId: f.second.organizationId, invitedBy: f.second.accountId, role: 'cosmetologist'});
  const otherStaff = await p.acceptInvitation({token: otherInvite.token, email: 'other-staff@example.test', password, displayName: 'Анна Пример'});
  const otherToken = (await p.login('other-staff@example.test', password)).token;
  assert.notEqual(otherStaff.accountId, f.staff.accountId);
  assert.equal(p.session(otherToken).organizationId, f.second.organizationId);
  assert.equal(p.accountProfile(otherToken).specialty, '');
  p.updateAccountProfile(otherToken, {displayName: 'Анна Пример', specialty: 'Консультант', expectedSpecialty: ''});
  assert.equal(p.telegram.messageIdentity(f.first.organizationId, f.staff.accountId).specialty, 'Тренер');
  assert.equal(p.telegram.messageIdentity(f.second.organizationId, otherStaff.accountId).specialty, 'Консультант');
  assert.equal(p.telegram.messageIdentity(f.second.organizationId, f.staff.accountId).specialty, '');
  p.updateStaffSpecialty(f.first.token, {accountId: f.staff.accountId, specialty: 'Массажист', expectedSpecialty: 'Тренер'});
  assert.equal(p.accountProfile(f.staff.token).specialty, 'Массажист');
  assert.throws(() => p.updateAccountProfile(f.staff.token, {displayName: 'Анна Пример', specialty: 'Устаревшее', expectedSpecialty: 'Тренер'}), {status: 409});
  assert.throws(() => p.updateStaffSpecialty(f.staff.token, {accountId: f.first.accountId, specialty: 'Нет', expectedSpecialty: ''}), {status: 403});
  assert.throws(() => p.updateStaffSpecialty(f.global.token, {accountId: f.staff.accountId, specialty: 'Нет', expectedSpecialty: ''}), {status: 403});
  assert.throws(() => p.updateStaffSpecialty(f.second.token, {accountId: f.first.accountId, specialty: 'Нет', expectedSpecialty: ''}), {status: 404});
  assert.throws(() => p.updateAccountProfile(f.staff.token, {displayName: 'Анна', specialty: 'x'.repeat(121)}), {status: 400});
  assert.throws(() => p.updateAccountProfile(f.staff.token, {displayName: 'Анна', specialty: 'Тренер\nowner'}), {status: 400});
  assert.throws(() => p.updateAccountProfile(f.global.token, {displayName: 'Оператор', specialty: 'Нет'}), {status: 403});
  f.restart();
  assert.equal(f.platform.accountProfile(f.staff.token).specialty, 'Массажист');
  assert.equal(f.platform.accountProfile(otherToken).specialty, 'Консультант');
  assert.ok(await f.platform.login('staff@example.test', password));
  f.platform.updateAccountProfile(f.staff.token, {displayName: 'Анна Пример', specialty: '', expectedSpecialty: 'Массажист'});
  assert.equal(f.platform.accountProfile(f.staff.token).specialty, '');
});
test('public bot identity uses current assigned specialty, no inferred profession or private fields', async t => {
  const f = await fixture(t);
  f.platform.updateAccountProfile(f.staff.token, {displayName: 'Анна Пример', specialty: 'Тренер'});
  const identity = f.platform.telegram.messageIdentity(f.first.organizationId, f.staff.accountId);
  const invitation = invitationMessage(identity);
  assert.match(invitation, /Анна Пример — Тренер/);
  assert.doesNotMatch(invitation, /косметолог|клиент|@example|password/i);
  const a = {date: '2030-01-01', time: '10:00', duration: 30, serviceItems: [{name: 'Занятие'}], notes: 'PRIVATE'};
  for (const confirmed of [false, true]) {
    const text = appointmentMessage(identity, a, {}, {showServices: true, confirmed});
    assert.match(text, /Анна Пример — Тренер/); assert.match(text, /Услуги: Занятие/); assert.doesNotMatch(text, /PRIVATE/);
  }
  assert.doesNotMatch(invitationMessage(f.platform.telegram.messageIdentity(f.first.organizationId)), /Анна|Тренер|Ваш специалист/);
  f.platform.updateAccountProfile(f.first.token, {displayName: 'Первая организация', specialty: 'Консультант', organization: {name: 'Анна Пример', businessType: 'individual', city: '', phone: ''}});
  assert.match(invitationMessage(f.platform.telegram.messageIdentity(f.first.organizationId)), /Специальность: Консультант/);
  assert.equal(f.platform.telegram.messageIdentity(f.first.organizationId, f.second.accountId).specialty, '');
});
test('universal service descriptions and visit recommendations validate, preserve 15 minute step and need no product', () => {
  const s = {id: 's', name: 'Занятие', category: 'other', description: 'Индивидуальное занятие', duration: 30, price: 1000};
  const data = {revision: 0, services: [{...s, duration: '30 минут'}], patients: [{id: 'p', name: 'Анна', appointments: [], visits: [{id: 'v', date: '2030-01-01', procedure: 'Занятие', recommendations: 'Продолжать занятия', serviceItems: [s], photos: []}]}]};
  assert.equal(validateState(data), data);
  for (const duration of [1, 16]) { const changed = structuredClone(data); changed.patients[0].visits[0].serviceItems[0].duration = duration; assert.throws(() => validateState(changed), {status: 400}); }
  for (const [record, key, value] of [['service', 'description', 'x'.repeat(2001)], ['visit', 'recommendations', {}]]) {
    const changed = structuredClone(data); (record === 'service' ? changed.services[0] : changed.patients[0].visits[0])[key] = value;
    assert.throws(() => validateState(changed), {status: 400});
  }
});
