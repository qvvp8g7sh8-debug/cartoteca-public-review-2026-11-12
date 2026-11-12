const { randomBytes, randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const { createPersonalFeedState } = require('./personal-feed-state.cjs');
const { createSubscriptionSelection } = require('./subscription-selection.cjs');
const { fail } = require('../../../shared/errors.cjs');
function calendarProvider(provider = 'apple') {
  if (provider !== 'apple' && provider !== 'google') throw fail(400, 'Неизвестный календарь.');
  return provider;
}
const secretKey = (provider, role) =>
  role === 'salon_admin'
    ? provider === 'google'
      ? 'adminGoogleSecret'
      : 'adminSecret'
    : provider === 'google'
      ? 'googleSecret'
      : 'secret';
function createCalendarSubscription(context) {
  const { db, open, seal, transaction } = context;
  const { metadata } = createPersonalFeedState(context);
  const selection = createSubscriptionSelection(context);
  const roles = ['owner', 'cosmetologist', 'salon_admin'];
  function allowed(accountId, organizationId) {
    const row = db
      .prepare(
        `SELECT a.value,m.role FROM accounts a
      JOIN memberships m ON m.account_id=a.id JOIN organizations o ON o.id=m.organization_id
      WHERE a.id=? AND o.id=? AND a.status='active' AND m.status='active' AND o.status='active'`,
      )
      .get(accountId, organizationId);
    if (
      !row ||
      !roles.includes(row.role) ||
      context.subscription(organizationId).status !== 'active'
    )
      throw fail(403, 'Нет доступа к расписанию организации.');
    return { accountId, organizationId, role: row.role, account: open(row.value) };
  }
  function actor(token) {
    const current = context.session(token);
    if (!current?.organizationId) throw fail(403, 'Выберите организацию.');
    return allowed(current.accountId, current.organizationId);
  }
  function status(token, provider) {
    provider = calendarProvider(provider);
    return result(actor(token), provider);
  }
  function result(current, provider) {
    const saved = current.account.calendarSubscriptions?.[current.organizationId] || {};
    const secret = saved[secretKey(provider, current.role)];
    return {
      connected: !!secret,
      credential: secret ? encode(current, secret, provider) : null,
      ...(current.role === 'salon_admin' ? selection.state(current, saved, provider) : {}),
    };
  }
  function encode(current, secret, provider) {
    const values = [current.accountId, current.organizationId, secret];
    if (current.role === 'salon_admin') values.push(provider, 'organization');
    else if (provider === 'google') values.push(provider);
    return Buffer.from(JSON.stringify(values)).toString('base64url');
  }
  function connect(token, assertCurrent, provider) {
    provider = calendarProvider(provider);
    return transaction(() => {
      assertCurrent();
      const current = actor(token);
      const subscriptions = { ...current.account.calendarSubscriptions };
      const saved = { ...subscriptions[current.organizationId] };
      const key = secretKey(provider, current.role);
      if (!saved[key]) {
        saved[key] = randomBytes(32).toString('base64url');
        subscriptions[current.organizationId] = saved;
        db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
          seal({ ...current.account, calendarSubscriptions: subscriptions }),
          current.accountId,
        );
        context.audit('calendar_subscription_connected', current.accountId, current.organizationId);
      }
      return result(
        { ...current, account: { ...current.account, calendarSubscriptions: subscriptions } },
        provider,
      );
    });
  }
  function disconnect(token, assertCurrent, provider) {
    provider = calendarProvider(provider);
    return transaction(() => {
      assertCurrent();
      const current = actor(token);
      const subscriptions = { ...current.account.calendarSubscriptions };
      const saved = { ...subscriptions[current.organizationId] };
      delete saved[secretKey(provider, current.role)];
      if (Object.keys(saved).length) subscriptions[current.organizationId] = saved;
      else delete subscriptions[current.organizationId];
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
        seal({ ...current.account, calendarSubscriptions: subscriptions }),
        current.accountId,
      );
      context.audit(
        'calendar_subscription_disconnected',
        current.accountId,
        current.organizationId,
      );
      return result(
        { ...current, account: { ...current.account, calendarSubscriptions: subscriptions } },
        provider,
      );
    });
  }
  function updateSelection(token, assertCurrent, provider, values) {
    provider = calendarProvider(provider);
    return transaction(() => {
      assertCurrent();
      const current = actor(token);
      if (current.role !== 'salon_admin')
        throw fail(403, 'Выбор специалистов доступен администратору организации.');
      const subscriptions = { ...current.account.calendarSubscriptions };
      const saved = { ...subscriptions[current.organizationId] };
      const next = selection.validate(values, selection.state(current, saved, provider));
      saved.adminSelections = {
        ...saved.adminSelections,
        [provider]: { ...next, revision: randomUUID() },
      };
      subscriptions[current.organizationId] = saved;
      const account = { ...current.account, calendarSubscriptions: subscriptions };
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(seal(account), current.accountId);
      context.audit(
        'calendar_subscription_selection_changed',
        current.accountId,
        current.organizationId,
      );
      return result({ ...current, account }, provider);
    });
  }
  function resolve(credential) {
    try {
      if (
        typeof credential !== 'string' ||
        credential.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(credential)
      )
        throw Error();
      const values = JSON.parse(Buffer.from(credential, 'base64url').toString('utf8'));
      if (
        !Array.isArray(values) ||
        (values.length !== 3 &&
          !(values.length === 4 && values[3] === 'google') &&
          !(
            values.length === 5 &&
            ['apple', 'google'].includes(values[3]) &&
            values[4] === 'organization'
          )) ||
        values.slice(0, 3).some((v) => typeof v !== 'string' || !v.length || v.length > 200)
      )
        throw Error();
      const [accountId, organizationId, secret] = values;
      const current = allowed(accountId, organizationId);
      const admin = values.length === 5;
      // A personal URL must never gain organization scope after a role change.
      if (admin !== (current.role === 'salon_admin')) throw Error();
      const provider = admin ? values[3] : values.length === 4 ? 'google' : 'apple';
      const saved = current.account.calendarSubscriptions?.[organizationId] || {};
      const storedSecret = saved[secretKey(provider, current.role)];
      if (
        typeof storedSecret !== 'string' ||
        !storedSecret ||
        !timingSafeEqual(digest(secret), digest(storedSecret))
      )
        throw Error();
      const resolved = { accountId, organizationId, role: current.role };
      if (!admin) return resolved;
      const scope = selection.state(current, saved, provider);
      const ids = new Set(scope.selection.staffIds);
      return {
        ...resolved,
        ...scope,
        specialists: scope.specialists.filter(
          (s) => scope.selection.mode === 'all' || ids.has(s.id),
        ),
      };
    } catch {
      throw fail(404, 'Подписка недоступна.');
    }
  }
  return { status, connect, disconnect, updateSelection, resolve, metadata };
}
const digest = (value) => createHash('sha256').update(value).digest();
module.exports = { createCalendarSubscription, calendarProvider };
