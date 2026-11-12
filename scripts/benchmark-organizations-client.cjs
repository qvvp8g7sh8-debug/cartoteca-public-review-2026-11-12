const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { dateRange, loadProfile } = require('./benchmark-organizations-profile.cjs');
const {
  captureFailure,
  failureDetails,
  createFailureSummary,
} = require('./benchmark-organizations-diagnostics.cjs');
const BASE = 'http://10.234.12.2:4173';
function createClient(
  fixture,
  label,
  { fetchImpl = fetch, now = () => performance.now(), origin = loadProfile().origin } = {},
) {
  assert.ok([BASE, BASE.replace('http:', 'https:')].includes(origin), 'Synthetic origin only');
  const samples = [],
    writes = new Map(),
    accounts = new Set(),
    organizations = new Set();
  const counters = { attempted: 0, acknowledged: 0, rejected: 0, blockedAfterUnknown: 0 };
  let inFlight = 0,
    peak = 0,
    measuring = true;
  async function request(user, vu, name, route, body, method, operationId, assertResponse) {
    const start = now();
    let status = 'network-or-validation',
      httpStatus = null,
      stage = 'request-prepare',
      failure = null;
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      const options = {
        method: method || (body ? 'PATCH' : 'GET'),
        headers: {
          ...(name.startsWith('public') ? {} : { Cookie: user.cookie }),
          Origin: origin,
          'X-Cartoteca-Request': '1',
          'Content-Type': 'application/json',
          'X-Cartoteca-Client-IP': `10.64.${Math.floor(vu / 250) % 250}.${1 + (vu % 250)}`,
          ...(operationId ? { 'X-Cartoteca-Operation': operationId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      };
      stage = 'fetch';
      const response = await fetchImpl(BASE + route, options);
      stage = 'response-status';
      const receivedStatus = response.status;
      assert.ok(Number.isInteger(receivedStatus) && receivedStatus >= 100 && receivedStatus <= 599);
      httpStatus = receivedStatus;
      if (httpStatus !== 200) {
        status = httpStatus;
        stage = 'response-release';
        await response.body?.cancel();
        stage = 'http-status';
        throw Object.assign(Error(name + ' HTTP ' + httpStatus), { status: httpStatus });
      }
      stage = 'response-decode';
      const data = await response.json();
      stage = 'response-assertion';
      if (data.directory)
        assert.ok(
          data.directory.every((p) => p.id.startsWith('p-' + user.index + '-')),
          'Foreign tenant row',
        );
      if (name === 'card' || name === 'verify') assert.equal(data.patients?.[0]?.id, user.patient);
      if (name === 'public-info') {
        assert.equal(data.health?.available, true, 'Fixture is not publicly bookable');
        assert.ok(
          data.services?.some((service) => service.id === user.service),
          'Fixture service is not public',
        );
      }
      if (name === 'public-dates')
        assert.ok(data.dates?.includes(fixture.first), 'Fixture working date is not public');
      if (name === 'public-availability')
        assert.ok(data.slots?.length > 0, 'Fixture has no available slots');
      if (assertResponse) assertResponse(data);
      status = 200;
      return data;
    } catch (error) {
      failure = captureFailure(error, { route: name, stage, httpStatus });
      if (!['http-status', 'response-release'].includes(stage))
        status = failure.name === 'TimeoutError' ? 'timeout' : 'network-or-validation';
      throw error;
    } finally {
      if (measuring) samples.push({ name, status, httpStatus, ms: now() - start, failure });
      inFlight--;
    }
  }
  async function executeAction(name, user, vu, sequence) {
    accounts.add(user.id);
    organizations.add(user.org);
    if (name === 'search')
      return request(
        user,
        vu,
        name,
        '/api/cabinet/directory?limit=20&sort=first&q=Client' + (sequence % fixture.cards),
      );
    if (name === 'calendar')
      return request(
        user,
        vu,
        name,
        '/api/cabinet/calendar?from=' + fixture.first + '&to=' + dateRange(fixture.first).monthEnd,
      );
    if (name === 'public-info')
      return request(user, vu, name, '/api/public-booking/info?organization=' + user.org);
    if (name === 'public-dates')
      return request(
        user,
        vu,
        name,
        '/api/public-booking/dates?organization=' +
          user.org +
          '&month=' +
          fixture.first.slice(0, 7) +
          '&staffId=' +
          user.provider,
      );
    if (name === 'public-availability')
      return request(
        user,
        vu,
        name,
        '/api/public-booking/availability?organization=' + user.org,
        { date: fixture.first, serviceIds: [user.service], staffId: user.provider },
        'POST',
      );
    assert.ok(name === 'card' || name === 'save');
    if (name === 'save' && writes.get(user.id)?.state === 'unknown') {
      counters.blockedAfterUnknown++;
      const error = Object.assign(Error('Unresolved previous write'), { name: 'UnresolvedWrite' });
      captureFailure(error, { route: name, stage: 'unknown-write-guard' });
      throw error;
    }
    const data = await request(user, vu, 'card', '/api/cabinet/patient?id=' + user.patient);
    if (name === 'card') return data;
    const before = data.patients[0],
      after = structuredClone(before);
    const note = 'Synthetic ' + label + ' ' + sequence,
      operationId = randomUUID();
    after.appointments[0].notes = note;
    const write = { user, vu, note, operationId, state: 'unknown' };
    const previous = writes.get(user.id);
    // Preserve the operation identity across a lost response; never retry this mutation blindly.
    writes.set(user.id, write);
    counters.attempted++;
    try {
      await request(
        user,
        vu,
        'save',
        '/api/cabinet/changes',
        {
          revision: data.revision,
          patients: [{ id: user.patient, before, after }],
          services: [],
        },
        'PATCH',
        operationId,
        (saved) => assert.equal(saved.patients?.[0]?.appointments?.[0]?.notes, note),
      );
      write.state = 'acknowledged';
      counters.acknowledged++;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        counters.rejected++;
        if (previous) writes.set(user.id, previous);
        else writes.delete(user.id);
      }
      throw error;
    }
  }
  async function action(name, ...args) {
    try {
      return await executeAction(name, ...args);
    } catch (error) {
      failureDetails(error, { route: name, stage: 'action-prepare' });
      throw error;
    }
  }
  async function reconcile() {
    measuring = false;
    const diagnostics = createFailureSummary();
    const result = {
      ...counters,
      savedRecordsVerified: 0,
      unknownWritesResolved: 0,
      receiptConfirmed: 0,
      currentValueConfirmed: 0,
      unresolvedWrites: 0,
      mismatchedRecords: 0,
      verificationErrors: 0,
    };
    for (const write of writes.values()) {
      let receiptConfirmed = false;
      if (write.state === 'unknown') {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const receipt = await request(
              write.user,
              write.vu,
              'receipt',
              '/api/cabinet/operation?id=' + encodeURIComponent(write.operationId),
            );
            receiptConfirmed =
              receipt.status === 'committed' &&
              receipt.result?.patients?.[0]?.appointments?.[0]?.notes === write.note;
            if (receiptConfirmed) break;
          } catch (error) {
            diagnostics.add(error, { route: 'receipt', stage: 'receipt-assertion' });
            /* Unknown or superseded receipts never prove a rejected write. */
          }
        }
      }
      try {
        const reply = await request(
          write.user,
          write.vu,
          'verify',
          '/api/cabinet/patient?id=' + write.user.patient,
        );
        const same = reply.patients[0].appointments[0].notes === write.note;
        if (same) {
          result.savedRecordsVerified++;
          if (write.state === 'unknown') {
            result.unknownWritesResolved++;
            if (receiptConfirmed) result.receiptConfirmed++;
            else result.currentValueConfirmed++;
          }
        } else if (write.state === 'unknown') result.unresolvedWrites++;
        else result.mismatchedRecords++;
      } catch (error) {
        diagnostics.add(error, { route: 'verify', stage: 'verification-assertion' });
        result.verificationErrors++;
        if (write.state === 'unknown') result.unresolvedWrites++;
      }
    }
    return { ...result, errorDiagnostics: diagnostics.snapshot() };
  }
  return {
    samples,
    accounts,
    organizations,
    request,
    action,
    reconcile,
    get peak() {
      return peak;
    },
    reset() {
      samples.length = 0;
      accounts.clear();
      organizations.clear();
      writes.clear();
      for (const key of Object.keys(counters)) counters[key] = 0;
      peak = 0;
    },
    setMeasuring(value) {
      measuring = value;
    },
  };
}
module.exports = { BASE, createClient };
