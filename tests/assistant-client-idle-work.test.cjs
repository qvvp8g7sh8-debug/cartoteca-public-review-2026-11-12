const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clock() {
  let now = 0,
    next = 0;
  const timers = new Map(),
    fired = [];
  const time = {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    now: () => now,
    timers,
    fired,
    setTimeout(callback, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0, 'timer must be finite and bounded');
      const id = ++next;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async flush() {
      for (let index = 0; index < 16; index++) await Promise.resolve();
    },
    async advance(milliseconds, afterTimer = () => {}) {
      const end = now + milliseconds;
      for (let count = 0; ; count++) {
        assert.ok(count < 10000, 'synthetic scheduler must terminate');
        const item = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!item || item[1].at > end) break;
        timers.delete(item[0]);
        now = item[1].at;
        fired.push(now);
        item[1].callback();
        await time.flush();
        afterTimer();
      }
      now = end;
      await time.flush();
    },
  };
  return time;
}
function surfaces(time) {
  const calls = [],
    observers = [];
  class Node {
    constructor(name, parent = null) {
      this.name = name;
      this.parentNode = parent;
      this.hidden = false;
      this.isConnected = true;
      this.disabled = false;
      this.handlers = new Map();
      this.attrs = new Map();
      const classes = new Set();
      this.classList = {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value),
      };
    }
    addEventListener(type, callback, options = false) {
      const capture = typeof options === 'boolean' ? options : options.capture === true;
      const rows = this.handlers.get(type) || [];
      if (!rows.some((row) => row.callback === callback && row.capture === capture))
        rows.push({
          callback,
          capture,
          once: typeof options === 'object' && options.once === true,
        });
      this.handlers.set(type, rows);
    }
    removeEventListener(type, callback, options = false) {
      const capture = typeof options === 'boolean' ? options : options.capture === true;
      this.handlers.set(
        type,
        (this.handlers.get(type) || []).filter(
          (row) => row.callback !== callback || row.capture !== capture,
        ),
      );
    }
    contains(node) {
      for (let row = node; row; row = row.parentNode) if (row === this) return true;
      return false;
    }
    closest(selector) {
      for (let row = this; row; row = row.parentNode)
        if (
          (selector === '[hidden]' && row.hidden) ||
          (selector === '#global-view' && row.name === '#global-view')
        )
          return row;
      return null;
    }
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    }
    setAttribute(name, value) {
      this.attrs.set(name, value);
    }
    removeAttribute(name) {
      this.attrs.delete(name);
    }
    setPointerCapture(id) {
      this.captured = id;
    }
    hasPointerCapture(id) {
      return this.captured === id;
    }
    releasePointerCapture() {
      this.captured = null;
    }
  }
  const window = new Node('window'),
    document = new Node('document', window),
    body = new Node('body', document);
  const view = new Node('#global-view', body),
    parent = new Node('calendar-toolbar', view);
  const button = new Node('#calendar-new', parent),
    unrelated = new Node('unrelated-calendar-content', view);
  const leaf = new Node('unrelated-deep-child', unrelated);
  document.body = body;
  document.hidden = false;
  document.querySelector = (selector) => (selector === '#calendar-new' ? button : null);
  window.setTimeout = time.setTimeout;
  window.clearTimeout = time.clearTimeout;
  window.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.live = true;
      observers.push(this);
    }
    observe(target, options) {
      this.live = true;
      this.targets.push({ target, options });
    }
    disconnect() {
      this.live = false;
      this.targets = [];
    }
  };
  function dispatch(target, type, extra = {}) {
    const event = {
      type,
      target,
      detail: 1,
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 0,
      clientY: 0,
      ...extra,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
    };
    const chain = [];
    for (let node = target; node; node = node.parentNode) chain.push(node);
    const visit = (node, capture) => {
      for (const row of [...(node.handlers.get(type) || [])]) {
        if (row.capture !== capture || event.stopped) continue;
        if (row.once) node.removeEventListener(type, row.callback, capture);
        calls.push({ surface: node.name, type });
        row.callback(event);
      }
    };
    for (const node of [...chain].reverse()) visit(node, true);
    for (const node of chain) visit(node, false);
    return event;
  }
  function mutate(target, type = 'childList', attributeName) {
    for (const observer of observers) {
      if (!observer.live) continue;
      const matched = observer.targets.some(
        (row) =>
          (row.target === target || (row.options.subtree && row.target.contains(target))) &&
          ((type === 'childList' && row.options.childList) ||
            (type === 'attributes' &&
              row.options.attributes &&
              (!row.options.attributeFilter ||
                row.options.attributeFilter.includes(attributeName)))),
      );
      if (matched) {
        calls.push({ surface: 'observer', type });
        observer.callback([{ type, target, attributeName }]);
      }
    }
  }
  return { window, document, view, parent, button, unrelated, leaf, calls, dispatch, mutate };
}
function evaluate(file, factory, context, ...args) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  return vm.runInNewContext(source + '\n' + factory, context)(...args);
}
function triggerFixture(activateAudio = null, onOpen = null) {
  const time = clock(),
    ui = surfaces(time),
    opened = [];
  const state = {
    account: { id: 'synthetic-account', organizationId: 'synthetic-org', role: 'owner' },
    currentView: 'calendar',
    assistantReady: true,
    assistantGeneration: 1,
    assistantOpen: false,
    assistantScope: { enabled: true, organizationId: 'synthetic-org', policyVersion: 1 },
    busy: false,
    editorMode: false,
  };
  const api = evaluate(
    'src/client/modules/assistant-trigger.js',
    'createAssistantTrigger',
    ui,
    state,
  );
  api.mountAssistantTrigger((value) => {
    opened.push(value);
    onOpen?.(value);
  }, activateAudio);
  return { ...ui, time, state, api, opened };
}
const globalPointers = (calls) =>
  calls.filter((row) => row.surface === 'window' && /^pointer/u.test(row.type));

