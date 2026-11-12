const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const root = path.resolve(__dirname, '..');
const invitation = () => ({
  url: 'https://t.me/example_bot?start=opaque_test_token',
  expiresAt: Date.now() + 86400000,
  qrDataUrl: 'data:image/png;base64,aGVsbG8=',
  patientId: 'p',
  accountKey: 'owner:org',
});
function fixture(
  t,
  {
    secure = true,
    share,
    canShare,
    phone = '+7 (918) 123-45-67',
    userAgent = '',
    platform = '',
    touch = 0,
  } = {},
) {
  const w = new JSDOM('<button id="send">Отправить ссылку</button>', {
    url: 'https://example.test',
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  Object.defineProperty(w, 'isSecureContext', { value: secure });
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: userAgent });
  if (platform) Object.defineProperty(w.navigator, 'platform', { value: platform });
  Object.defineProperty(w.navigator, 'maxTouchPoints', { value: touch });
  if (share) Object.defineProperty(w.navigator, 'share', { value: share });
  if (canShare) Object.defineProperty(w.navigator, 'canShare', { value: canShare });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const state = {
      account: { id: 'owner', organizationId: 'org' },
      selectedId: 'p',
      data: [{ id: 'p', name: 'Вымышленный клиент', phone }],
    },
    messages = [],
    actions = {
      normalizePatientPhoneText,
      $: (s) => w.document.querySelector(s),
      esc: (value) =>
        String(value).replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
        ),
      toast: (value) => messages.push(value),
    };
  actions.loadPatientMax = async () => {}; // Independent MAX port; this fixture isolates Telegram.
  actions.readPatientTelegramStatus = (id) =>
    actions.request('/api/telegram/patient?patientId=' + encodeURIComponent(id));
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/client-service-summary.js'), 'utf8'));
  Object.assign(actions, w.createClientServiceSummary(state, actions));
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/telegram-sharing.js'), 'utf8'));
  Object.assign(actions, w.createTelegramSharing(state, actions));
  actions.bindTelegramSharingEvents();
  const send = w.document.querySelector('#send');
  send.addEventListener('click', () => actions.shareTelegramInvitation(invitation()));
  return { w, state, actions, messages, send, $: (s) => w.document.querySelector(s) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function connectionFixture(t) {
  const f = fixture(t),
    status = {
      bot: { connected: true },
      linked: false,
      notificationsEnabled: true,
      confirmations: [],
      appointments: [],
    };
  f.state.multiUser = true;
  f.state.busy = false;
  f.state.currentView = 'card';
  f.requests = 0;
  f.status = status;
  const panel = f.w.document.createElement('section');
  panel.className = 'telegram-patient-panel';
  panel.innerHTML =
    '<div id="patient-telegram-body"></div><div id="patient-telegram-connection" data-patient-id="p"></div>';
  f.w.document.body.append(panel);
  Object.assign(f.actions, {
    bindTelegramSettingsEvents() {},
    canManageTeam() {
      return true;
    },
    appointmentPanelHtml: (appointments, id, result, tools) =>
      '<span>Создайте запись</span>' + tools,
    request: async (route) => {
      if (route === '/api/telegram/link') {
        f.requests++;
        return f.generate ? f.generate() : invitation();
      }
      return status;
    },
  });
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/telegram.js'), 'utf8'));
  Object.assign(f.actions, f.w.createTelegram(f.state, f.actions));
  f.actions.bindTelegramEvents();
  await f.actions.loadPatientTelegram('p');
  return f;
}
test('one click creates invitation, duplicate click is blocked, failures permit retry and expired links can renew', async (t) => {
  const f = await connectionFixture(t);
  let resolve;
  f.generate = () =>
    new Promise((yes) => {
      resolve = yes;
    });
  const button = f.$('[data-telegram-link]');
  assert.match(button.textContent, /Telegram.*подключить/i);
  assert.equal(f.$('.telegram-service-menu'), null);
  button.click();
  button.click();
  assert.equal(f.requests, 1);
  assert.equal(button.disabled, true);
  assert.equal(f.state.busy, true);
  resolve(invitation());
  await settle();
  await settle();
  assert.equal(f.state.busy, false);
  assert.equal(f.$('[data-telegram-link]'), null);
  assert.match(f.$('[data-telegram-share]').textContent, /Отправить приглашение/);
  assert.equal(f.$('#telegram-share-dialog'), null);
  f.$('[data-telegram-share]').click();
  assert.equal(f.$('#telegram-share-dialog').open, true);
  assert.equal(f.requests, 1);
  f.$('[data-close-telegram-share]').click();
  f.$('[data-telegram-share]').click();
  assert.equal(f.requests, 1);
  const now = f.w.Date.now();
  f.w.Date.now = () => now + 86401000;
  await f.actions.loadPatientTelegram('p');
  assert.ok(f.$('[data-telegram-link]'));
  assert.equal(f.$('[data-telegram-share]'), null);
  f.generate = () => Promise.reject(Error('Bot unavailable'));
  f.$('[data-telegram-link]').click();
  await settle();
  await settle();
  assert.equal(f.state.busy, false);
  assert.equal(f.$('[data-telegram-link]').disabled, false);
  assert.equal(f.messages.at(-1), 'Bot unavailable');
  f.generate = () => invitation();
  f.$('[data-telegram-link]').click();
  await settle();
  await settle();
  assert.equal(f.requests, 3);
  assert.ok(f.$('[data-telegram-share]'));
});
test('only real linked status changes invitation to Connected and revokes the open share dialog', async (t) => {
  const f = await connectionFixture(t);
  await f.actions.prepareTelegramInvitation('p');
  await f.actions.loadPatientTelegram('p');
  f.$('[data-telegram-share]').click();
  assert.equal(f.$('[data-telegram-unlink]'), null);
  assert.equal(f.$('#telegram-share-dialog').open, true);
  f.status.linked = true;
  await f.actions.loadPatientTelegram('p');
  assert.match(f.$('[data-telegram-unlink]').textContent, /Подключён/);
  assert.equal(f.$('[data-telegram-share]'), null);
  assert.equal(f.$('[data-telegram-link]'), null);
  f.$('[data-copy-telegram-link]').click();
  assert.equal(f.$('#telegram-share-dialog').open, false);
  assert.equal(f.$('#telegram-share-dialog').children.length, 0);
  f.status.linked = false;
  await f.actions.loadPatientTelegram('p');
  assert.equal(f.$('[data-telegram-unlink]'), null);
  assert.ok(f.$('[data-telegram-link]'));
  assert.equal(f.$('[data-telegram-share]'), null);
  f.status.bot.connected = false;
  await f.actions.loadPatientTelegram('p');
  assert.equal(f.$('[data-telegram-link]').disabled, true);
  assert.match(f.$('[data-telegram-link]').title, /Бот временно/);
});
test('all devices show recipient and channel choices; native sharing is called only inside Other apps click', async (t) => {
  let clicking = false,
    received;
  const f = fixture(t, {
    share: (data) => {
      assert.equal(clicking, true);
      received = data;
      return Promise.resolve();
    },
    canShare: () => true,
  });
  f.send.click();
  assert.equal(received, undefined);
  assert.equal(f.$('#telegram-share-dialog').open, true);
  clicking = true;
  f.$('[data-native-telegram-share]').click();
  clicking = false;
  await settle();
  assert.ok(received.text.includes(invitation().url));
  assert.match(received.text, /Запустить/);
  assert.equal(Object.keys(received).sort().join(','), 'text,title');
  assert.deepEqual(f.messages, []);
});
test('desktop fallback offers Telegram, private local QR and copy; installation stays hidden in help', async (t) => {
  const f = fixture(t);
  f.send.focus();
  f.send.click();
  const dialog = f.$('#telegram-share-dialog');
  assert.equal(dialog.open, true);
  const link = new URL(f.$('[data-share-channel="telegram"]').href);
  assert.equal(link.origin, 'https://t.me');
  assert.equal(link.pathname, '/+79181234567');
  assert.equal(link.searchParams.get('text'), f.$('textarea').value);
  assert.equal(f.$('.telegram-share-recipient strong').textContent, 'Вымышленный клиент');
  assert.equal(f.$('.telegram-share-recipient span').textContent, '+7 (918) 123-45-67');
  const whatsapp = new URL(f.$('[data-share-channel="whatsapp"]').href);
  assert.equal(whatsapp.origin, 'https://wa.me');
  assert.equal(whatsapp.pathname, '/79181234567');
  assert.equal(whatsapp.searchParams.get('text'), f.$('textarea').value);
  assert.equal(f.$('.telegram-share-help').open, false);
  assert.equal(
    f.$('a[href="https://desktop.telegram.org/"]').closest('details'),
    f.$('.telegram-share-help'),
  );
  assert.equal(f.$('.telegram-share-qr').open, false);
  assert.match(f.$('.telegram-share-qr img').src, /^data:image\/png;base64,/);
  let copied;
  Object.defineProperty(f.w.navigator, 'clipboard', {
    value: {
      writeText: async (text) => {
        copied = text;
      },
    },
  });
  f.$('[data-copy-telegram-message]').click();
  await settle();
  assert.equal(copied, f.$('textarea').value);
  assert.equal(copied.split(invitation().url).length, 2);
  assert.equal(/patient|procedure|phone|2030/.test(copied), false);
  f.$('[data-close-telegram-share]').click();
  assert.equal(dialog.open, false);
  assert.equal(dialog.children.length, 0);
  assert.equal(f.w.document.activeElement, f.send);
});
test('insecure context and canShare refusal use fallback without invoking native sharing', (t) => {
  for (const config of [
    { secure: false },
    { canShare: () => false },
    {
      canShare: () => {
        throw Error('Unavailable');
      },
    },
  ]) {
    let called = false;
    const f = fixture(t, {
      ...config,
      share: () => {
        called = true;
        return Promise.resolve();
      },
    });
    f.send.click();
    assert.equal(called, false);
    assert.equal(f.$('#telegram-share-dialog').open, true);
  }
});

test('copy invitation copies only the link and falls back to selecting its own field', async (t) => {
  const f = fixture(t);
  f.send.click();
  let copied;
  Object.defineProperty(f.w.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value) => {
        copied = value;
      },
    },
  });
  f.$('[data-copy-telegram-link]').click();
  await settle();
  assert.equal(copied, invitation().url);
  assert.equal(f.messages.at(-1), 'Ссылка скопирована');
  Object.defineProperty(f.w.navigator, 'clipboard', {
    value: {
      writeText: async () => {
        throw Error('Denied');
      },
    },
  });
  f.$('[data-copy-telegram-link]').click();
  await settle();
  const input = f.$('[data-telegram-invitation-url]');
  assert.equal(f.w.document.activeElement, input);
  assert.equal(input.selectionEnd, input.value.length);
  assert.equal(input.closest('details').open, true);
  f.state.account.id = 'other';
  copied = '';
  f.$('[data-copy-telegram-link]').click();
  await settle();
  assert.equal(copied, '');
  assert.equal(f.$('#telegram-share-dialog').open, false);
  assert.equal(f.$('[data-telegram-invitation-url]'), null);
});
test('cancel does not reopen options, failures fall back, and account switches suppress stale dialog', async (t) => {
  for (const name of ['AbortError', 'NotAllowedError']) {
    const f = fixture(t, { share: () => Promise.reject(Object.assign(Error('Test'), { name })) });
    f.send.click();
    f.$('[data-native-telegram-share]').click();
    await settle();
    assert.equal(f.$('#telegram-share-dialog').open, true);
    assert.equal(f.messages.length, name === 'AbortError' ? 0 : 1);
  }
  const thrown = fixture(t, {
    share: () => {
      throw Error('Unavailable');
    },
  });
  thrown.send.click();
  thrown.$('[data-native-telegram-share]').click();
  assert.equal(thrown.$('#telegram-share-dialog').open, true);
  assert.equal(thrown.messages.length, 1);
  let reject;
  const changed = fixture(t, {
    share: () =>
      new Promise((_, no) => {
        reject = no;
      }),
  });
  changed.send.click();
  changed.$('[data-native-telegram-share]').click();
  changed.state.account.id = 'other';
  reject(Error('Failed'));
  await settle();
  assert.deepEqual(changed.messages, []);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(changed.$('#telegram-share-dialog').open, false);
  assert.equal(changed.$('textarea'), null);
});
test('expired and unsafe links are blocked; unavailable clipboard selects text and pagehide clears it', async (t) => {
  const f = fixture(t);
  for (const bad of [
    { ...invitation(), expiresAt: 0 },
    { ...invitation(), url: 'https://evil.test/?start=token' },
    undefined,
  ])
    f.actions.shareTelegramInvitation(bad);
  assert.equal(f.$('#telegram-share-dialog'), null);
  assert.equal(f.messages.length, 3);
  f.send.click();
  f.$('[data-copy-telegram-message]').click();
  await settle();
  assert.equal(f.w.document.activeElement, f.$('textarea'));
  assert.equal(f.$('textarea').selectionEnd, f.$('textarea').value.length);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal(f.$('#telegram-share-dialog').open, false);
  assert.equal(f.$('textarea'), null);
});
test('invitation preparation deduplicates requests, scopes the cache to the account and tolerates bot failure', async (t) => {
  const f = fixture(t);
  f.state.multiUser = true;
  f.state.busy = false;
  let resolve,
    requests = 0,
    fail = false,
    loaded = [];
  f.actions.request = () => {
    requests++;
    return fail
      ? Promise.reject(Error('Bot unavailable'))
      : new Promise((yes) => {
          resolve = yes;
        });
  };
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/telegram.js'), 'utf8'));
  Object.assign(f.actions, f.w.createTelegram(f.state, f.actions));
  f.actions.loadPatientTelegram = async (id) => {
    loaded.push(id);
  };
  const a = f.actions.prepareTelegramInvitation('p'),
    b = f.actions.prepareTelegramInvitation('p');
  assert.equal(requests, 1);
  assert.equal(f.state.busy, false);
  resolve({ ...invitation(), invitationText: 'Здравствуйте! Это Тестовая студия.' });
  const prepared = await a;
  assert.equal(prepared.url, (await b).url);
  assert.equal(prepared.invitationText, 'Здравствуйте! Это Тестовая студия.');
  await f.actions.prepareTelegramInvitation('p');
  assert.equal(requests, 1);
  assert.deepEqual(loaded, ['p']);
  const stale = f.actions.prepareTelegramInvitation('other');
  f.state.account.id = 'different';
  resolve(invitation());
  assert.equal(await stale, undefined);
  assert.deepEqual(loaded, ['p']);
  fail = true;
  assert.equal(await f.actions.prepareTelegramInvitation('p', { quiet: true }), undefined);
  assert.equal(await f.actions.prepareTelegramInvitation('p', { quiet: true }), undefined);
  assert.equal(requests, 4);
  assert.equal(f.state.busy, false);
});
test('background preparation aborts a stalled request without leaving the editor busy', async (t) => {
  const f = fixture(t);
  f.state.multiUser = true;
  f.state.busy = false;
  let deadline;
  const timeout = f.w.setTimeout.bind(f.w);
  f.w.setTimeout = (fn, ms) => {
    deadline = ms;
    return timeout(fn, 10);
  };
  f.actions.request = (_, options) =>
    new Promise((yes, no) => options.signal.addEventListener('abort', () => no(Error('Timeout'))));
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/modules/telegram.js'), 'utf8'));
  Object.assign(f.actions, f.w.createTelegram(f.state, f.actions));
  f.actions.loadPatientTelegram = async () => {
    throw Error('No link should be rendered');
  };
  assert.equal(await f.actions.prepareTelegramInvitation('p', { quiet: true }), undefined);
  assert.equal(deadline, 8000);
  assert.equal(f.state.busy, false);
});

