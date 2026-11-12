const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureFailure,
  failureDetails,
  createFailureSummary,
} = require('../scripts/benchmark-organizations-diagnostics.cjs');
const { createClient } = require('../scripts/benchmark-organizations-client.cjs');
const { runSchedule } = require('../scripts/benchmark-organizations-scheduler.cjs');
const { routeResults, buildResult } = require('../scripts/benchmark-organizations-results.cjs');

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  org: '00000000-0000-4000-8000-000000000002',
  index: 0,
  role: 'owner',
  cookie: 'private-cookie-never-report',
  patient: 'p-0-0',
  service: 'service-0',
  provider: 'provider-0',
};
const fixture = {
  version: 2,
  schema: 17,
  first: '2030-02-07',
  cards: 200,
  visits: 10,
  organizations: [user.org],
  actors: [user],
};
const patient = () => ({ id: user.patient, appointments: [{ notes: 'Before' }] });
const response = (value) => ({
  status: 200,
  async json() {
    return structuredClone(value);
  },
});
const read = () => response({ revision: 1, patients: [patient()] });
const rejected = async (promise) => {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'Expected the synthetic operation to fail');
  return error;
};
async function oneAction(action) {
  let time = 0;
  return runSchedule({
    mode: 'fixed',
    actors: [user],
    seconds: 3,
    concurrent: 1,
    now: () => time,
    async action() {
      try {
        await action();
      } finally {
        time = 3000;
      }
    },
  });
}

test('diagnostic classification never reads messages and redacts non-allowlisted fields', () => {
  const error = {
    name: 'TypeError',
    code: 'UND_ERR_SOCKET',
    cause: { code: 'ECONNRESET', secret: user.cookie },
    get message() {
      assert.fail('Diagnostic must not inspect message');
    },
    stack: user.cookie,
    url: 'https://example.invalid/?patient=private',
  };
  const detail = captureFailure(error, { route: 'card', stage: 'fetch', httpStatus: null });
  assert.deepEqual(detail, {
    route: 'card',
    stage: 'fetch',
    name: 'TypeError',
    code: 'UND_ERR_SOCKET',
    causeCode: 'ECONNRESET',
    httpStatus: null,
  });
  assert.deepEqual(failureDetails(error, { stage: 'action' }), detail);
  const unsafe = captureFailure(
    { name: user.cookie, code: user.cookie, cause: { code: user.cookie } },
    {
      route: user.cookie,
      stage: user.cookie,
      httpStatus: user.cookie,
    },
  );
  assert.deepEqual(unsafe, {
    route: 'other',
    stage: 'action',
    name: 'OtherError',
    code: 'other',
    causeCode: 'other',
    httpStatus: null,
  });
  assert.doesNotMatch(JSON.stringify([detail, unsafe]), /private|cookie|patient=/);
  assert.doesNotThrow(() =>
    captureFailure({
      get cause() {
        throw Error(user.cookie);
      },
    }),
  );
});

test('error aggregation bounds cardinality, accounts for overflow, and returns detached snapshots', () => {
  const summary = createFailureSummary(2);
  for (const stage of ['fetch', 'response-decode', 'response-assertion', 'http-status'])
    summary.add(Error(user.cookie), { stage, route: 'card' });
  summary.add(Error(user.cookie), { stage: 'fetch', route: 'card' });
  const first = summary.snapshot();
  assert.equal(first.total, 5);
  assert.equal(first.groups.length, 2);
  assert.equal(first.otherCount, 2);
  assert.equal(first.groups.reduce((sum, group) => sum + group.count, 0) + first.otherCount, 5);
  first.groups[0].count = 1000;
  assert.equal(summary.snapshot().groups[0].count, 2);
  assert.throws(() => createFailureSummary(0));
});