test('closed assistant has no global pointer callback work without an active gesture', async (t) => {
  for (const hidden of [false, true])
    await t.test('hidden=' + hidden, () => {
      const f = triggerFixture();
      f.document.hidden = hidden;
      for (let index = 0; index < 1000; index++) {
        f.dispatch(f.leaf, 'pointerdown');
        f.dispatch(f.leaf, 'pointermove');
        f.dispatch(f.leaf, 'pointerup');
      }
      const count = globalPointers(f.calls).length;
      assert.equal(f.opened.length, 0);
      f.api.destroyAssistantTrigger();
      assert.equal(count, 0, 'idle hidden=' + hidden + ': unrelated pointer callbacks=' + count);
    });
});

test('unrelated deep calendar mutations do not repeatedly invoke the trigger observer', () => {
  const f = triggerFixture();
  for (let index = 0; index < 1000; index++) f.mutate(f.leaf);
  const callbacks = f.calls.filter((row) => row.surface === 'observer').length;
  assert.equal(f.opened.length, 0);
  f.api.destroyAssistantTrigger();
  assert.equal(callbacks, 0, 'unrelated subtree observer callbacks=' + callbacks);
});

test('a600ms hold opens before release and only it blocks the trailing pointer click', async () => {
  const f = triggerFixture();
  f.dispatch(f.button, 'pointerdown');
  await f.time.advance(599);
  assert.equal(f.opened.length, 0);
  await f.time.advance(1);
  assert.equal(f.opened.length, 1, 'start at the threshold while still held');
  await f.time.advance(5000);
  assert.equal(f.opened.length, 1, 'continued holding cannot start twice');
  f.dispatch(f.button, 'pointerup');
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].voice, true);
  assert.equal(f.dispatch(f.button, 'click').prevented, true);
  const keyboardClick = f.dispatch(f.button, 'click', { detail: 0 });
  assert.equal(keyboardClick.prevented, false);
  f.api.destroyAssistantTrigger();
});

test('movement multitouch hidden ancestor removal and scope revocation cancel an active hold', async (t) => {
  const variants = [
    ['movement', (f) => f.dispatch(f.leaf, 'pointermove', { clientX: 11 })],
    ['second pointer', (f) => f.dispatch(f.leaf, 'pointerdown', { pointerId: 2 })],
    [
      'hidden ancestor',
      (f) => {
        f.parent.hidden = true;
        f.mutate(f.parent, 'attributes', 'hidden');
      },
    ],
    [
      'button removed',
      (f) => {
        f.button.isConnected = false;
        f.mutate(f.parent);
      },
    ],
    [
      'generation revoked',
      (f) => {
        f.state.assistantGeneration++;
      },
    ],
    [
      'policy revoked',
      (f) => {
        f.state.assistantScope.enabled = false;
      },
    ],
    [
      'document hidden',
      (f) => {
        f.document.hidden = true;
        f.dispatch(f.document, 'visibilitychange');
      },
    ],
  ];
  for (const [name, change] of variants)
    await t.test(name, async () => {
      const f = triggerFixture();
      f.dispatch(f.button, 'pointerdown');
      change(f);
      await f.time.advance(600);
      assert.equal(f.opened.length, 0);
      f.api.destroyAssistantTrigger();
    });
});

