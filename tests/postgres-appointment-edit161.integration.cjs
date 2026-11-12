const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { readOperationStatus } = require('../src/server/infrastructure/mutation-receipts.cjs');

test(
  '161 typed point command validates once under owning PG transaction and keeps effects, CAS, receipt and rollback',
  { timeout: 120000 },
  async (t) => {
    const f = await postgresBusinessFixture(t, { cabinetSchema: 2 });
    const original = f.storage.read(),
      p = original.patients[0],
      before = p.appointments[0],
      stages = [];
    assert.ok(f.storage.capabilities.normalizedRecords);
    assert.ok(f.platform.withAsyncCompoundMutation);
    const operation = randomUUID();
    f.context.req.headers['x-cartoteca-appointment-response'] = 'point-v1';
    f.context.req.headers['x-cartoteca-operation'] = operation;
    f.context.recordStage = (stage) => stages.push(stage);
    const read = f.storage.readAppointmentMutation;
    let reads = 0;
    f.storage.readAppointmentMutation = (...args) => {
      reads++;
      return read(...args);
    };
    f.storage.prepareImages = () => {
      throw Error('Typed appointment cannot prepare clinical images');
    };
    const body = {
      revision: original.revision,
      patientId: p.id,
      changes: [{ id: before.id, before, after: { ...before, notes: 'Point native161' } }],
    };
    const saved = await saveMutation(f.context, body, { appointmentCommand: true });
    assert.equal(reads, 1);
    assert.equal(stages.includes('save-initial-read'), false);
    assert.equal(stages.includes('save-revalidation'), true);
    assert.equal(saved.appointmentOnly, true);
    assert.equal(saved.patients[0].appointments[0].notes, 'Point native161');
    assert.deepEqual(f.storage.read().patients[0].visits, p.visits);
    assert.equal(readOperationStatus(f.storage, f.context.current, operation).status, 'committed');
    const replay = await saveMutation(f.context, body, { appointmentCommand: true });
    assert.equal(replay.revision, saved.revision);
    assert.equal(reads, 1);
    f.context.req.headers['x-cartoteca-operation'] = randomUUID();
    await assert.rejects(
      saveMutation(f.context, body, { appointmentCommand: true }),
      (error) => error.status === 409,
    );
    const stable = f.storage.read(),
      row = stable.patients[0].appointments[0],
      failedId = randomUUID();
    f.context.req.headers['x-cartoteca-operation'] = failedId;
    const audit = f.storage.audit;
    // Fail after canonical DML and platform effects, before receipt/COMMIT.
    f.storage.audit = () => {
      throw Error('Synthetic161 late failure');
    };
    // The writer captures audit privately; fail the shared receipt metadata write.
    const set = f.storage.set;
    f.storage.set = (key, value) => {
      if (key.startsWith('mutation-operation:')) throw Error('Synthetic161 late failure');
      return set(key, value);
    };
    await assert.rejects(
      saveMutation(
        f.context,
        {
          revision: stable.revision,
          patientId: p.id,
          changes: [
            {
              id: row.id,
              before: row,
              after: { ...row, time: row.time === '10:00' ? '11:00' : '10:00' },
            },
          ],
        },
        { appointmentCommand: true },
      ),
      /Synthetic161/,
    );
    f.storage.audit = audit;
    f.storage.set = set;
    assert.deepEqual(f.storage.read(), stable);
    assert.equal(readOperationStatus(f.storage, f.context.current, failedId).status, 'unknown');
    const caughtId = randomUUID();
    f.context.req.headers['x-cartoteca-operation'] = caughtId;
    let injected = false;
    f.storage.set = (key, value) => {
      if (key.startsWith('mutation-operation:') && !injected) {
        injected = true;
        assert.throws(
          () =>
            f.storage.db
              .prepare('INSERT INTO patients(id,value) VALUES(?,?)')
              .run(p.id, Buffer.from('synthetic')),
          (error) => error.code === '23505',
        );
      }
      return set(key, value);
    };
    await assert.rejects(
      saveMutation(
        f.context,
        {
          revision: stable.revision,
          patientId: p.id,
          changes: [
            { id: row.id, before: row, after: { ...row, notes: 'Caught SQL cannot commit161' } },
          ],
        },
        { appointmentCommand: true },
      ),
      (error) => ['POSTGRES_ATOMIC_STATEMENT_FAILED', '25P02'].includes(error.code),
    );
    f.storage.set = set;
    assert.equal(injected, true);
    assert.deepEqual(f.storage.read(), stable);
    assert.equal(readOperationStatus(f.storage, f.context.current, caughtId).status, 'unknown');
  },
);
