const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROFILE,
  SLO_P99,
  MIX,
  endpoint,
  actionDeck,
  actorsFor,
  identity,
} = require('../scripts/benchmark-mixed92-profile.cjs');
const { assistantCapacity } = require('../scripts/benchmark-mixed92-server.cjs');
const {
  histogram,
  collector,
  notificationCorrectness,
} = require('../scripts/benchmark-mixed92-results.cjs');
const { runSchedule, selectIdleActor } = require('../scripts/benchmark-mixed92-scheduler.cjs');
const { createClient } = require('../scripts/benchmark-mixed92-client.cjs');
const { createModelCassette } = require('../scripts/benchmark-mixed92-providers.cjs');
const { prepare, createPhoto } = require('../scripts/benchmark-mixed92-fixture.cjs');
function fixture() {
  return {
    first: '2030-01-01',
    monthEnd: '2030-01-31',
    cards: 10,
    password: 'Synthetic-only-password',
    organizations: ['org0', 'org1'],
    actors: Array.from({ length: 6 }, (_, n) => ({
      id: 'account' + n,
      org: 'org' + (n % 2),
      ordinal: n,
      index: n % 2,
      role: 'owner',
      patient: 'p-' + (n % 2) + '-' + n,
      cookie: 'cartoteca_v2_session=synthetic' + n,
      email: 'synthetic' + n + '@example.test',
      ics: 'synthetic-ics',
      assistant: n < 2,
      ...(n === 0 ? { photo: '/api/photos/' + 'a'.repeat(32) } : {}),
    })),
  };
}
function api(data, { lost = false, foreign = false } = {}) {
  const calls = [],
    patients = new Map(
      data.actors.map((actor) => [
        actor.patient,
        {
          id: actor.patient,
          notes: '',
          visits: [{ id: 'v' + actor.id, photos: [] }],
          appointments: [{ id: 'a-' + actor.id, staffId: actor.id, notes: '' }],
        },
      ]),
    );
  const receipts = new Map();
  let commits = 0;
  const json = (value, status = 200, headers = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  async function fetchImpl(input, options) {
    const url = new URL(input);
    assert.equal(url.origin, 'http://127.0.0.1:4173');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Origin, 'https://127.0.0.1:4173');
    assert.equal(options.headers['X-Cartoteca-Request'], '1');
    assert.ok(options.headers['X-Cartoteca-Account-Id']);
    assert.ok(options.headers['X-Cartoteca-Organization-Id']);
    calls.push({
      path: url.pathname,
      headers: options.headers,
      body: options.body && JSON.parse(options.body),
    });
    const body = options.body && JSON.parse(options.body);
    if (body)
      assert.equal(Number(options.headers['Content-Length']), Buffer.byteLength(options.body));
    if (url.pathname === '/api/auth/login') {
      const actor = data.actors.find((actor) => actor.email === body.email);
      assert.equal(body.password, data.password);
      return json({ user: { id: actor.id }, organizationId: actor.org }, 200, {
        'Set-Cookie': 'cartoteca_v2_session=new-synthetic-token; HttpOnly',
      });
    }
    if (url.pathname === '/api/cabinet/patient') {
      const patient = patients.get(url.searchParams.get('id'));
      if (
        patient &&
        !patient.id.startsWith('p-' + options.headers['X-Cartoteca-Organization-Id'].slice(3) + '-')
      )
        return json({ error: 'Not found' }, 404);
      return json({ revision: commits + 1, patients: [foreign ? { id: 'p-FOREIGN-0' } : patient] });
    }
    if (url.pathname === '/api/cabinet/directory')
      return json({
        directory: [
          {
            id: foreign
              ? 'p-FOREIGN-0'
              : 'p-' + options.headers['X-Cartoteca-Organization-Id'].slice(3) + '-0',
          },
        ],
      });
    if (url.pathname === '/api/cabinet/calendar')
      return json({ revision: commits, appointments: [], version: 'v', validUntil: 123 });
    if (url.pathname === '/api/cabinet/operation')
      return json(receipts.get(url.searchParams.get('id')) || { status: 'unknown' });
    if (url.pathname === '/api/cabinet/changes') {
      const operation = options.headers['X-Cartoteca-Operation'];
      if (receipts.has(operation)) return json(receipts.get(operation).result);
      const patient = structuredClone(body.patients[0].after);
      require('../src/server/modules/access/cabinet-policy.cjs').authorizeCabinetChange(
        {
          role: data.actors.find((actor) => actor.id === options.headers['X-Cartoteca-Account-Id'])
            .role,
          accountId: options.headers['X-Cartoteca-Account-Id'],
        },
        { patients: [patients.get(patient.id)], services: [] },
        { patients: [patient], services: [] },
      );
      if (patient.visits[0].photos[0])
        patient.visits[0].photos[0].data = '/api/photos/' + 'b'.repeat(32);
      patients.set(patient.id, patient);
      for (const [key, receipt] of receipts)
        if (receipt.result.patients[0].id === patient.id) receipts.delete(key);
      commits++;
      const result = { revision: commits + 1, patients: [patient] };
      receipts.set(operation, { status: 'committed', result });
      if (lost) throw Error('Synthetic response lost after commit');
      return json(result);
    }
    if (url.pathname.startsWith('/api/photos/')) {
      assert.equal(
        url.searchParams.get('accountContext'),
        options.headers['X-Cartoteca-Account-Id'],
      );
      assert.equal(
        url.searchParams.get('organizationContext'),
        options.headers['X-Cartoteca-Organization-Id'],
      );
      return new Response(Buffer.from([255, 216, 255, 217]));
    }
    if (url.pathname === '/api/calendar/feed.ics') {
      if (options.headers['If-None-Match']) return new Response(null, { status: 304 });
      return new Response('BEGIN:VCALENDAR\r\nCLASS:PRIVATE\r\nEND:VCALENDAR\r\n', {
        headers: { ETag: 'W/"fixed"' },
      });
    }
    if (url.pathname === '/api/assistant/scope') return json({ enabled: true, policyVersion: 1 });
    if (url.pathname === '/api/assistant/turn')
      return json({
        text: 'Открываю расписание.',
        policyVersion: 1,
        action: { type: body.text.startsWith('Покажи') ? 'calendar' : 'clients' },
      });
    if (url.pathname === '/api/assistant/speak') {
      assert.equal(body.stream, true);
      assert.ok(body.text);
      return json({
        streamUrl:
          '/api/assistant/speak-audio?ticket=synthetic&accountContext=' +
          options.headers['X-Cartoteca-Account-Id'] +
          '&organizationContext=' +
          options.headers['X-Cartoteca-Organization-Id'],
      });
    }
    if (url.pathname === '/api/assistant/speak-audio')
      return new Response(Buffer.from([255, 251, 144, 100]));
    throw Error('Unexpected synthetic request');
  }
  return { fetchImpl, calls, commits: () => commits };
}