function backgroundFixture({ inboxInterval = 15000, activeTelegram = false, hidden = false } = {}) {
  const time = clock(),
    ui = surfaces(time),
    runs = [],
    requests = [],
    wakes = [];
  let inboxDeadline = 0;
  const state = {
    account: { id: 'synthetic-account', organizationId: 'synthetic-org' },
    currentView: 'other',
    multiUser: !activeTelegram,
    settingsReady: true,
    sessionReady: true,
    assistantOpen: false,
    busy: !activeTelegram,
    workspace: {},
    teamAccess: {},
  };
  ui.document.hidden = hidden;
  const run = (name) => {
    runs.push({ name, at: time.now() });
  };
  const actions = {
    $: () => null,
    earlyAccessVisible: () => false,
    improvementsVisible: () => false,
    canManageTeam: () => false,
    bookingHealthInterval: () => 60000,
    bookingHealthDeadline: () => 60000,
    bookingInboxInterval: () => inboxInterval,
    bookingInboxDeadline: () => inboxDeadline,
    refreshBookingInbox: () => {
      inboxDeadline = time.now() + inboxInterval;
      run('inbox');
    },
    refreshBookingHealth: () => run('health'),
    loadEarlyAccess: () => run('early'),
    loadImprovements: () => run('improvements'),
    refreshTeamInvitations: () => run('invitations'),
    loadCalendarSchedule: () => run('schedule'),
    updateCurrentTime: () => run('clock'),
    refreshCabinetTimeZone: () => run('zone'),
    loadCalendarRecords: () => run('calendar'),
    loadRoomAvailability: () => run('rooms'),
    syncVisibleTelegram: () => run('telegram'),
    request: async (url) => {
      requests.push(url);
      return { user: state.account, assistant: {} };
    },
    applyAssistantScope() {},
    resetAssistant() {
      assert.fail('unchanged synthetic session');
    },
  };
  const api = evaluate(
    'src/client/core/background-refresh.js',
    'createBackgroundRefresh',
    {
      ...ui,
      Date: time.Date,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      location: {
        replace() {
          assert.fail('unchanged synthetic session');
        },
      },
    },
    state,
    actions,
  );
  return {
    ...ui,
    time,
    state,
    api,
    runs,
    requests,
    wakes,
    async start() {
      api.bindBackgroundEvents();
      await api.refreshBackground();
      await time.flush();
    },
    async advance(milliseconds) {
      let lastRuns = runs.length;
      await time.advance(milliseconds, () => {
        wakes.push({ at: time.now(), productive: runs.length > lastRuns });
        lastRuns = runs.length;
      });
    },
  };
}

test('shared refresh keeps a bounded readiness fallback without extra direct network reads', async (t) => {
  for (const seconds of [15, 30, 60])
    await t.test('inbox' + seconds + 's', async (t) => {
      const f = backgroundFixture({ inboxInterval: seconds * 1000 });
      await f.start();
      await f.advance(60000);
      const empty = f.wakes.filter((row) => !row.productive).length;
      t.diagnostic(
        JSON.stringify({
          virtualSeconds: 60,
          inboxIntervalSeconds: seconds,
          timerWakes: f.wakes.length,
          emptyWakes: empty,
          runs: f.runs,
          directRequests: f.requests.length,
        }),
      );
      const inboxTimes = Array.from(
        { length: 60 / seconds + 1 },
        (_, index) => index * seconds * 1000,
      );
      assert.deepEqual(
        f.runs.filter((row) => row.name === 'inbox').map((row) => row.at),
        inboxTimes,
      );
      assert.deepEqual(
        f.runs.filter((row) => row.name === 'clock').map((row) => row.at),
        [0, 30000, 60000],
      );
      assert.ok(f.runs.every((row) => ['inbox', 'clock'].includes(row.name)));
      assert.ok(
        f.wakes.length > 0 && f.wakes.length <= 16,
        'readiness fallback stays bounded per virtual minute',
      );
      assert.equal(f.requests.length, 0, 'no additional scheduler auth read on ordinary ticks');
      f.dispatch(f.window, 'pagehide');
      assert.equal(f.time.timers.size, 0);
    });
});

test('intentional active Telegram4second refresh remains timely and productive', async () => {
  const f = backgroundFixture({ activeTelegram: true });
  await f.start();
  await f.advance(20000);
  assert.deepEqual(
    f.runs.filter((row) => row.name === 'telegram').map((row) => row.at),
    [0, 4000, 8000, 12000, 16000, 20000],
  );
  assert.equal(f.wakes.filter((row) => !row.productive).length, 0);
  f.dispatch(f.window, 'pagehide');
  assert.equal(f.time.timers.size, 0);
});

