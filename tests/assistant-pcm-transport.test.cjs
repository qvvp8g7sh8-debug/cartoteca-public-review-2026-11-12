const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const source = fs.readFileSync('src/client/modules/assistant-pcm-transport.js', 'utf8');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
};
function fixture(
  t,
  {
    supported = true,
    constructError = false,
    ready = true,
    portReady = true,
    protocol = 1,
    preparedProtocol = 1,
  } = {},
) {
  const workers = [],
    controls = [],
    timers = new Map();
  let serial = 0,
    current = true;
  const owner = {};
  class Worker {
    constructor(url) {
      if (constructError) throw Error('synthetic');
      this.url = url;
      this.messages = [];
      this.ports = [];
      this.terminated = false;
      workers.push(this);
      if (ready) queueMicrotask(() => this.emit({ type: 'ready', protocol }));
    }
    emit(data) {
      this.onmessage?.({ data });
    }
    postMessage(data) {
      this.messages.push(data);
      if (data.type === 'prepare') {
        this.ports.push(data.port);
        data.port.onmessage = ({ data: m }) => {
          if (m.type === 'ready')
            this.emit({ type: 'prepared', protocol: preparedProtocol, id: data.id });
        };
      }
      if (data.type === 'cancel') for (const p of this.ports) p.close();
    }
    terminate() {
      this.terminated = true;
      for (const p of this.ports) p.close();
    }
  }
  const node = {
    port: {
      postMessage(data) {
        controls.push(data);
        if (data.type === 'transport' && portReady) {
          data.port.postMessage({ type: 'ready', protocol: 1, id: data.id });
        }
        if (data.type === 'transport-cancel')
          for (const x of controls) if (x.type === 'transport' && x.id === data.id) x.port.close();
      },
    },
  };
  const context = {
    window: { Worker: supported ? Worker : undefined, MessageChannel },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
    setTimeout: (fn, delay) => {
      const id = ++serial;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    Number,
    Math,
    Promise,
  };
  const api = vm
    .runInNewContext(source + '\ncreateAssistantPcmTransport', context)()
    .assistantPcmTransport();
  t.after(() => api.release(owner));
  return {
    api,
    owner,
    node,
    workers,
    controls,
    timers,
    current: () => current,
    setCurrent: (v) => (current = v),
    async prepare(id = 1, onHeaders = () => {}, onFirstByte = () => {}) {
      return api.prepare(owner, { id, node, current: () => current, onHeaders, onFirstByte });
    },
  };
}
const meta = {
  status: 200,
  ok: true,
  contentType: 'audio/pcm',
  sampleRate: '24000',
  channels: '1',
  sampleFormat: 's16le',
  serverTiming: '',
};
const request = {
  url:
    '/api/assistant/speak-audio?ticket=' +
    'a'.repeat(43) +
    '&accountContext=a&organizationContext=o',
  accountContext: { accountId: 'a', organizationId: 'o' },
};
test('unsupported and constructor/setup failure return null before any GET', async (t) => {
  for (const options of [{ supported: false }, { constructError: true }]) {
    const f = fixture(t, options);
    assert.equal(await f.prepare(), null);
    assert.equal(f.workers.length, 0);
  }
  const f = fixture(t, { portReady: false });
  const p = f.prepare();
  await flush();
  for (const timer of [...f.timers.values()]) timer.fn();
  assert.equal(await p, null);
  assert.ok(!f.workers[0].messages.some((m) => m.type === 'start'));
});
test('both data-port and Worker readiness precede start; strict headers authorize body accept', async (t) => {
  const f = fixture(t);
  let headers = 0,
    first = 0;
  const h = await f.prepare(
    1,
    (m) => {
      headers++;
      assert.equal(m.status, 200);
    },
    () => first++,
  );
  assert.ok(h);
  const w = f.workers[0];
  assert.equal(w.messages.filter((m) => m.type === 'start').length, 0);
  const done = h.start(request);
  w.emit({ type: 'headers', id: 1, meta });
  await flush();
  assert.equal(headers, 1);
  assert.equal(w.messages.filter((m) => m.type === 'accept').length, 1);
  w.emit({ type: 'firstByte', id: 1 });
  w.emit({ type: 'end', id: 1 });
  h.eof();
  await done;
  assert.equal(first, 1);
  assert.equal(w.messages.filter((m) => m.type === 'start').length, 1);
  await assert.rejects(h.start(request));
  h.cancel();
  assert.ok(f.controls.some((m) => m.type === 'transport-cancel' && m.id === 1));
});
test('fresh main header refusal rejects original error and aborts without acceptance or retry', async (t) => {
  const f = fixture(t),
    error = Object.assign(Error('synthetic refusal'), { status: 428 });
  const h = await f.prepare(1, () => {
    throw error;
  });
  const done = h.start(request);
  f.workers[0].emit({ type: 'headers', id: 1, meta: { ...meta, status: 428, ok: false } });
  await assert.rejects(done, (e) => e === error);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'accept').length, 0);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 1);
});
test('owner change during asynchronous header validation cannot accept old output', async (t) => {
  let resolve;
  const f = fixture(t),
    h = await f.prepare(
      1,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  const done = h.start(request);
  f.workers[0].emit({ type: 'headers', id: 1, meta });
  f.setCurrent(false);
  resolve();
  await assert.rejects(done);
  assert.ok(!f.workers[0].messages.some((m) => m.type === 'accept'));
});
test('same owner reuses one Worker and stale reply events cannot finish its successor', async (t) => {
  const f = fixture(t),
    first = await f.prepare(1),
    a = first.start(request);
  f.workers[0].emit({ type: 'headers', id: 1, meta });
  await flush();
  f.workers[0].emit({ type: 'end', id: 1 });
  first.eof();
  await a;
  const next = await f.prepare(2);
  assert.equal(f.workers.length, 1);
  const b = next.start(request);
  let ended = false;
  void b.then(() => {
    ended = true;
  });
  f.workers[0].emit({ type: 'end', id: 1 });
  first.eof();
  await flush();
  assert.equal(ended, false);
  f.workers[0].emit({ type: 'headers', id: 2, meta });
  await flush();
  f.workers[0].emit({ type: 'end', id: 2 });
  next.eof();
  await b;
});
test('failure after start terminates uncertain transport with one start and no fallback', async (t) => {
  const f = fixture(t),
    h = await f.prepare(),
    done = h.start(request);
  f.workers[0].onerror();
  await assert.rejects(done);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 1);
  assert.equal(f.workers[0].terminated, true);
});
test('release cancels pending setup and active start, late callback cannot revive owner', async (t) => {
  const f = fixture(t),
    h = await f.prepare(),
    done = h.start(request);
  f.api.release(f.owner);
  await assert.rejects(done);
  f.workers[0].emit({ type: 'end', id: 1 });
  assert.ok(f.workers[0].terminated);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 1);
});

