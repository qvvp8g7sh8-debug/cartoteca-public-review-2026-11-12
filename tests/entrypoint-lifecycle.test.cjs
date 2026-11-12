const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEntrypointLifecycle } = require('../src/server/application/entrypoint-lifecycle.cjs');

// No network, subprocess, real credentials or databases: synthetic process,
// server and timers exercise the actual launcher source and lifecycle helper.
function fixture({ hangs = false, throws = false } = {}) {
  const runtime = new EventEmitter(),
    server = new EventEmitter(),
    exits = [],
    messages = [],
    timers = new Map();
  let nextTimer = 0,
    closes = 0,
    starts = 0,
    listens = 0;
  runtime.env = {};
  runtime.exit = (code) => exits.push(code);
  runtime.send = (message) => messages.push(message);
  server.close = (callback) => {
    closes++;
    if (throws) throw Error('Synthetic close failure');
    if (hangs) return;
    server.emit('close');
    callback?.();
  };
  server.listen = (port, host, callback) => {
    listens++;
    callback();
  };
  server.address = () => ({ port: 4174 });
  server.startBackground = () => {
    starts++;
  };
  const dependencies = {
    process: runtime,
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    runtime,
    server,
    exits,
    messages,
    timers,
    dependencies,
    counts: () => ({ closes, starts, listens }),
  };
}

test('background failure closes once and exits nonzero; later manual stop cannot hide it', () => {
  const f = fixture(),
    lifecycle = createEntrypointLifecycle(f.dependencies);
  lifecycle.attach(f.server);
  f.server.emit('backgroundError', Error('Synthetic lost lease'));
  f.runtime.emit('SIGTERM');
  assert.equal(f.counts().closes, 1);
  assert.equal(f.runtime.exitCode, 1);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.timers.size, 0);
});

test('manual SIGINT, SIGTERM and IPC stop stay successful even if a late failure arrives', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'stop']) {
    const f = fixture({ hangs: true }),
      lifecycle = createEntrypointLifecycle(f.dependencies);
    lifecycle.attach(f.server);
    if (signal === 'stop') f.runtime.emit('message', 'stop');
    else f.runtime.emit(signal);
    f.server.emit('backgroundError', Error('Synthetic late failure'));
    assert.equal(f.counts().closes, 1);
    assert.equal(f.runtime.exitCode, 0);
    f.server.emit('close');
    assert.deepEqual(f.exits, [0]);
    assert.equal(f.timers.size, 0);
  }
});

test('hung or throwing close has a bounded nonzero exit without restarting in place', () => {
  const f = fixture({ hangs: true }),
    lifecycle = createEntrypointLifecycle(f.dependencies);
  lifecycle.attach(f.server);
  f.server.emit('backgroundError', Error('Synthetic lost lease'));
  assert.deepEqual(f.exits, []);
  const [deadline] = f.timers.values();
  assert.equal(deadline.ms, 5000);
  deadline.callback();
  f.server.emit('close');
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.counts().starts, 0);
  const throwing = fixture({ throws: true });
  createEntrypointLifecycle(throwing.dependencies).attach(throwing.server);
  throwing.server.emit('backgroundError', Error('Synthetic lost lease'));
  assert.deepEqual(throwing.exits, [1]);
});

test('stop during asynchronous startup cannot leave a late server running', () => {
  const f = fixture(),
    lifecycle = createEntrypointLifecycle(f.dependencies);
  f.runtime.emit('message', 'stop');
  assert.deepEqual(f.exits, [0]);
  assert.equal(lifecycle.attach(f.server), false);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.counts().listens, 0);
});