for (const [stage, failure, fetchImpl, httpStatus] of [
  [
    'fetch',
    Object.assign(new TypeError('private fetch URL'), {
      cause: { code: 'ECONNRESET' },
      status: 403,
    }),
    null,
    null,
  ],
  [
    'fetch',
    Object.assign(Error('private timeout'), { name: 'TimeoutError', cause: { code: 'ETIMEDOUT' } }),
    null,
    null,
  ],
  [
    'response-decode',
    Object.assign(new TypeError('private body'), { cause: { code: 'UND_ERR_SOCKET' } }),
    null,
    200,
  ],
  ['response-decode', new SyntaxError('private body'), null, 200],
]) {
  test(
    stage + ' preserves safe error details and the actually received HTTP status: ' + failure.name,
    async () => {
      const client = createClient(fixture, 'diagnostic', {
        fetchImpl:
          fetchImpl ||
          (async () => {
            if (stage === 'fetch') throw failure;
            return {
              status: 200,
              async json() {
                throw failure;
              },
            };
          }),
      });
      await rejected(client.action('card', user, 0, 1));
      const sample = client.samples[0],
        route = routeResults(client.samples).card;
      assert.equal(sample.failure.stage, stage);
      assert.equal(sample.failure.name, failure.name);
      assert.equal(sample.failure.httpStatus, httpStatus);
      assert.equal(sample.failure.causeCode, failure.cause?.code || null);
      assert.equal(route.httpStatuses[httpStatus ?? 'none'], 1);
      assert.equal(route.errorDiagnostics.total, 1);
      assert.equal(route.p95Ms, null);
      assert.equal(
        sample.status,
        failure.name === 'TimeoutError' ? 'timeout' : 'network-or-validation',
      );
      assert.doesNotMatch(JSON.stringify(route), /private/);
    },
  );
}

test('response assertion is distinct from transport even when the server returned 200', async () => {
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async () => response({ patients: [{ id: 'foreign-private-value' }] }),
  });
  await rejected(client.action('card', user, 0, 1));
  const route = routeResults(client.samples).card;
  assert.deepEqual(route.httpStatuses, { 200: 1 });
  assert.equal(route.statuses['network-or-validation'], 1);
  assert.equal(route.errorDiagnostics.groups[0].stage, 'response-assertion');
  assert.equal(route.errorDiagnostics.groups[0].code, 'ERR_ASSERTION');
  assert.doesNotMatch(JSON.stringify(route), /foreign-private-value/);
});

test('request preparation failure never becomes a fetch failure or sends a cyclic payload', async () => {
  const body = {};
  body.self = body;
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async () => assert.fail('Must not send'),
  });
  await rejected(client.request(user, 0, 'save', '/private?secret=' + user.cookie, body));
  assert.equal(client.samples[0].failure.stage, 'request-prepare');
  assert.equal(client.samples[0].failure.httpStatus, null);
  assert.doesNotMatch(JSON.stringify(client.samples), /private|cookie|secret=/);
});

for (const cleanupFails of [false, true]) {
  test(
    'non-200 response retains HTTP 500 when body cleanup ' + (cleanupFails ? 'fails' : 'succeeds'),
    async () => {
      const client = createClient(fixture, 'diagnostic', {
        fetchImpl: async () => ({
          status: 500,
          body: {
            async cancel() {
              if (cleanupFails)
                throw Object.assign(new TypeError('private body'), {
                  cause: { code: 'UND_ERR_SOCKET' },
                });
            },
          },
        }),
      });
      const schedule = await oneAction(() => client.action('card', user, 0, 1));
      assert.deepEqual(schedule.failures, ['HTTP 500']);
      const route = routeResults(client.samples).card;
      assert.deepEqual(route.statuses, { 500: 1 });
      assert.deepEqual(route.httpStatuses, { 500: 1 });
      assert.equal(
        route.errorDiagnostics.groups[0].stage,
        cleanupFails ? 'response-release' : 'http-status',
      );
      assert.equal(schedule.failureDiagnostics.groups[0].route, 'card');
      assert.equal(schedule.failureDiagnostics.groups[0].httpStatus, 500);
    },
  );
}