test('Russian 8/+7, foreign international numbers and iPhone/iPad/Android SMS drafts target the saved contact', (t) => {
  for (const [phone, number, config, separator] of [
    ['8 (918) 123-45-67', '79181234567', { userAgent: 'iPhone' }, '&'],
    ['+7 918 123 45 67', '79181234567', { userAgent: 'Android' }, '?'],
    ['+374 91 123456', '37491123456', { platform: 'MacIntel', touch: 5 }, '&'],
    ['0037491123456', '37491123456', {}, '?'],
    ['+81 90 1234 567', '81901234567', {}, '?'],
  ]) {
    const f = fixture(t, { phone, ...config });
    f.send.click();
    const message = f.$('textarea').value;
    assert.equal(new URL(f.$('[data-share-channel="telegram"]').href).pathname, '/+' + number);
    const whatsapp = new URL(f.$('[data-share-channel="whatsapp"]').href);
    assert.equal(whatsapp.pathname, '/' + number);
    assert.equal(whatsapp.searchParams.get('text'), message);
    const sms = f.$('[data-share-channel="sms"]').getAttribute('href');
    assert.ok(sms.startsWith('sms:+' + number + separator + 'body='));
    assert.equal(decodeURIComponent(sms.split('body=')[1]), message);
    const choice = new URL(f.$('[data-share-channel="telegram-choice"]').href);
    assert.equal(choice.pathname, '/share/url');
    assert.equal(choice.searchParams.get('url'), invitation().url);
    assert.equal(f.state.data[0].phone, phone);
    assert.equal(message.includes(phone), false);
    assert.equal(message.includes('Вымышленный'), false);
  }
});