async function launch(file, options = {}) {
  const f = fixture(options),
    module = { exports: {} },
    config = {
      processRole: file.includes('background') ? 'background' : 'combined',
      port: 4174,
      host: '127.0.0.1',
      storageBackend: options.storageBackend || 'sqlite',
    },
    intervals = new Set();
  let postgresInitializations = 0,
    ownerCloses = 0,
    backgroundStops = 0,
    fatalCallback;
  f.server.stopBackground = () => {
    backgroundStops++;
  };
  const load = (id) => {
    if (id === 'node:cluster') return { isPrimary: false };
    if (id.endsWith('/config.cjs')) return { configuration: () => config };
    if (id.endsWith('/server.cjs')) return { createMultiServer: () => f.server };
    if (id.endsWith('/entrypoint-lifecycle.cjs'))
      return { createEntrypointLifecycle: () => createEntrypointLifecycle(f.dependencies) };
    if (id.endsWith('/max-startup.cjs'))
      return {
        createConfiguredMultiServer: async () => {
          if (options.fatalAtStartup) fatalCallback();
          return f.server;
        },
      };
    // Keep the SQLite Unexpected dependency guard: only an explicit PG fixture
    // may provide this dependency, just as only the PG runtime should load it.
    if (options.storageBackend === 'postgres' && id.endsWith('/postgres/initialize.cjs'))
      return {
        initializePostgresOwner: async (value, { onFatal }) => {
          postgresInitializations++;
          fatalCallback = onFatal;
          return {
            ...value,
            databaseOwner: {
              close: async () => {
                ownerCloses++;
              },
            },
          };
        },
      };
    throw Error('Unexpected dependency ' + id);
  };
  load.main = module;
  const context = {
    require: load,
    module,
    process: f.runtime,
    console: { log() {}, error() {} },
    setInterval(callback) {
      intervals.add(callback);
      return callback;
    },
    clearInterval(callback) {
      intervals.delete(callback);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {
    filename: file,
  });
  await new Promise(setImmediate);
  return {
    ...f,
    intervals,
    postgresCounts: () => ({
      initializations: postgresInitializations,
      ownerCloses,
      backgroundStops,
    }),
    failPostgres: () => fatalCallback(),
  };
}

for (const file of [
  'multi-server.cjs',
  'scripts/start-workers.cjs',
  'scripts/start-background.cjs',
]) {
  test(file + ' wires lease failure to graceful nonzero shutdown', async () => {
    const f = await launch(file);
    assert.equal(f.exits.length, 0);
    f.server.emit('backgroundError', Error('Synthetic lost lease'));
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.counts().closes, 1);
    assert.equal(f.intervals.size, 0);
  });

  test(file + ' keeps normal stop successful and bounds hung failure shutdown', async () => {
    const normal = await launch(file);
    normal.runtime.emit('message', 'stop');
    assert.deepEqual(normal.exits, [0]);
    const hung = await launch(file, { hangs: true });
    hung.server.emit('backgroundError', Error('Synthetic lost lease'));
    const [deadline] = hung.timers.values();
    assert.equal(deadline.ms, 5000);
    deadline.callback();
    assert.deepEqual(hung.exits, [1]);
    assert.equal(hung.counts().starts, file.includes('background') ? 1 : 0);
  });
}

test('unconfirmed native executor shutdown cannot report a successful manual stop', () => {
  const f = fixture({ hangs: true });
  createEntrypointLifecycle(f.dependencies).attach(f.server);
  f.runtime.emit('SIGTERM');
  assert.equal(f.runtime.exitCode, 0);
  f.server.emit(
    'backgroundError',
    Object.assign(Error('Synthetic executor still alive'), {
      code: 'NATIVE_SHUTDOWN_FAILED',
    }),
  );
  assert.equal(f.runtime.exitCode, 1);
  assert.equal(f.counts().closes, 1);
  f.server.emit('close');
  assert.deepEqual(f.exits, [1]);
});

test('standalone PostgreSQL background owner failure stops delivery and reaches bounded nonzero lifecycle once', async () => {
  const f = await launch('scripts/start-background.cjs', {
    storageBackend: 'postgres',
    hangs: true,
  });
  assert.equal(f.postgresCounts().initializations, 1);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.messages.length, 1);
  const errors = [];
  f.server.on('backgroundError', (error) =>
    errors.push({ code: error.code, message: error.message }),
  );
  f.failPostgres();
  f.failPostgres();
  assert.equal(f.postgresCounts().backgroundStops, 1);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.runtime.exitCode, 1);
  assert.deepEqual(f.exits, []);
  assert.deepEqual(errors, [
    { code: 'POSTGRES_EXECUTOR_FAILED', message: 'Хранилище временно недоступно.' },
  ]);
  const [deadline] = f.timers.values();
  assert.equal(deadline.ms, 5000);
  deadline.callback();
  f.server.emit('close');
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.intervals.size, 0);
});

test('PostgreSQL owner failure during asynchronous background construction never starts jobs or reports readiness', async () => {
  const f = await launch('scripts/start-background.cjs', {
    storageBackend: 'postgres',
    fatalAtStartup: true,
  });
  assert.equal(f.postgresCounts().initializations, 1);
  assert.equal(f.postgresCounts().ownerCloses, 1);
  assert.equal(f.counts().starts, 0);
  assert.equal(f.counts().closes, 1);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.intervals.size, 0);
});

test('a late PostgreSQL owner failure does not turn a completed manual background stop into failure', async () => {
  const f = await launch('scripts/start-background.cjs', { storageBackend: 'postgres' });
  f.runtime.emit('SIGTERM');
  f.failPostgres();
  assert.equal(f.counts().closes, 1);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.runtime.exitCode, 0);
  assert.equal(f.intervals.size, 0);
});
