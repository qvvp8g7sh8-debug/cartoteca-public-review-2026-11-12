const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function settings() {
  return {
    revision: 3,
    policy: {
      mode: 'off',
      commands: { calendar: true, clients: true, prepareAppointment: true },
      limits: {
        monthlyBudgetRub: 100,
        dailyRequests: 50,
        maxTextChars: 2000,
        maxAudioSeconds: 30,
        maxReplyChars: 600,
        maxOutputTokens: 500,
        requestTimeoutMs: 20000,
      },
      instructions: '',
      dictionary: '',
    },
    providers: {
      stt: { provider: 'demo', model: 'openai/gpt-4o-mini-transcribe' },
      llm: { provider: 'demo', model: 'deepseek/deepseek-flash' },
      tts: { provider: 'demo', model: 'openai/gpt-4o-mini-tts', voice: 'alloy' },
    },
    credentialStatus: { timeweb: { configured: true } },
    providerStatus: { codex: { available: true, localOnly: true, billing: 'codex-subscription' } },
    rates: {
      llmInput: 41,
      llmOutput: 162,
      sttInput: 405,
      sttOutput: 675,
      ttsInput: 81,
      ttsOutput: 1620,
    },
    usage: { month: '2026-10', spentRub: 0, reservedRub: 0 },
    grants: [],
    history: [{ revision: 1, time: 1 }],
    memberships: [
      {
        organizationId: 'org-a',
        accountId: 'account-a',
        membershipId: 'membership-a',
        organizationName: 'Первая организация',
        displayName: 'Первый пользователь',
        role: 'owner',
        status: 'active',
      },
      {
        organizationId: 'org-b',
        accountId: 'account-b',
        membershipId: 'membership-b',
        organizationName: 'Вторая организация',
        displayName: 'Второй пользователь',
        role: 'cosmetologist',
        status: 'active',
      },
    ],
  };
}
function boot(t, handler = async () => ({})) {
  const dom = new JSDOM(fs.readFileSync(assetPath('admin.html'), 'utf8'), {
    url: 'http://127.0.0.1:4174/admin.html',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom,
    $ = (selector) => window.document.querySelector(selector),
    calls = [],
    notices = [];
  window.confirm = () => true;
  for (const file of [
    'src/shared/improvement-status.cjs',
    'src/client/modules/admin/records.js',
    'src/client/modules/admin/voice-providers.js',
    'src/client/modules/admin/voice-view.js',
    'src/client/modules/admin/voice-members.js',
    'src/client/modules/admin/voice-behavior-view.js',
    'src/client/modules/admin/voice-behavior-diff.js',
    'src/client/modules/admin/voice-behavior-editor.js',
    'src/client/modules/admin/voice-behavior-library-view.js',
    'src/client/modules/admin/voice-behavior-library.js',
    'src/client/modules/admin/voice-behavior.js',
    'src/client/modules/admin/voice.js',
  ])
    window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const snapshot = settings(),
    directory = new Map();
  for (const item of snapshot.memberships) {
    if (!directory.has(item.organizationId))
      directory.set(item.organizationId, {
        id: item.organizationId,
        name: item.organizationName,
        members: [],
      });
    directory.get(item.organizationId).members.push(item);
  }
  const request = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === '/api/admin/voice-assistant' && !options.method)
      return JSON.parse(JSON.stringify(snapshot));
    if (route === '/api/admin/voice-assistant/behavior' && !options.method)
      return {
        revision: snapshot.revision,
        version: 0,
        rules: {
          instructions: snapshot.policy.instructions,
          dictionary: snapshot.policy.dictionary,
          examples: snapshot.policy.examples || [],
        },
        versions: [
          { version: 0, time: null, actorId: null, reason: 'Initial rules', current: true },
        ],
        limits: {
          maxExamples: 50,
          maxEnabledExamples: 12,
          maxExampleTextChars: 500,
          maxEnabledExamplesBytes: 4096,
          maxInstructionsChars: 4000,
          maxDictionaryChars: 4000,
          maxRulesBytes: 65536,
          maxCodexInputBytes: 32768,
        },
        llmProvider: { ...snapshot.providers.llm },
      };
    if (route === '/api/admin/voice-assistant/audit') return { items: [] };
    if (route.startsWith('/api/admin/organization?'))
      return directory.get(new URL(route, window.location.href).searchParams.get('id'));
    return handler(route, options, snapshot);
  };
  const records = window.createAdminRecords();
  const api = window.createAdminVoice({
    $,
    request,
    records,
    message: (...args) => notices.push(args),
  });
  api.bind();
  const change = (selector, value) => {
    const input = $(selector);
    input.value = value;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const submit = (kind) =>
    $('[data-admin-voice-form="' + kind + '"]').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
  return { window, $, api, calls, notices, snapshot, directory, change, submit };
}
test('admin pilot is loaded on demand, exposes only metadata and never fills a saved API key', async (t) => {
  const f = boot(t);
  assert.equal(f.calls.length, 0);
  await f.api.load();
  assert.equal(f.$('[name="mode"]').value, 'off');
  assert.equal(f.$('[name="timewebApiKey"]').type, 'password');
  assert.equal(f.$('[name="timewebApiKey"]').value, '');
  assert.match(f.$('#admin-voice-settings').textContent, /ключ сохранён/);
  assert.match(f.$('#admin-voice-settings').textContent, /не счёт Timeweb/);
  assert.equal(f.$('#admin-voice-account').disabled, true);
  assert.ok(f.calls.every((call) => call.route.startsWith('/api/admin/voice-assistant')));
});
test('independent providers preserve a blank key and send explicit deletion only when selected', async (t) => {
  const posts = [],
    f = boot(t, async (route, options) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { revision: 4 };
      }
      return {};
    });
  await f.api.load();
  f.change('[name="provider.stt"]', 'timeweb');
  f.change('[name="reason"]', 'Тест конфигурации');
  f.submit('settings');
  await flush();
  assert.equal(posts[0].providers.stt.provider, 'timeweb');
  assert.equal(posts[0].providers.llm.provider, 'demo');
  assert.equal(posts[0].providers.tts.provider, 'demo');
  assert.equal(Object.hasOwn(posts[0], 'timewebApiKey'), false);
  f.$('[name="removeTimewebKey"]').checked = true;
  f.change('[name="reason"]', 'Удаление тестового ключа');
  f.submit('settings');
  await flush();
  assert.equal(posts[1].timewebApiKey, null);
});
test('Codex is LLM-only and reports local availability without claiming a signed-in session or making probe calls', async (t) => {
  const f = boot(t);
  await f.api.load();
  assert.ok(f.$('[name="provider.llm"] option[value="codex"]'));
  assert.equal(f.$('[name="provider.stt"] option[value="codex"]'), null);
  assert.equal(f.$('[name="provider.tts"] option[value="codex"]'), null);
  assert.match(f.$('[data-voice-codex-status]').textContent, /Авторизация проверяется при запросе/);
  const count = f.calls.length;
  f.change('[name="provider.llm"]', 'codex');
  assert.equal(f.calls.length, count);
  assert.match(f.$('[data-voice-llm-billing]').textContent, /лимиты подписки/);
  assert.match(
    f.$('[data-voice-llm-billing]').textContent,
    /Timeweb оплачивается отдельно для выбранных этапов/,
  );
  assert.equal(f.$('[name="model.codex"]').value, 'codex-default');
  assert.equal(f.$('[name="model.llm"]').disabled, true);
});
test('typed and saved models survive switching between Codex and Timeweb, including a successful Codex save', async (t) => {
  const f = boot(t, async (route, options, snapshot) => {
    if (options.method === 'POST') snapshot.providers = JSON.parse(options.body).providers;
    return { revision: 4 };
  });
  f.snapshot.providers.llm = { provider: 'timeweb', model: 'deepseek/saved-model' };
  await f.api.load();
  f.change('[name="provider.llm"]', 'codex');
  f.change('[name="model.codex"]', 'gpt-custom');
  f.change('[name="provider.llm"]', 'timeweb');
  assert.equal(f.$('[name="model.llm"]').value, 'deepseek/saved-model');
  f.change('[name="model.llm"]', 'deepseek/typed-model');
  f.change('[name="provider.llm"]', 'codex');
  assert.equal(f.$('[name="model.codex"]').value, 'gpt-custom');
  f.change('[name="reason"]', 'Локальная обработка команды');
  f.submit('settings');
  await flush();
  f.change('[name="provider.llm"]', 'timeweb');
  assert.equal(f.$('[name="model.llm"]').value, 'deepseek/typed-model');
  assert.equal(f.$('[name="model.codex"]').value, 'gpt-custom');
});
test('saving a Codex LLM keeps Timeweb speech stages and the stored key intact', async (t) => {
  let body;
  const f = boot(t, async (route, options) => {
    body = JSON.parse(options.body);
    return { revision: 4 };
  });
  f.snapshot.providers.stt.provider = 'timeweb';
  f.snapshot.providers.tts.provider = 'timeweb';
  await f.api.load();
  f.change('[name="provider.llm"]', 'codex');
  f.change('[name="reason"]', 'Смена только обработки команды');
  f.submit('settings');
  await flush();
  assert.equal(body.providers.llm.provider, 'codex');
  assert.equal(body.providers.llm.model, 'codex-default');
  assert.deepEqual(body.providers.stt, f.snapshot.providers.stt);
  assert.deepEqual(body.providers.tts, f.snapshot.providers.tts);
  assert.equal(Object.hasOwn(body, 'timewebApiKey'), false);
  assert.equal(f.$('[name="timewebApiKey"]').value, '');
  assert.match(f.$('#admin-voice-settings').textContent, /ключ сохранён/);
});
test('an initially saved Codex model has a sensible separate Timeweb default and honest unavailable status', async (t) => {
  const f = boot(t);
  f.snapshot.providers.llm = { provider: 'codex', model: 'codex-default' };
  f.snapshot.providerStatus.codex.available = false;
  await f.api.load();
  assert.equal(f.$('[name="model.codex"]').disabled, false);
  assert.match(f.$('[data-voice-codex-status]').textContent, /только в локальном просмотре/);
  f.change('[name="provider.llm"]', 'timeweb');
  assert.equal(f.$('[name="model.llm"]').value, 'deepseek/deepseek-flash');
  assert.equal(f.$('[name="model.codex"]').disabled, true);
});
test('local speech selectors are independent, canonical and do not allow a local command provider', async (t) => {
  const f = boot(t);
  f.snapshot.providerStatus.local = {
    available: true,
    localOnly: true,
    billing: 'local',
    stt: { available: false },
    tts: { available: true },
  };
  await f.api.load();
  const count = f.calls.length;
  f.change('[name="provider.stt"]', 'local');
  f.change('[name="provider.tts"]', 'local');
  f.change('[name="provider.llm"]', 'codex');
  assert.equal(f.calls.length, count, 'selection alone never saves settings or probes a provider');
  assert.equal(f.$('[name="model.stt"]').value, 'whisper-base');
  assert.equal(f.$('[name="model.tts"]').value, 'system-ru');
  assert.equal(f.$('[name="voice.tts"]').value, 'ru-local');
  assert.equal(f.$('[name="provider.llm"] option[value="local"]'), null);
  assert.equal(
    f.$('[name="provider.stt"] option[value="local"]').textContent,
    'Локально (Whisper)',
  );
  assert.equal(
    f.$('[name="provider.tts"] option[value="local"]').textContent,
    'Локальный голос устройства',
  );
  assert.equal(f.$('[name="voice.tts"]').options.length, 1);
  const stt = f.$('[data-voice-provider="stt"] [data-voice-local-status]'),
    tts = f.$('[data-voice-provider="tts"] [data-voice-local-status]');
  assert.equal(stt.hidden, false);
  assert.match(stt.textContent, /Whisper пока недоступен/);
  assert.equal(tts.hidden, false);
  assert.match(tts.textContent, /Браузер проверит/);
  assert.match(tts.textContent, /текущем компьютере/);
  assert.doesNotMatch(tts.textContent, /голос найден|голос готов/i);
  assert.match(f.$('[data-voice-llm-billing]').textContent, /Codex расходует лимиты подписки/);
});
test('switching speech providers restores each saved Timeweb model and voice and local save preserves the key', async (t) => {
  let body;
  const f = boot(t, async (route, options, snapshot) => {
    body = JSON.parse(options.body);
    snapshot.providers = body.providers;
    return { revision: 4 };
  });
  f.snapshot.providers.stt = { provider: 'timeweb', model: 'openai/gpt-4o-transcribe' };
  f.snapshot.providers.tts = {
    provider: 'timeweb',
    model: 'openai/gpt-4o-mini-tts',
    voice: 'cedar',
  };
  await f.api.load();
  f.change('[name="provider.stt"]', 'local');
  f.change('[name="provider.tts"]', 'local');
  f.change('[name="provider.llm"]', 'codex');
  f.change('[name="reason"]', 'Локальная речь и команды Codex');
  f.submit('settings');
  await flush();
  assert.deepEqual(body.providers.stt, { provider: 'local', model: 'whisper-base' });
  assert.deepEqual(body.providers.tts, {
    provider: 'local',
    model: 'system-ru',
    voice: 'ru-local',
  });
  assert.deepEqual(body.providers.llm, { provider: 'codex', model: 'codex-default' });
  assert.equal(Object.hasOwn(body, 'timewebApiKey'), false);
  assert.equal(f.$('[name="timewebApiKey"]').value, '');
  f.change('[name="provider.stt"]', 'timeweb');
  f.change('[name="provider.tts"]', 'timeweb');
  assert.equal(f.$('[name="model.stt"]').value, 'openai/gpt-4o-transcribe');
  assert.equal(f.$('[name="voice.tts"]').value, 'cedar');
  assert.equal(f.$('[name="voice.tts"] option[value="ru-local"]'), null);
  f.change('[name="voice.tts"]', 'nova');
  f.change('[name="provider.tts"]', 'local');
  assert.equal(f.$('[name="voice.tts"]').value, 'ru-local');
  f.change('[name="provider.tts"]', 'timeweb');
  assert.equal(f.$('[name="voice.tts"]').value, 'nova');
});
test('saved local providers render with an older status response without claiming device readiness', async (t) => {
  const f = boot(t);
  f.snapshot.providers.stt = { provider: 'local', model: 'whisper-base' };
  f.snapshot.providers.tts = { provider: 'local', model: 'system-ru', voice: 'ru-local' };
  await f.api.load();
  assert.equal(f.$('[name="provider.stt"]').value, 'local');
  assert.equal(f.$('[name="model.stt"]').value, 'whisper-base');
  assert.equal(f.$('[name="voice.tts"]').value, 'ru-local');
  assert.match(
    f.$('[data-voice-provider="tts"] [data-voice-local-status]').textContent,
    /Браузер отдельно проверит/,
  );
  assert.equal(
    f.calls.some((call) => call.options.method === 'POST'),
    false,
  );
});
test('unknown save retries the identical scoped command and clears the password input', async (t) => {
  const posts = [],
    f = boot(t, async (route, options) => {
      if (options.method !== 'POST') return {};
      posts.push(options.body);
      if (posts.length === 1)
        throw Object.assign(Error('Synthetic transport failure'), { unknown: true });
      return { revision: 4 };
    });
  await f.api.load();
  f.change('[name="timewebApiKey"]', 'SYNTHETIC-SECRET-ONLY');
  f.change('[name="reason"]', 'Тест неизвестного ответа');
  f.submit('settings');
  await flush();
  assert.equal(f.$('[name="timewebApiKey"]').value, '');
  assert.equal(f.$('[data-voice-fields]').disabled, true);
  f.submit('settings');
  await flush();
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
  assert.equal(JSON.parse(posts[1]).timewebApiKey, 'SYNTHETIC-SECRET-ONLY');
  assert.doesNotMatch(f.$('#admin-voice-assistant').innerHTML, /SYNTHETIC-SECRET-ONLY/);
});
test('late membership response cannot replace the subsequently selected organization and user', async (t) => {
  const first = deferred(),
    second = deferred();
  const f = boot(t, async (route) =>
    route.includes('organizationId=org-a') ? first.promise : second.promise,
  );
  await f.api.load();
  f.change('#admin-voice-organization', 'org-a');
  await flush();
  f.change('#admin-voice-account', 'account-a');
  f.change('#admin-voice-organization', 'org-b');
  await flush();
  f.change('#admin-voice-account', 'account-b');
  second.resolve({
    revision: 3,
    enabled: false,
    membershipId: 'membership-b',
    effective: { enabled: false, reason: 'Участие в закрытом тестировании не разрешено.' },
  });
  await flush();
  first.resolve({
    revision: 3,
    enabled: true,
    membershipId: 'membership-a',
    effective: { enabled: true, reason: 'Доступ включён.' },
  });
  await flush();
  assert.match(f.$('#admin-voice-member').textContent, /Второй пользователь/);
  assert.doesNotMatch(f.$('#admin-voice-member').textContent, /Первый пользователь/);
  assert.equal(f.$('[name="enabled"]').checked, false);
});
test('history restores only its revision and reason, never credentials or member grants', async (t) => {
  let body;
  const f = boot(t, async (route, options) => {
    assert.equal(route, '/api/admin/voice-assistant/restore');
    body = JSON.parse(options.body);
    return { revision: 4 };
  });
  await f.api.load();
  f.change('[data-admin-voice-form="restore"] [name="revision"]', '1');
  f.change('[data-admin-voice-form="restore"] [name="reason"]', 'Возврат тестовой политики');
  f.submit('restore');
  await flush();
  assert.deepEqual(Object.keys(body).sort(), [
    'expectedRevision',
    'reason',
    'requestId',
    'revision',
  ]);
  assert.equal(body.revision, 1);
  assert.equal(body.expectedRevision, 3);
});
test('personal enabling sends only the selected organization membership and its revision', async (t) => {
  let command;
  const f = boot(t, async (route, options) => {
    if (options.method === 'POST') {
      command = JSON.parse(options.body);
      return { revision: 4 };
    }
    return {
      revision: 3,
      enabled: false,
      membershipId: 'membership-b',
      effective: { enabled: false, reason: 'Помощник выключен главным администратором.' },
    };
  });
  await f.api.load();
  f.change('#admin-voice-organization', 'org-b');
  await flush();
  f.change('#admin-voice-account', 'account-b');
  await flush();
  f.$('[name="enabled"]').checked = true;
  f.change('[data-admin-voice-form="member"] [name="reason"]', 'Выбор участника пилота');
  f.submit('member');
  await flush();
  assert.equal(command.organizationId, 'org-b');
  assert.equal(command.accountId, 'account-b');
  assert.equal(command.expectedRevision, 3);
  assert.equal(command.enabled, true);
  assert.equal(Object.hasOwn(command, 'policy'), false);
  assert.equal(Object.hasOwn(command, 'timewebApiKey'), false);
});
test('organization directory finds and enables an older member absent from the truncated initial snapshot', async (t) => {
  let command;
  const f = boot(t, async (route, options) => {
    if (route.startsWith('/api/admin/organizations?')) {
      const cursor = new URL(route, 'http://synthetic.invalid').searchParams.get('cursor');
      return {
        items: cursor ? [{ id: 'org-old', name: 'Давняя организация' }] : [],
        total: 1,
        nextCursor: cursor ? null : 'synthetic-cursor',
      };
    }
    if (options.method === 'POST') {
      command = JSON.parse(options.body);
      return { revision: 4 };
    }
    return {
      revision: 3,
      enabled: false,
      membershipId: 'membership-old',
      effective: { enabled: false, reason: 'Участие в закрытом тестировании не разрешено.' },
    };
  });
  f.snapshot.membershipsTruncated = true;
  f.directory.set('org-old', {
    id: 'org-old',
    name: 'Давняя организация',
    members: [
      {
        accountId: 'account-old',
        displayName: 'Давний пользователь',
        role: 'owner',
        status: 'active',
      },
    ],
  });
  await f.api.load();
  f.$('#admin-voice-org-search').value = 'Давняя';
  f.$('#admin-voice-org-search-form').dispatchEvent(
    new f.window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('#admin-voice-org-more').click();
  await flush();
  f.change('#admin-voice-organization', 'org-old');
  await flush();
  f.change('#admin-voice-account', 'account-old');
  await flush();
  assert.match(f.$('#admin-voice-member').textContent, /Давний пользователь/);
  f.$('[name="enabled"]').checked = true;
  f.change('[data-admin-voice-form="member"] [name="reason"]', 'Доступ давнему участнику');
  f.submit('member');
  await flush();
  assert.equal(command.organizationId, 'org-old');
  assert.equal(command.accountId, 'account-old');
  assert.ok(f.calls.some((call) => call.route.includes('cursor=synthetic-cursor')));
  assert.ok(f.calls.every((call) => call.route.startsWith('/api/admin/')));
});
test('form bounds match server policy validation and constrain keys, model names and text', async (t) => {
  const f = boot(t);
  await f.api.load();
  const { initialState, patchSettings } = require('../src/server/modules/assistant/access/defaults.cjs');
  for (const key of Object.keys(f.snapshot.policy.limits)) {
    const field = f.$('[name="limit.' + key + '"]');
    for (const value of [Number(field.min), Number(field.max)])
      assert.doesNotThrow(() =>
        patchSettings(initialState(), { policy: { limits: { [key]: value } } }),
      );
    field.value = String(Number(field.max) + 1);
    assert.equal(field.checkValidity(), false);
  }
  await flush();
  assert.equal(f.$('[data-behavior-rules] [name="instructions"]').maxLength, 4000);
  assert.equal(f.$('[data-behavior-rules] [name="dictionary"]').maxLength, 4000);
  assert.equal(f.$('[name="reason"]').minLength, 3);
  assert.equal(f.$('[name="reason"]').maxLength, 300);
  assert.equal(f.$('[name="model.llm"]').maxLength, 120);
  assert.equal(f.$('[name="timewebApiKey"]').minLength, 12);
  assert.equal(f.$('[name="timewebApiKey"]').maxLength, 512);
  f.$('[name="rate.llmInput"]').value = '0';
  assert.equal(f.$('[name="rate.llmInput"]').checkValidity(), false);
});
test('provider and effective reason text are escaped and unknown audit details remain hidden', (t) => {
  const f = boot(t),
    records = f.window.createAdminRecords();
  const view = f.window.createAdminVoiceView({ records }),
    snapshot = settings();
  snapshot.providers.llm.model = '<img src=x onerror=alert(1)>';
  snapshot.timewebApiKey = 'SAVED-SECRET-MUST-NOT-RENDER';
  const html =
    view.settings(snapshot) +
    view.membership(
      {
        enabled: false,
        revision: 1,
        effective: { enabled: false, reason: '<script>bad</script>' },
      },
      snapshot.memberships[0],
    ) +
    view.audit([
      {
        event: 'assistant_settings_changed',
        time: 1,
        actorId: 'synthetic',
        detail: {
          reason: '<svg onload=bad()>',
          apiKey: 'SAVED-SECRET-MUST-NOT-RENDER',
          clinical: 'PRIVATE-CLINICAL',
        },
      },
    ]);
  const template = f.window.document.createElement('template');
  template.innerHTML = html;
  assert.equal(template.content.querySelector('img,script,svg'), null);
  assert.doesNotMatch(html, /SAVED-SECRET-MUST-NOT-RENDER|PRIVATE-CLINICAL/);
});

test('personal limits render collapsed, submit selected member overrides and explicitly clear emptied fields', async (t) => {
  const posts = [];
  const member = { revision: 3, enabled: true, membershipId: 'membership-b',
    limits: { dailyRequests: 1000, maxAudioSeconds: 60 },
    effectiveLimits: { ...settings().policy.limits, dailyRequests: 1000, maxAudioSeconds: 60 },
    effective: { enabled: true, reason: 'Синтетический доступ' } };
  const f = boot(t, async (route, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); posts.push(body);
      member.limits = body.limits; member.revision++;
      return { revision: member.revision };
    }
    return member;
  });
  await f.api.load(); f.change('#admin-voice-organization', 'org-b'); await flush();
  f.change('#admin-voice-account', 'account-b'); await flush();
  const details = f.$('#admin-voice-member details');
  assert.equal(details.open, false);
  assert.equal(details.querySelectorAll('input').length, 6);
  assert.equal(details.querySelector('[name="memberLimit.monthlyBudgetRub"]'), null);
  assert.equal(f.$('[name="memberLimit.dailyRequests"]').value, '1000');
  f.change('[name="memberLimit.maxTextChars"]', '4000');
  f.change('[data-admin-voice-form="member"] [name="reason"]', 'Временные лимиты для теста');
  f.submit('member'); await flush();
  assert.deepEqual(posts[0].limits, { dailyRequests: 1000, maxAudioSeconds: 60, maxTextChars: 4000 });
  assert.equal(posts[0].accountId, 'account-b');assert.equal(posts[0].organizationId, 'org-b');
  for (const input of f.$('#admin-voice-member details').querySelectorAll('input')) input.value = '';
  f.change('[data-admin-voice-form="member"] [name="reason"]', 'Вернуть общие лимиты');
  f.submit('member'); await flush();
  assert.equal(posts[1].limits, null);
});