test('invalid save acknowledgement is not successful throughput and remains unknown without mutation retries', async () => {
  let writes = 0;
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async (url, options) => {
      if (options.method === 'PATCH') {
        writes++;
        return response({ patients: [patient()] });
      }
      return url.includes('/operation?') ? response({ status: 'unknown' }) : read();
    },
  });
  await rejected(client.action('save', user, 0, 1));
  const save = routeResults(client.samples).save;
  assert.deepEqual(save.httpStatuses, { 200: 1 });
  assert.equal(save.p95Ms, null);
  assert.equal(save.errorDiagnostics.groups[0].stage, 'response-assertion');
  const guard = await rejected(client.action('save', user, 0, 2));
  assert.equal(failureDetails(guard).stage, 'unknown-write-guard');
  const result = await client.reconcile();
  assert.equal(writes, 1);
  assert.equal(result.acknowledged, 0);
  assert.equal(result.unresolvedWrites, 1);
});

test('action preparation diagnostics remain separate from successful preceding reads', async () => {
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async () => response({ patients: [{ id: user.patient }] }),
  });
  const schedule = await oneAction(() => client.action('save', user, 0, 1));
  const report = buildResult({
    label: 'diagnostic',
    mode: 'fixed',
    seconds: 3,
    fixture,
    client,
    schedule,
    workers: [],
    generatorCpu: { user: 0, system: 0 },
  });
  assert.equal(report.requests, 1);
  assert.equal(report.routes.card.statuses[200], 1);
  assert.equal(report.errorDiagnostics.requests.total, 0);
  assert.equal(report.errorDiagnostics.actions.total, 1);
  assert.equal(report.errorDiagnostics.actions.groups[0].stage, 'action-prepare');
  assert.equal(report.failureKinds.TypeError, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-cookie|p-0-0|provider-0/);
});

test('result roundtrip retains request and action stages without duplicating failure counts', async () => {
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async () => {
      throw Object.assign(new TypeError('private payload'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  const schedule = await oneAction(() => client.action('card', user, 0, 1));
  const report = JSON.parse(
    JSON.stringify(
      buildResult({
        label: 'diagnostic',
        mode: 'fixed',
        seconds: 3,
        fixture,
        client,
        schedule,
        workers: [],
        generatorCpu: { user: 0, system: 0 },
      }),
    ),
  );
  assert.equal(report.failures, 1);
  assert.equal(report.errorDiagnostics.requests.total, 1);
  assert.equal(report.errorDiagnostics.actions.total, 1);
  assert.deepEqual(report.errorDiagnostics.requests.groups, report.errorDiagnostics.actions.groups);
  assert.equal(report.errorDiagnostics.actions.groups[0].causeCode, 'ECONNREFUSED');
  assert.equal(report.routes.card.httpStatuses.none, 1);
  assert.doesNotMatch(JSON.stringify(report), /private payload|private-cookie/);
});

test('reconciliation errors are preserved separately and do not enter measured request totals', async () => {
  let verifying = false;
  const client = createClient(fixture, 'diagnostic', {
    fetchImpl: async (url, options) => {
      if (options.method === 'PATCH') {
        verifying = true;
        throw Object.assign(Error(user.cookie), { name: 'TimeoutError' });
      }
      if (!verifying) return read();
      return { status: url.includes('/operation?') ? 404 : 500, body: { async cancel() {} } };
    },
  });
  await rejected(client.action('save', user, 0, 1));
  const count = client.samples.length,
    result = await client.reconcile();
  assert.equal(client.samples.length, count);
  assert.equal(result.unresolvedWrites, 1);
  assert.equal(result.verificationErrors, 1);
  assert.equal(result.errorDiagnostics.total, 3);
  assert.equal(result.errorDiagnostics.groups.find((row) => row.route === 'receipt').count, 2);
  assert.equal(
    result.errorDiagnostics.groups.find((row) => row.route === 'verify').httpStatus,
    500,
  );
  assert.doesNotMatch(JSON.stringify(result), /private-cookie/);
});

test('custom error names cannot leak through legacy failureKinds', async () => {
  const schedule = await oneAction(async () => {
    throw { name: user.cookie, code: user.cookie, status: user.cookie };
  });
  assert.deepEqual(schedule.failures, ['OtherError']);
  assert.doesNotMatch(JSON.stringify(schedule), /private-cookie/);
});