test('mixed92 fixed deck covers exact weights and isolates targets from public URLs, redirects and protected ports', () => {
  const counts = {};
  for (const name of actionDeck()) counts[name] = (counts[name] || 0) + 1;
  assert.deepEqual(counts, MIX);
  assert.equal(PROFILE.active / (PROFILE.thinkMs / 1000), 600);
  assert.deepEqual(actionDeck(), actionDeck());
  assert.notDeepEqual(actionDeck(), actionDeck(99));
  assert.equal(endpoint('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  for (const value of [
    'https://example.invalid/',
    'http://127.0.0.1:4186',
    'http://localhost:4173',
    'http://10.234.12.20:4173',
    'http://127.0.0.1:4173/path',
    'http://a:b@127.0.0.1:4173',
  ])
    assert.throws(() => endpoint(value));
  assert.equal(Object.keys(identity().files).length, 12);
});

test('active cohort retains existing voice pilot and rotates ordinary accounts without claiming all accounts active', () => {
  const data = fixture(),
    a = actorsFor(data, 4, 0),
    b = actorsFor(data, 4, 1);
  assert.equal(a.length, 4);
  assert.equal(new Set(a.map((actor) => actor.id)).size, 4);
  assert.deepEqual(
    a.filter((actor) => actor.assistant),
    b.filter((actor) => actor.assistant),
  );
  assert.notDeepEqual(a.slice(2), b.slice(2));
  assert.throws(() => actorsFor(data, 7));
});

test('bounded percentile summaries keep drops separate from completed requests and count tail failures', () => {
  const values = histogram();
  [1, 2, 3, 100].forEach((ms) => values.add(ms));
  assert.equal(values.snapshot().p95Ms, 100);
  assert.equal(values.snapshot().p50Ms, 2);
  const results = collector();
  results.record('card', { ms: 20, lagMs: 30 });
  results.record('card', { dropped: true, lagMs: 200 });
  results.record('card', { status: 503, ms: 100 });
  const row = results.snapshot().card;
  assert.equal(row.attempted, 3);
  assert.equal(row.completed, 2);
  assert.equal(row.drops, 1);
  assert.equal(row.errors, 1);
  assert.equal(row.withinProposedSlo, false);
});

