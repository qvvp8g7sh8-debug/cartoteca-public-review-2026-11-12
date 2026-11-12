const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { endpoint, PROFILE } = require('./benchmark-mixed92-profile.cjs');
const { collector } = require('./benchmark-mixed92-results.cjs');
function safeErrorMessage(value) {
  return String(value || 'Synthetic request failed')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[id]')
    .replace(/\+?[\d ()-]{7,}/g, '[number]')
    .slice(0, 240);
}
async function errorDetails(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  try {
    while (size < 4096) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value).subarray(0, 4096 - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return {
      message: typeof value.error === 'string' ? safeErrorMessage(value.error) : undefined,
      code:
        typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
          ? value.code
          : undefined,
    };
  } catch {
    return {};
  }
}
// Only closed transport categories are recorded; cause messages/addresses never leave the client.
const NETWORK_FAILURE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ABORT_ERR',
]);
function networkFailureCode(error) {
  if (error.name === 'TimeoutError') return 'REQUEST_DEADLINE';
  const code = error.cause?.code || error.code;
  return NETWORK_FAILURE_CODES.has(code) ? code : null;
}
function createClient(
  fixture,
  { base = 'http://10.234.12.2:4173', fetchImpl = fetch, now = () => performance.now(), jpeg } = {},
) {
  base = endpoint(base);
  const applicationOrigin = base.replace('http:', 'https:');
  const http = collector(),
    writes = new Map(),
    latest = new Map(),
    blocked = new Set(),
    versions = new Map(),
    etags = new Map();
  const failures = new Map();
  let omittedFailures = 0;
  function recordFailure(name, error, stage) {
    const row = {
      name,
      stage,
      status: error.status || 'validation-or-network',
      networkCode: networkFailureCode(error),
      code:
        typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null,
      message: safeErrorMessage(error.message),
    };
    const key = JSON.stringify(row);
    if (failures.has(key)) failures.get(key).count++;
    else if (failures.size < 24) failures.set(key, { ...row, count: 1 });
    else omittedFailures++;
  }
  let measuring = true,
    sequenceWrites = 0,
    assistantCalls = 0;
  function query(route, values) {
    return route + '?' + new URLSearchParams(values);
  }
  async function request(
    user,
    name,
    route,
    {
      body,
      method = body ? 'POST' : 'GET',
      operationId,
      type = 'json',
      headers = {},
      allowed = [200],
    } = {},
  ) {
    assert.ok(route.startsWith('/api/') && !route.startsWith('//') && !route.includes('://'));
    const started = now();
    let status = 'error',
      bytes = 0;
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const response = await fetchImpl(base + route, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(PROFILE.requestTimeoutMs),
        headers: {
          Origin: applicationOrigin,
          'X-Cartoteca-Request': '1',
          Cookie: user.cookie,
          'X-Cartoteca-Account-Id': user.id,
          'X-Cartoteca-Organization-Id': user.org,
          'X-Cartoteca-Client-IP': `10.64.${Math.floor(user.ordinal / 250) % 250}.${1 + (user.ordinal % 250)}`,
          ...(encoded === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(encoded)),
              }),
          ...(operationId ? { 'X-Cartoteca-Operation': operationId } : {}),
          ...headers,
        },
        body: encoded,
      });
      status = response.status;
      if (!allowed.includes(status)) {
        const detail = await errorDetails(response);
        throw Object.assign(Error(detail.message || name + ' HTTP ' + status), {
          status,
          code: detail.code,
        });
      }
      const raw = Buffer.from(await response.arrayBuffer());
      bytes = raw.length;
      const value =
        type === 'json'
          ? JSON.parse(raw.toString('utf8'))
          : type === 'text'
            ? raw.toString('utf8')
            : raw;
      if (value.directory)
        assert.ok(
          value.directory.every((row) => row.id.startsWith('p-' + user.index + '-')),
          'Foreign directory',
        );
      if (value.patients)
        assert.ok(
          value.patients.every((row) => row.id.startsWith('p-' + user.index + '-')),
          'Foreign card',
        );
      return { value, response };
    } catch (error) {
      if (allowed.includes(status)) status = 'validation';
      recordFailure(name, error, 'http');
      throw error;
    } finally {
      if (measuring) http.record(name, { ms: now() - started, status, bytes });
    }
  }
  async function card(user) {
    const { value } = await request(
      user,
      'card',
      query('/api/cabinet/patient', { id: user.patient }),
    );
    assert.equal(value.patients?.[0]?.id, user.patient);
    return value;
  }
  async function mutation(user, sequence, photo) {
    if (blocked.has(user.id)) throw Error('Previous mutation has unknown outcome');
    const state = await card(user),
      before = state.patients[0],
      after = structuredClone(before);
    const tag = 'Synthetic mixed92 ' + sequence;
    if (photo) {
      assert.ok(jpeg?.length >= PROFILE.photoBytesMin && jpeg.length <= PROFILE.photoBytesMax);
      after.visits[0].photos = [
        { data: 'data:image/jpeg;base64,' + jpeg.toString('base64'), caption: tag },
      ];
    } else {
      assert.ok(after.appointments?.[0], 'Synthetic save requires an accessible appointment');
      after.appointments[0].notes = tag;
    }
    const operationId = randomUUID(),
      body = {
        revision: state.revision,
        patients: [{ id: user.patient, before, after }],
        services: [],
      };
    const write = {
      user,
      operationId,
      tag,
      photo,
      appointmentId: after.appointments?.[0]?.id,
      state: 'unknown',
    };
    writes.set(operationId, write);
    blocked.add(user.id);
    try {
      const { value } = await request(
        user,
        photo ? 'photo-upload' : 'save',
        '/api/cabinet/changes',
        { body, method: 'PATCH', operationId },
      );
      assert.equal(value.patients?.[0]?.id, user.patient);
      if (photo) {
        user.photo = value.patients[0].visits[0].photos[0].data;
        assert.match(user.photo, /^\/api\/photos\/[a-f0-9]{32}$/);
      } else
        assert.equal(
          value.patients[0].appointments.find((row) => row.id === write.appointmentId)?.notes,
          tag,
        );
      write.state = 'acknowledged';
      write.acknowledged = true;
      // Exercise real idempotent replay, never manufacture a second operation id.
      if (++sequenceWrites % 20 === 0) {
        const { value: replay } = await request(user, 'replay', '/api/cabinet/changes', {
          body,
          method: 'PATCH',
          operationId,
        });
        verifyWrite(write, replay.patients?.[0]);
        write.replayed = true;
      }
      assert.equal(await confirmReceipt(write), true, 'Receipt missing for acknowledged mutation');
      blocked.delete(user.id);
    } catch (error) {
      if (!write.acknowledged && error.status >= 400 && error.status < 500) {
        write.state = 'rejected';
        blocked.delete(user.id);
      }
      throw error;
    }
  }
  function verifyWrite(write, patient) {
    assert.equal(patient?.id, write.user.patient);
    if (write.photo) {
      assert.match(patient.visits[0].photos[0].data, /^\/api\/photos\/[a-f0-9]{32}$/);
      assert.equal(patient.visits[0].photos[0].caption, write.tag);
    } else
      assert.equal(
        patient.appointments.find((row) => row.id === write.appointmentId)?.notes,
        write.tag,
      );
  }
  async function confirmReceipt(write) {
    const { value } = await request(
      write.user,
      'receipt',
      query('/api/cabinet/operation', { id: write.operationId }),
    );
    if (value.status !== 'committed') return false;
    const patient = value.result?.patients?.[0];
    verifyWrite(write, patient);
    write.receiptConfirmed = true;
    const expected = latest.get(write.user.id) || { user: write.user };
    if (write.photo) {
      expected.photo = patient.visits[0].photos[0].data;
      expected.caption = write.tag;
    } else {
      expected.appointmentId = write.appointmentId;
      expected.notes = write.tag;
    }
    latest.set(write.user.id, expected);
    return true;
  }
  async function executeAction(name, user, sequence) {
    if (name === 'card') return card(user);
    if (name === 'search')
      return request(
        user,
        name,
        query('/api/cabinet/directory', { limit: 20, q: 'Client' + (sequence % fixture.cards) }),
      );
    if (name === 'calendar') {
      const stamp = versions.get(user.id);
      const values = {
        from: fixture.first,
        to: fixture.first,
        compact: 1,
        monthFrom: fixture.first,
        monthTo: fixture.monthEnd,
        projection: 'details',
        ...(stamp ? { version: stamp.version, until: stamp.validUntil } : {}),
      };
      const { value } = await request(user, name, query('/api/cabinet/calendar', values));
      if (!value.unchanged) {
        assert.ok(
          value.appointments.every((row) => row.patientId.startsWith('p-' + user.index + '-')),
          'Foreign calendar',
        );
        versions.set(user.id, { version: value.version, validUntil: value.validUntil });
      }
      return value;
    }
    if (name === 'save' || name === 'photo-upload')
      return mutation(user, sequence, name === 'photo-upload');
    if (name === 'photo-read') {
      assert.match(user.photo, /^\/api\/photos\/[a-f0-9]{32}$/);
      const { value } = await request(
        user,
        name,
        query(user.photo, { accountContext: user.id, organizationContext: user.org }),
        { type: 'bytes' },
      );
      assert.equal(value[0], 255);
      assert.equal(value[1], 216);
      return;
    }
    if (name === 'ics') {
      const { value, response } = await request(
        user,
        name,
        query('/api/calendar/feed.ics', { subscription: user.ics }),
        {
          type: 'text',
          allowed: [200, 304],
          headers: etags.has(user.id) ? { 'If-None-Match': etags.get(user.id) } : {},
        },
      );
      if (response.status === 304) {
        assert.equal(value, '');
        return;
      }
      assert.ok(value.startsWith('BEGIN:VCALENDAR\r\n'));
      assert.ok(value.includes('END:VCALENDAR'));
      const etag = response.headers.get('etag');
      if (etag) etags.set(user.id, etag);
      assert.ok(!value.includes('TEL:') && !value.includes('Synthetic history'));
      return;
    }
    if (name === 'auth') {
      const { value, response } = await request(user, name, '/api/auth/login', {
        body: { email: user.email, password: fixture.password },
      });
      assert.equal(value.user?.id, user.id);
      assert.equal(value.organizationId, user.org);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      user.cookie = cookie;
      return;
    }
    assert.equal(name, 'assistant');
    assert.equal(user.assistant, true);
    const { value: scope } = await request(user, 'assistant-scope', '/api/assistant/scope');
    assert.equal(scope.enabled, true);
    const fast = assistantCalls++ % 2 === 0;
    const taskRequestId = randomUUID();
    const { value: reply } = await request(
      user,
      fast ? 'assistant-local' : 'assistant-model',
      '/api/assistant/turn',
      {
        body: {
          policyVersion: scope.policyVersion,
          text: fast ? 'Покажи приёмы на следующую неделю' : 'Найди клиента Synthetic Client0',
          taskRequestId,
        },
      },
    );
    const text = reply.speechPermit?.answerableText || reply.text;
    assert.ok(typeof text === 'string' && text.trim());
    const { value: spoken } = await request(user, 'assistant-tts', '/api/assistant/speak', {
      body: {
        policyVersion: reply.policyVersion,
        taskRequestId: reply.taskRequestId || taskRequestId,
        ...(reply.speechPermit ? { speechToken: reply.speechPermit.token } : {}),
        text,
        stream: true,
        format: 'mp3',
      },
    });
    if (spoken.streamUrl) {
      const { value: audio } = await request(user, 'assistant-audio', spoken.streamUrl, {
        type: 'bytes',
      });
      assert.ok(audio.length > 0);
    } else assert.ok(spoken.audioBase64 && spoken.mimeType);
    return reply;
  }
  async function action(name, user, sequence) {
    try {
      return await executeAction(name, user, sequence);
    } catch (error) {
      recordFailure(name, error, 'action');
      throw error;
    }
  }
  async function reconcile() {
    measuring = false;
    const result = {
      attempted: writes.size,
      acknowledged: 0,
      rejected: 0,
      committed: 0,
      replayed: 0,
      unknown: 0,
      mismatched: 0,
      tenantIsolation: 0,
      tenantIsolationFailures: 0,
      receiptConfirmed: 0,
      latestCardsVerified: 0,
    };
    for (const write of writes.values()) {
      if (write.state !== 'unknown') result[write.state] = (result[write.state] || 0) + 1;
      if (write.state === 'rejected') continue;
      try {
        if (!write.receiptConfirmed && !(await confirmReceipt(write))) {
          result.unknown++;
          continue;
        }
        result.committed++;
        result.receiptConfirmed++;
        if (write.replayed) result.replayed++;
      } catch (error) {
        recordFailure('receipt', error, 'reconcile');
        result.mismatched++;
      }
    }
    for (const expected of latest.values()) {
      try {
        const state = await card(expected.user),
          patient = state.patients[0];
        if (expected.appointmentId)
          assert.equal(
            patient.appointments.find((row) => row.id === expected.appointmentId)?.notes,
            expected.notes,
          );
        if (expected.photo) {
          assert.equal(patient.visits[0].photos[0].data, expected.photo);
          assert.equal(patient.visits[0].photos[0].caption, expected.caption);
        }
        result.latestCardsVerified++;
      } catch (error) {
        recordFailure('card', error, 'final-verification');
        result.mismatched++;
      }
    }
    const distinct = [...new Map(fixture.actors.map((actor) => [actor.org, actor])).values()].slice(
      0,
      21,
    );
    for (let n = 1; n < distinct.length; n++) {
      const user = distinct[n - 1],
        foreign = distinct[n];
      try {
        const { value } = await request(
          user,
          'tenant-isolation',
          query('/api/cabinet/patient', { id: foreign.patient }),
          { allowed: [404] },
        );
        assert.ok(value.error);
        result.tenantIsolation++;
      } catch {
        result.tenantIsolationFailures++;
      }
    }
    return result;
  }
  return {
    action,
    request,
    reconcile,
    snapshot: () => http.snapshot(),
    errors: () => ({ examples: [...failures.values()], omitted: omittedFailures }),
  };
}
module.exports = { createClient, safeErrorMessage };
