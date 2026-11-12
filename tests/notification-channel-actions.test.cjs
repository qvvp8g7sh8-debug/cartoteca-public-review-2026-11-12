const test = require('node:test');
const assert = require('node:assert/strict');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { routes } = require('../src/server/modules/notifications/email-test-routes.cjs');
const { configuredMax } = require('../src/server/modules/notifications/max-adapter.cjs');
const { configuredTelegram } = require('../src/server/modules/notifications/telegram-adapter.cjs');
const {
  createNotificationProviders,
} = require('../src/server/modules/notifications/notification-providers.cjs');
const { emailMessage } = require('../src/server/modules/notifications/email-message.cjs');
const contactUrl = 'https://wa.me/79990000000';
function emailContext(f, body = {}) {
  return {
    token: f.users[0].token,
    platform: f.platform,
    req: {},
    readBody: async () => body,
    assertCurrent() {},
    assertMailAvailable() {},
    json: (_, status, value) => ({ status, value }),
  };
}

test('email test uses only the authenticated recipient and deduplicates requests within its minute', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  let now = Math.floor(Date.now() / 60000) * 60000 + 1000;
  t.mock.method(Date, 'now', () => now);
  const c = emailContext(f),
    route = routes[0];
  assert.equal(route.access, 'session');
  assert.equal(route.method, 'POST');
  assert.deepEqual(await route.handle(c), { status: 202, value: { queued: true } });
  await route.handle(c);
  const query = () =>
    f.database.db.prepare("SELECT * FROM admin_email_jobs WHERE kind='notification-test'").all();
  assert.equal(query().length, 1);
  const account = f.platform.accountProfile(c.token).account,
    accountId = f.users[0].accountId;
  assert.deepEqual(f.database.open(query()[0].value), {
    actorId: accountId,
    accountId,
    email: account.email,
  });
  assert.ok(
    f.platform.admin.emailQueue.allowed(
      {
        kind: 'notification-test',
        payload: f.database.open(query()[0].value),
        expiresAt: query()[0].expires_at,
      },
      now,
    ),
  );
  now += 60000;
  await route.handle(c);
  assert.equal(query().length, 2);
  const message = emailMessage('', { kind: 'notification-test' });
  assert.match(message.subject, /Проверка уведомлений/);
  assert.doesNotMatch(message.text, /парол|восстановлен|https?:/i);
});

test('email test refuses caller recipients, unavailable mail, stale identity and unauthenticated actions', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    route = routes[0];
  for (const body of [null, [], { email: 'other@synthetic.test' }, { kind: 'support-reply' }])
    await assert.rejects(route.handle(emailContext(f, body)), { status: 400 });
  const unavailable = emailContext(f);
  unavailable.assertMailAvailable = () => {
    throw Object.assign(Error('Synthetic mail unavailable'), { status: 503 });
  };
  await assert.rejects(route.handle(unavailable), { status: 503 });
  const unauthorized = emailContext(f);
  unauthorized.assertCurrent = () => {
    throw Object.assign(Error('Synthetic expired session'), { status: 401 });
  };
  await assert.rejects(route.handle(unauthorized), { status: 401 });
  const stale = emailContext(f),
    profile = f.platform.accountProfile(stale.token);
  let reads = 0;
  stale.platform = {
    ...f.platform,
    accountProfile: () =>
      ++reads === 1
        ? profile
        : { ...profile, account: { ...profile.account, email: 'changed@synthetic.test' } },
  };
  await assert.rejects(route.handle(stale), { status: 409 });
  assert.equal(
    f.database.db
      .prepare("SELECT count(*) n FROM admin_email_jobs WHERE kind='notification-test'")
      .get().n,
    0,
  );
});

test('public email-test kind permits only the same active account current address without widening admin kinds', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    queue = f.platform.admin.emailQueue;
  const account = f.platform.accountProfile(f.users[0].token).account,
    accountId = f.users[0].accountId,
    now = Date.now();
  const job = {
    kind: 'notification-test',
    expiresAt: now + 60000,
    payload: { actorId: accountId, accountId, email: account.email },
  };
  assert.equal(queue.allowed(job, now), true);
  assert.equal(queue.allowed({ ...job, payload: { email: account.email } }, now), false);
  assert.equal(
    queue.allowed(
      { ...job, payload: { ...job.payload, accountId: undefined, actorId: undefined } },
      now,
    ),
    false,
  );
  assert.equal(
    queue.allowed({ ...job, payload: { ...job.payload, actorId: f.users[2].accountId } }, now),
    false,
  );
  assert.equal(
    queue.allowed({ ...job, payload: { ...job.payload, email: 'stale@synthetic.test' } }, now),
    false,
  );
  assert.equal(queue.allowed({ ...job, expiresAt: now }, now), false);
  assert.equal(queue.allowed({ ...job, kind: 'support-reply' }, now), false);
  f.database.db.prepare("UPDATE accounts SET status='inactive' WHERE id=?").run(accountId);
  assert.equal(queue.allowed(job, now), false);
});