test('unexpected Worker or prepared protocol falls back only before GET', async (t) => {
  for (const options of [{ protocol: 0 }, { preparedProtocol: 2 }]) {
    const f = fixture(t, options);
    assert.equal(await f.prepare(), null);
    assert.ok(f.workers[0].terminated);
    assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 0);
  }
});
test('Worker control EOF cannot resolve before worklet receipt and swallow a following Worker error', async (t) => {
  const f = fixture(t),
    h = await f.prepare(),
    done = h.start(request);
  let outcome = 'pending';
  void done.then(
    () => {
      outcome = 'resolved';
    },
    () => {
      outcome = 'rejected';
    },
  );
  f.workers[0].emit({ type: 'headers', id: 1, meta });
  await flush();
  f.workers[0].emit({ type: 'end', id: 1 });
  await flush();
  assert.equal(
    outcome,
    'pending',
    'Worker control EOF is not proof that direct worklet END was received',
  );
  f.workers[0].onerror();
  await flush();
  assert.equal(outcome, 'rejected');
  assert.ok(f.workers[0].terminated);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 1);
});

test('guarded worklet EOF can precede Worker end and makes later Worker error harmless', async (t) => {
  const f = fixture(t),
    h = await f.prepare(),
    done = h.start(request);
  let outcome = 'pending';
  void done.then(
    () => {
      outcome = 'resolved';
    },
    () => {
      outcome = 'rejected';
    },
  );
  f.workers[0].emit({ type: 'headers', id: 1, meta });
  await flush();
  h.eof();
  await done;
  assert.equal(outcome, 'resolved');
  f.workers[0].onerror();
  await flush();
  assert.equal(outcome, 'resolved');
  assert.ok(f.workers[0].terminated);
  assert.equal(f.workers[0].messages.filter((m) => m.type === 'start').length, 1);
});