test('open-loop scheduler offers600actions/s without legacy200cap and records saturation instead of silent waiting', async () => {
  let clock = 0;
  const data = fixture();
  const result = await runSchedule({
    actors: data.actors,
    seconds: 1,
    rate: 600,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    action: async () => {
      clock += 2;
    },
  });
  assert.equal(result.offeredActions, 600);
  assert.equal(result.requestedActionRate, 600);
  assert.equal(
    Object.values(result.classes).reduce((sum, row) => sum + row.attempted, 0),
    600,
  );
  assert.ok(Object.values(result.classes).some((row) => row.drops > 0));
  assert.ok(result.peakInFlight <= 6);
});

test('client exercises real route contracts, explicit auth contexts, upload and read, ICS304 and both initial voice paths', async () => {
  const data = fixture(),
    transport = api(data),
    actor = data.actors[0];
  const jpeg = Buffer.alloc(PROFILE.photoBytesMin);
  jpeg[0] = 255;
  jpeg[1] = 216;
  const client = createClient(data, {
    base: 'http://127.0.0.1:4173',
    fetchImpl: transport.fetchImpl,
    jpeg,
  });
  for (const name of [
    'calendar',
    'search',
    'card',
    'save',
    'photo-upload',
    'photo-read',
    'ics',
    'ics',
    'assistant',
    'assistant',
    'auth',
  ])
    await client.action(name, actor, 1);
  const snapshot = client.snapshot();
  assert.equal(snapshot.ics.statuses[304], 1);
  assert.equal(snapshot['assistant-local'].completed, 1);
  assert.equal(snapshot['assistant-model'].completed, 1);
  assert.equal(snapshot['assistant-tts'].completed, 2);
  assert.equal(snapshot['assistant-audio'].completed, 2);
  assert.equal(snapshot['photo-upload'].completed, 1);
  assert.equal(actor.cookie, 'cartoteca_v2_session=new-synthetic-token');
  const correctness = await client.reconcile();
  assert.equal(correctness.committed, 2);
  assert.equal(correctness.mismatched, 0);
  assert.equal(correctness.unknown, 0);
  assert.equal(correctness.tenantIsolation, 1);
});

test('lost post-commit response is reconciled by the same receipt and blocks a second unknown mutation', async () => {
  const data = fixture(),
    transport = api(data, { lost: true });
  const client = createClient(data, {
    base: 'http://127.0.0.1:4173',
    fetchImpl: transport.fetchImpl,
  });
  await assert.rejects(client.action('save', data.actors[0], 1), /response lost/);
  await assert.rejects(client.action('save', data.actors[0], 2), /unknown outcome/);
  const result = await client.reconcile();
  assert.equal(result.committed, 1);
  assert.equal(result.unknown, 0);
  assert.equal(result.attempted, 1);
  assert.equal(transport.commits(), 1);
});

test('every20th save replays its original UUID without a duplicate commit', async () => {
  const data = fixture(),
    transport = api(data);
  const client = createClient(data, {
    base: 'http://127.0.0.1:4173',
    fetchImpl: transport.fetchImpl,
  });
  for (let n = 0; n < 20; n++) await client.action('save', data.actors[0], n);
  const result = await client.reconcile();
  assert.equal(result.committed, 20);
  assert.equal(result.replayed, 1);
  assert.equal(transport.commits(), 20);
});

test('foreign rows cause a correctness failure, even if the server returned HTTP200', async () => {
  const data = fixture(),
    transport = api(data, { foreign: true });
  const client = createClient(data, {
    base: 'http://127.0.0.1:4173',
    fetchImpl: transport.fetchImpl,
  });
  await assert.rejects(client.action('search', data.actors[0], 1), /Foreign/);
  assert.equal(client.snapshot().search.statuses.validation, 1);
});

test('slow model cassette has no outbound transport and honors cancellation', async () => {
  let delay;
  const cassette = createModelCassette({
    sleep: async (ms) => {
      delay = ms;
    },
  });
  const response = await cassette.fetch('https://api.timeweb.ai/v1/chat/completions', {
    method: 'POST',
    redirect: 'error',
  });
  assert.equal(delay, 3000);
  assert.equal((await response.json()).choices[0].finish_reason, 'stop');
  assert.equal(cassette.snapshot().realCalls, 0);
  assert.equal(cassette.snapshot().calls, 1);
  await assert.rejects(
    cassette.fetch('https://example.invalid/', { method: 'POST', redirect: 'error' }),
  );
  const aborted = createModelCassette({
    sleep: async () => {
      throw Object.assign(Error('Synthetic abort'), { name: 'AbortError' });
    },
  });
  await assert.rejects(
    aborted.fetch('https://api.timeweb.ai/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
    }),
    /abort/,
  );
  assert.equal(aborted.snapshot().active, 0);
  assert.equal(aborted.snapshot().aborted, 1);
});