const response = (data) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => data,
});
test('MAX transport builds confirmation, app and contact buttons and keeps only contact when clearing', async () => {
  const calls = [],
    signal = new AbortController().signal;
  const bot = configuredMax({
    enabled: true,
    token: 'synthetic-max-token-not-a-credential',
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      calls.push({
        target,
        method: options.method,
        body: options.body && JSON.parse(options.body),
        signal: options.signal,
      });
      if (target.pathname === '/me')
        return response({ user_id: '123', is_bot: true, username: 'Synthetic_bot' });
      return options.method === 'PUT'
        ? response({ success: true })
        : response({ message: { body: { mid: 'synthetic-message' } } });
    },
  });
  await bot.initialize();
  const link = { text: 'Открыть запись', url: 'https://synthetic.test/#staff-push=synthetic' };
  await bot.send({
    recipient: { botId: '123', userId: '456' },
    text: 'Synthetic notice',
    confirmationToken: 's'.repeat(27),
    link,
    contactUrl,
    signal,
  });
  const sent = calls.at(-1);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.target.searchParams.get('user_id'), '456');
  assert.deepEqual(sent.body.attachments[0].payload.buttons, [
    [{ type: 'callback', text: 'Подтвердить запись', payload: 'confirm_' + 's'.repeat(27) }],
    [{ type: 'link', text: link.text, url: link.url }],
    [{ type: 'link', text: 'Связаться', url: contactUrl }],
  ]);
  assert.equal(sent.signal.aborted, false);
  await bot.clearButtons('synthetic-message', signal, contactUrl);
  const cleared = calls.at(-1);
  assert.equal(cleared.method, 'PUT');
  assert.equal(cleared.target.searchParams.get('message_id'), 'synthetic-message');
  assert.deepEqual(cleared.body, {
    attachments: [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'link', text: 'Связаться', url: contactUrl }]],
        },
      },
    ],
    notify: false,
  });
  await bot.clearButtons('synthetic-message', signal);
  assert.deepEqual(calls.at(-1).body.attachments, []);
  const count = calls.length;
  for (const bad of ['javascript:alert(1)', 'https://user:pass@synthetic.test/'])
    await assert.rejects(
      bot.send({
        recipient: { botId: '123', userId: '456' },
        text: 'Synthetic',
        link: { text: 'Открыть', url: bad },
      }),
      { status: 400 },
    );
  await assert.rejects(
    bot.send({
      recipient: { botId: '123', userId: '456' },
      text: 'Synthetic',
      contactUrl: 'https://wa.me/79990000000?redirect=evil',
    }),
    { status: 400 },
  );
  assert.equal(calls.length, count, 'invalid link data must never reach the transport');
});

test('Telegram provider sends confirmation and contact rows and clearButtons preserves only safe contact', async () => {
  const calls = [],
    signal = new AbortController().signal;
  const bot = configuredTelegram({
    token: '123:' + 's'.repeat(24),
    fetchImpl: async (url, options) => {
      calls.push({
        method: new URL(url).pathname.split('/').at(-1),
        body: JSON.parse(options.body),
        signal: options.signal,
      });
      return response({
        ok: true,
        result: url.endsWith('/sendMessage') ? { message_id: 7 } : true,
      });
    },
  });
  const provider = createNotificationProviders({
    telegramBot: bot,
    telegramStatus: () => ({ connected: true, botId: '123' }),
    telegramPacing: { acquire: async () => true, pause() {} },
  }).telegram;
  await provider.send({
    recipient: { chatId: '456' },
    text: 'Synthetic notice',
    confirmationToken: 's'.repeat(27),
    contactUrl,
    signal,
  });
  assert.deepEqual(calls.at(-1).body.reply_markup.inline_keyboard, [
    [{ text: 'Подтвердить запись', callback_data: 'confirm_' + 's'.repeat(27) }],
    [{ text: 'Связаться', url: contactUrl }],
  ]);
  await bot.clearButtons('456', 7, signal, contactUrl);
  assert.deepEqual(calls.at(-1), {
    method: 'editMessageReplyMarkup',
    body: {
      chat_id: '456',
      message_id: 7,
      reply_markup: { inline_keyboard: [[{ text: 'Связаться', url: contactUrl }]] },
    },
    signal: calls.at(-1).signal,
  });
  assert.equal(calls.at(-1).signal.aborted, false);
  await bot.clearButtons('456', 7, signal, 'https://wa.me/79990000000?unsafe=1');
  assert.deepEqual(calls.at(-1).body.reply_markup.inline_keyboard, []);
  const count = calls.length;
  assert.throws(() => bot.clearButtons('invalid', 7, signal), { status: 400 });
  assert.equal(calls.length, count);
});
