const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { editable } = require('../src/server/modules/cabinet/changes.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');

function request(base, actor, requestPath, { method = 'GET', value, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? null : JSON.stringify(value);
    const outgoing = http.request(
      new URL(requestPath, base),
      {
        method,
        headers: {
          cookie: 'cartoteca_v2_session=' + actor.token,
          'x-cartoteca-account-id': actor.accountId,
          'x-cartoteca-organization-id': actor.organizationId,
          ...(body === null
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Origin: base,
                'X-Cartoteca-Request': '1',
              }),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => {
          try {
            resolve({
              status: incoming.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'bounded native command admission did not settle');
    await delay(20);
  }
}
async function finite(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Independent web request was blocked by a manual save.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'real synchronous cabinet contention stays in the command PID while auth/query progress, bounded admission and manual receipts retain their contracts',
  { timeout: 90000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 });
    const [owner, foreign] = f.actors;
    const cabinet = createStorage(path.join(f.directory, 'tenants', owner.organizationId));
    f.platform.workSchedules.save(
      owner.token,
      {
        dates: ['2035-01-01'],
        staffId: owner.accountId,
        status: 'working',
        intervals: [['00:00', '24:00']],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      cabinet,
    );
    const server = await createIsolatedServer({ ...f.config, nativeCommandIsolation: true });
    let held = false;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port;
      const first = cabinet.read(),
        before = first.patients[0];
      const operation = randomUUID();
      const body = {
        revision: first.revision,
        patients: [
          { id: before.id, before, after: { ...before, notes: 'Synthetic isolated manual save' } },
        ],
        services: [],
      };
      const topology = server.isolationStatus();
      assert.notEqual(topology.owner.application.pid, topology.owner.command.pid);
      assert.equal(topology.commands.activeLimit, 1);
      assert.equal(topology.commands.pendingLimit, 16);
      // This is a real SQLite writer conflict. SQL waits synchronously in the
      // command process; there is no Promise stub standing in for expensive work.
      cabinet.db.exec('BEGIN IMMEDIATE');
      held = true;
      let settled = false;
      const saving = request(base, owner, '/api/cabinet/changes', {
        method: 'PATCH',
        value: body,
        headers: { 'X-Cartoteca-Operation': operation },
      }).then((result) => {
        settled = true;
        return result;
      });
      await until(() => server.isolationStatus().commands.active === 1);
      await delay(120);
      assert.equal(settled, false);
      const pending = Array.from({ length: 16 }, () =>
        request(base, owner, '/api/cabinet/changes', { method: 'PATCH', value: {} }),
      );
      await until(() => server.isolationStatus().commands.pending === 16);
      const refused = await request(base, owner, '/api/cabinet/changes', {
        method: 'PATCH',
        value: {},
      });
      assert.equal(refused.status, 503);
      const [session, read] = await finite(
        Promise.all([
          request(base, owner, '/api/auth/session'),
          request(base, owner, '/api/cabinet/patient?id=' + owner.patientId),
        ]),
        2000,
      );
      assert.equal(session.status, 200);
      assert.equal(session.body.user.id, owner.accountId);
      assert.equal(read.status, 200);
      assert.equal(
        settled,
        false,
        'web/query answered before the blocked cabinet writer was released',
      );
      cabinet.db.exec('ROLLBACK');
      held = false;
      const saved = await saving;
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      for (const result of await Promise.all(pending)) assert.equal(result.status, 400);
      const replay = await request(base, owner, '/api/cabinet/changes', {
        method: 'PATCH',
        value: body,
        headers: { 'X-Cartoteca-Operation': operation },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.revision, saved.body.revision);
      const receipt = await request(
        base,
        owner,
        '/api/cabinet/operation?statusOnly=1&id=' + operation,
      );
      assert.equal(receipt.body.status, 'committed');
      assert.equal(receipt.body.revision, saved.body.revision);
      assert.deepEqual(
        (await request(base, foreign, '/api/cabinet/operation?statusOnly=1&id=' + operation)).body,
        { status: 'unknown' },
      );
      const crossed = await request(base, owner, '/api/cabinet/changes', {
        method: 'PATCH',
        value: body,
        headers: { cookie: 'cartoteca_v2_session=' + foreign.token },
      });
      assert.equal(crossed.status, 428);
      assert.equal(crossed.body.code, 'AUTH_CONTEXT_CHANGED');
      const full = editable(cabinet.read());
      full.patients[0].notes = 'Synthetic full import retained';
      const put = await request(base, owner, '/api/cabinet', { method: 'PUT', value: full });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const appointment = {
        id: 'synthetic-native-command-appointment',
        date: '2035-01-01',
        time: '10:00',
        duration: 30,
        staffId: owner.accountId,
        roomId: 'main',
        status: 'scheduled',
        service: 'Synthetic',
      };
      const created = await request(base, owner, '/api/cabinet/appointments', {
        method: 'POST',
        value: {
          revision: put.body.revision,
          patientId: owner.patientId,
          changes: [{ id: appointment.id, before: null, after: appointment }],
        },
        headers: { 'X-Cartoteca-Operation': randomUUID() },
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const final = cabinet.read();
      assert.equal(final.patients[0].notes, full.patients[0].notes);
      assert.deepEqual(final.patients[0].appointments, [appointment]);
      assert.equal((await request(base, owner, '/api/auth/session')).status, 200);
      assert.equal(server.isolationStatus().commands.pending, 0);
    } finally {
      if (held) cabinet.db.exec('ROLLBACK');
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      cabinet.close();
    }
  },
);