test('missing, local-only or unsafe phone never opens a guessed recipient; names and text remain plain text', (t) => {
  for (const phone of [
    '',
    '9181234567',
    '+0 123456789',
    '+7 918 123 45 67;ext=1',
    'javascript:alert(1)',
    '+7 918 " onmouseover="bad',
  ]) {
    const f = fixture(t, { phone });
    f.state.data[0].name = '<img src=x onerror=bad>';
    f.send.click();
    assert.equal(f.$('[data-share-channel="whatsapp"]'), null);
    assert.equal(f.$('[data-share-channel="sms"]'), null);
    assert.equal(
      f.w.document.querySelectorAll('.telegram-share-actions button:disabled').length,
      2,
    );
    assert.equal(new URL(f.$('[data-share-channel="telegram"]').href).pathname, '/share/url');
    assert.equal(f.$('.telegram-share-recipient img'), null);
    assert.equal(f.$('.telegram-share-recipient strong').textContent, '<img src=x onerror=bad>');
    assert.equal(f.$('[data-native-telegram-share]'), null);
  }
});

test('client/account/organization/contact switches and expired or wrong-scope links block stale channel activation', async (t) => {
  for (const change of [
    (f) => {
      f.state.selectedId = 'other';
    },
    (f) => {
      f.state.account.id = 'other';
    },
    (f) => {
      f.state.account.organizationId = 'other-org';
    },
    (f) => {
      f.state.data[0].phone = '+7 918 987 65 43';
    },
  ]) {
    const f = fixture(t);
    f.send.click();
    const link = f.$('[data-share-channel="whatsapp"]');
    change(f);
    const event = new f.w.Event('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.$('#telegram-share-dialog').open, false);
    assert.equal(f.$('textarea'), null);
  }
  const expired = fixture(t),
    value = invitation();
  expired.actions.shareTelegramInvitation(value);
  value.expiresAt = 0;
  const event = new expired.w.Event('click', { bubbles: true, cancelable: true });
  expired.$('[data-share-channel="sms"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(expired.$('textarea'), null);
  for (const bad of [
    { ...invitation(), patientId: 'not-loaded' },
    { ...invitation(), accountKey: 'other:org' },
  ]) {
    const f = fixture(t);
    f.actions.shareTelegramInvitation(bad);
    assert.equal(f.$('#telegram-share-dialog'), null);
  }
  const logout = fixture(t);
  logout.send.click();
  const button = logout.w.document.createElement('button');
  button.id = 'logout-account';
  logout.w.document.body.append(button);
  button.click();
  assert.equal(logout.$('#telegram-share-dialog').open, false);
  assert.equal(logout.$('textarea'), null);
});
