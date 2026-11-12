const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configuredMax,
  maxInvitationLink,
  maxId,
} = require('../src/server/modules/notifications/max-adapter.cjs');

const syntheticToken = 'synthetic-max-token-not-a-real-credential';
const syntheticCapability = 'synthetic_capability_123456789';
const botInfo = { user_id: 123, is_bot: true, username: 'synthetic_cartoteca_bot' };
const recipient = { botId: '123', userId: '456' };
const response = (data, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => data,
});

function fixture(next) {
  const calls = [];
  const bot = configuredMax({
    enabled: true,
    token: syntheticToken,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (new URL(url).pathname === '/me') return response(botInfo);
      return next
        ? next(url, options)
        : response({ message: { body: { mid: 'synthetic-message' } } });
    },
  });
  return { bot, calls };
}

test('MAX is disabled by default even when a token is present; no constructor request', () => {
  let calls = 0;
  assert.equal(
    configuredMax({
      token: syntheticToken,
      fetchImpl: () => {
        calls++;
      },
    }),
    null,
  );
  assert.equal(configuredMax({ enabled: true }), null);
  const bot = configuredMax({
    enabled: true,
    token: syntheticToken,
    fetchImpl: () => {
      calls++;
    },
  });
  assert.ok(bot);
  assert.equal(calls, 0);
});

test('token line breaks and invalid transport are rejected without leaking credentials', () => {
  assert.throws(() => configuredMax({ enabled: true, token: 'synthetic\ninvalid' }), {
    status: 400,
  });
  assert.throws(() => configuredMax({ enabled: true, token: syntheticToken, fetchImpl: null }), {
    status: 500,
  });
});

test('initialize uses current API host, raw Authorization header and refuses redirects', async () => {
  const { bot, calls } = fixture();
  assert.deepEqual(await bot.initialize(), { botId: '123', username: botInfo.username });
  assert.equal(calls[0].url, 'https://platform-api2.max.ru/me');
  assert.equal(calls[0].options.headers.Authorization, syntheticToken);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].url.includes(syntheticToken), false);
  const exact = configuredMax({
    enabled: true,
    token: syntheticToken,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '{"user_id":9223372036854775807,"is_bot":true,"username":"synthetic_cartoteca_bot"}',
    }),
  });
  assert.equal((await exact.initialize()).botId, '9223372036854775807');
});

test('send requires initialization and verifies the bot identity on the recipient link', async () => {
  const { bot, calls } = fixture();
  await assert.rejects(bot.send({ recipient, text: 'Синтетическая запись' }), { status: 409 });
  assert.equal(calls.length, 0);
  await bot.initialize();
  await assert.rejects(bot.send({ recipient: { ...recipient, botId: '999' }, text: 'Пример' }), {
    status: 409,
  });
  assert.equal(calls.length, 1);
});

test('send uses user_id, plain text and MAX callback attachment instead of Telegram markup', async () => {
  const { bot, calls } = fixture();
  await bot.initialize();
  const result = await bot.send({
    recipient,
    text: 'Синтетическая запись',
    confirmationToken: syntheticCapability,
  });
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/messages');
  assert.equal(url.searchParams.get('user_id'), '456');
  assert.equal(url.searchParams.has('chat_id'), false);
  assert.equal(calls[1].options.method, 'POST');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.format, undefined);
  assert.equal(body.attachments[0].type, 'inline_keyboard');
  assert.deepEqual(body.attachments[0].payload.buttons, [
    [
      {
        type: 'callback',
        text: 'Подтвердить запись',
        payload: `confirm_${syntheticCapability}`,
      },
    ],
  ]);
  assert.equal(result.body.mid, 'synthetic-message');
});

test('invalid message and capability are rejected before a network send', async () => {
  const { bot, calls } = fixture();
  await bot.initialize();
  for (const text of ['', ' ', 'a'.repeat(4001)])
    await assert.rejects(bot.send({ recipient, text }), { status: 400 });
  await assert.rejects(bot.send({ recipient, text: 'Пример', confirmationToken: 'bad?' }), {
    status: 400,
  });
  assert.equal(calls.length, 1);
});

test('429 preserves retry delay without marking the result as uncertain', async () => {
  const { bot } = fixture(() => response({}, 429, { 'Retry-After': '45' }));
  await bot.initialize();
  await assert.rejects(bot.send({ recipient, text: 'Пример' }), {
    status: 429,
    retryAfter: 45,
    deliveryUncertain: false,
  });
});

test('network and malformed successful send results require reconciliation, not automatic fallback', async () => {
  for (const next of [
    () => {
      throw Error(syntheticToken);
    },
    () => response({}),
    () => response({ message: {} }),
  ]) {
    const { bot } = fixture(next);
    await bot.initialize();
    await assert.rejects(bot.send({ recipient, text: 'Синтетическое сообщение' }), (error) => {
      assert.equal(error.deliveryUncertain, true);
      assert.equal(error.message.includes(syntheticToken), false);
      assert.equal(error.message.includes('Синтетическое сообщение'), false);
      return true;
    });
  }
});

test('integer identifiers cannot be rounded, nonpositive or outside signed int64', () => {
  assert.equal(maxId('9223372036854775807'), '9223372036854775807');
  assert.equal(maxId(123), '123');
  for (const value of [
    0,
    -1,
    '01',
    '1x',
    '',
    null,
    Number.MAX_SAFE_INTEGER + 1,
    '9223372036854775808',
  ])
    assert.throws(() => maxId(value), { status: 400 });
});

test('invitation uses a short opaque capability, not a phone or patient identifier', () => {
  assert.equal(
    maxInvitationLink(botInfo.username, syntheticCapability),
    `https://max.ru/${botInfo.username}?start=${syntheticCapability}`,
  );
  assert.throws(() => maxInvitationLink('../other', syntheticCapability), { status: 400 });
  assert.throws(() => maxInvitationLink(botInfo.username, 'phone=+79990000000'), { status: 400 });
});