test('hidden tab has no scheduled wakes and resume retains one fresh session/scope check', async () => {
  const f = backgroundFixture({ hidden: true });
  await f.start();
  await f.advance(60000);
  assert.equal(f.wakes.length, 0);
  assert.equal(f.runs.length, 0);
  assert.equal(f.requests.length, 0);
  f.document.hidden = false;
  f.dispatch(f.document, 'visibilitychange');
  await f.time.flush();
  f.dispatch(f.window, 'focus');
  await f.time.flush();
  assert.deepEqual(f.requests, ['/api/auth/session']);
  assert.ok(f.runs.some((row) => row.name === 'inbox'));
  f.dispatch(f.window, 'pagehide');
  assert.equal(f.time.timers.size, 0);
});

test('confirmed hold starts at the threshold and trusted release only retries audio, leaving short taps cold', async () => {
  let primes = 0;
  const f = triggerFixture(() => {
    primes++;
  });
  f.dispatch(f.button, 'pointerdown');
  f.dispatch(f.button, 'pointerup', { isTrusted: true });
  assert.equal(primes, 0);
  f.dispatch(f.button, 'pointerdown');
  await f.time.advance(600);
  assert.equal(f.opened.length, 1);
  assert.equal(primes, 1);
  f.dispatch(f.button, 'pointerup', { isTrusted: true });
  assert.equal(primes, 2);
  assert.equal(f.opened.length, 1);
  f.dispatch(f.button, 'click', { isTrusted: true });
  assert.equal(primes, 2);
  f.api.destroyAssistantTrigger();
});

test('timer starts once before a microphone permission prompt blurs the window', async () => {
  const order = [];
  let f;
  f = triggerFixture(
    () => {
      order.push('audio');
    },
    () => {
      order.push('open');
      f.dispatch(f.window, 'blur');
    },
  );
  f.dispatch(f.button, 'pointerdown', { isTrusted: true, pointerType: 'touch' });
  await f.time.advance(599);
  assert.deepEqual(order, []);
  await f.time.advance(1);
  assert.deepEqual(order, ['audio', 'open']);
  f.dispatch(f.button, 'pointerup', { isTrusted: true, pointerType: 'touch' });
  assert.deepEqual(order, ['audio', 'open']);
  assert.equal(f.opened.length, 1);
  assert.equal(f.dispatch(f.button, 'click', { isTrusted: true }).prevented, true);
  assert.deepEqual(order, ['audio', 'open'], 'the trailing click cannot reopen or prime again');
  f.api.destroyAssistantTrigger();
});

test('a pending hold cannot start audio or voice after cancellation or context changes before threshold', async (t) => {
  const variants = [
    ['blur', (f) => f.dispatch(f.window, 'blur')],
    ['movement', (f) => f.dispatch(f.button, 'pointermove', { clientX: 11 })],
    ['pointer cancellation', (f) => f.dispatch(f.button, 'pointercancel', { isTrusted: true })],
    [
      'generation',
      (f) => {
        f.state.assistantGeneration++;
      },
    ],
    [
      'role',
      (f) => {
        f.state.account.role = 'cosmetologist';
      },
    ],
    [
      'policy',
      (f) => {
        f.state.assistantScope.policyVersion++;
      },
    ],
    [
      'busy',
      (f) => {
        f.state.busy = true;
      },
    ],
    [
      'editor',
      (f) => {
        f.state.editorMode = { kind: 'appointment' };
      },
    ],
  ];
  for (const [name, change] of variants)
    await t.test(name, async () => {
      let primes = 0;
      const f = triggerFixture(() => {
        primes++;
      });
      f.dispatch(f.button, 'pointerdown', { isTrusted: true, pointerType: 'touch' });
      await f.time.advance(599);
      change(f);
      await f.time.advance(1);
      f.dispatch(f.button, 'pointerup', { isTrusted: true, pointerType: 'touch' });
      assert.equal(primes, 0);
      assert.equal(f.opened.length, 0);
      assert.equal(f.dispatch(f.button, 'click', { isTrusted: true }).prevented, true);
      f.api.destroyAssistantTrigger();
    });
});
test('revoked hold cannot prime output and keyboard activates before asynchronous panel opening', async () => {
  let primes = 0;
  const f = triggerFixture(() => {
    primes++;
  });
  f.dispatch(f.button, 'pointerdown');
  await f.time.advance(599);
  f.state.assistantGeneration++;
  await f.time.advance(1);
  f.dispatch(f.button, 'pointerup', { isTrusted: true });
  assert.equal(primes, 0);
  f.api.destroyAssistantTrigger();
  const g = triggerFixture(() => {
    assert.equal(g.opened.length, 0);
    primes++;
  });
  g.dispatch(g.button, 'keydown', { key: 'Enter', shiftKey: true, isTrusted: true });
  assert.equal(primes, 1);
  assert.equal(g.opened.length, 1);
  g.api.destroyAssistantTrigger();
});