test('fixture preparation rejects live and unmarked paths before opening SQLite or generating photographs', async () => {
  await assert.rejects(prepare({ root: '.', directory: '/app/runtime', first: '2030-01-01' }));
  await assert.rejects(prepare({ root: '/app', directory: '/tmp/other', first: '2030-01-01' }));
  await assert.rejects(prepare({ root: '/app', organizations: 10001, first: '2030-01-01' }));
});

test('synthetic upload is a reproducible real JPEG in the fixed256–512KiB envelope', async () => {
  const sharp = require('sharp');
  const first = await createPhoto(sharp),
    second = await createPhoto(sharp);
  assert.deepEqual(first, second);
  assert.ok(first.length >= PROFILE.photoBytesMin && first.length <= PROFILE.photoBytesMax);
  const metadata = await sharp(first).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 768);
  assert.equal(metadata.height, 768);
});

test('notification acceptance requires actual acknowledgements on every channel and rejects silent or uncertain sends', () => {
  const channel = {
    attempts: 1,
    acknowledged: 1,
    failures: 0,
    aborted: 0,
    duplicates: 0,
    unknownRecipients: 0,
  };
  const snapshot = {
    inFlight: 0,
    counters: { telegram: { ...channel }, max: { ...channel }, push: { ...channel } },
  };
  assert.equal(notificationCorrectness(snapshot), true);
  assert.equal(notificationCorrectness(null), false);
  for (const field of ['failures', 'aborted', 'duplicates', 'unknownRecipients']) {
    const wrong = structuredClone(snapshot);
    wrong.counters.push[field] = 1;
    assert.equal(notificationCorrectness(wrong), false);
  }
  const silent = structuredClone(snapshot);
  silent.counters.telegram.acknowledged = 0;
  assert.equal(notificationCorrectness(silent), false);
  assert.equal(notificationCorrectness({ ...snapshot, inFlight: 1 }), false);
});

test('a good p95 cannot hide a failing p99 latency tail for any target action class', () => {
  for (const [name, p99] of Object.entries(SLO_P99)) {
    const results = collector();
    for (let n = 0; n < 98; n++) results.record(name, { ms: 20 });
    results.record(name, { ms: p99 + 1 });
    results.record(name, { ms: p99 + 1 });
    const row = results.snapshot()[name];
    assert.equal(row.scheduledLatency.p95Ms, 20);
    assert.equal(row.scheduledLatency.p99Ms, p99 + 1);
    assert.equal(row.proposedP99Ms, p99);
    assert.equal(row.withinProposedSlo, false, name + ' must reject its failing tail');
  }
});

test('explicit test dialogue capacity reports observed semantics instead of pretending older runtimes honor it', () => {
  assert.equal(PROFILE.assistantDialogueCapacity, 500);
  const supported = assistantCapacity({
    commands: { capacity: 500 },
    dialogues: { capacity: 500 },
  });
  assert.equal(supported.requested, 500);
  assert.equal(supported.observed, 500);
  assert.equal(supported.matchesRequested, true);
  const old = assistantCapacity({ dialogues: { capacity: 100 } });
  assert.equal(old.observed, 100);
  assert.equal(old.matchesRequested, false);
  assert.match(old.compatibilitySemantics, /semantics differ/);
  assert.equal(assistantCapacity(undefined).supported, false);
  assert.equal(assistantCapacity(undefined).observed, null);
});

test('idle selection stays in its exact eligible pool and bounds scans instead of dropping a collision with free actors', () => {
  const pool = [{ id: 'voice-a' }, { id: 'voice-b' }, { id: 'voice-c' }];
  const choice = selectIdleActor(pool, 0, new Set(['voice-a', 'not-eligible']));
  assert.equal(choice.actor.id, 'voice-b');
  assert.equal(choice.reassigned, true);
  assert.equal(choice.scanned, 2);
  const blocked = selectIdleActor(pool, 1, new Set(pool.map((actor) => actor.id)));
  assert.equal(blocked.actor, null);
  assert.equal(blocked.scanned, pool.length);
});
