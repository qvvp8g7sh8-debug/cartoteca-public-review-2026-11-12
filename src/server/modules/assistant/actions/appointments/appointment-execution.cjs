const { createHash } = require('node:crypto');
const { fail } = require('../../../../../shared/errors.cjs');
const { keys } = require('../../access/defaults.cjs');
const { saveMutation } = require('../../../cabinet/mutations.cjs');
const {
  executionKind,
  prepareExecution,
  assertPreparedExecution,
  replayExecution,
} = require('./appointment-execution-kind.cjs');
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
function createAppointmentExecution({
  dialogues,
  scope,
  currentScope,
  enabled = false,
  assertExecutorOwned = null,
  recoverExecutionTime = null,
  commit = saveMutation,
  now = Date.now,
}) {
  const records = new WeakMap(),
    pending = new Map();
  function recoveryReplay(entry, version) {
    const receipt = entry.executionRecovery;
    return !entry.complete &&
      receipt?.version === entry.version &&
      receipt.response.policyVersion === version
      ? structuredClone(receipt.response)
      : null;
  }
  function allowed(c, fresh) {
    assertExecutorOwned?.();
    if (
      !enabled ||
      !fresh.state.policy.commands.prepareAppointment ||
      fresh.state.providers.llm.provider === 'demo' ||
      c.current.globalAdmin ||
      !c.current.accountId ||
      !c.current.organizationId ||
      !c.current.sessionId ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(c.current.role)
    )
      throw fail(403, 'Автоматическая запись помощником недоступна.');
  }
  function identity(c, fresh, id) {
    return createHash('sha256')
      .update(JSON.stringify([c.current.organizationId, c.current.accountId, id]))
      .digest('hex');
  }
  function entryFor(c, body, fresh) {
    const entry = dialogues.get(c, fresh.member, fresh.state, body.executionId);
    executionKind(entry);
    return entry;
  }
  function markerExists(c, key) {
    const storage = c.tenantStore(c.current.organizationId);
    return storage.transaction(() => {
      c.assertCurrent();
      if (storage.get('assistant-moved:' + key) === true) return 'move';
      if (storage.get('assistant-cancelled:' + key) === true) return 'cancel';
      return storage.get('assistant-created:' + key) === true ? 'create' : null;
    }, 'DEFERRED');
  }
  function savedReplay(c, key, id, version) {
    const kind = markerExists(c, key);
    return kind ? replayExecution(id, version, kind) : null;
  }
  async function execute(c, body) {
    keys(body, ['executionId', 'policyVersion']);
    if (
      typeof body.executionId !== 'string' ||
      !UUID.test(body.executionId) ||
      !Number.isSafeInteger(body.policyVersion) ||
      body.policyVersion < 0
    )
      throw fail(400, 'Укажите готовую запись и текущую версию помощника.');
    c.assertCurrent();
    let fresh = currentScope(c);
    allowed(c, fresh);
    const key = identity(c, fresh, body.executionId);
    // Reconcile an acknowledged or lost commit even after dialogue expiry/restart.
    // This reads only a permanent, account-bound boolean, never a clinical copy.
    const previous = savedReplay(c, key, body.executionId, fresh.state.revision);
    if (previous) return previous;
    const waiting = pending.get(key);
    if (waiting) {
      const outcome = await waiting;
      fresh = currentScope(c);
      allowed(c, fresh);
      const replay = savedReplay(c, key, body.executionId, fresh.state.revision);
      if (replay) return replay;
      if (outcome?.saved === false && outcome.definitive === true) {
        const current = dialogues.get(c, fresh.member, fresh.state, body.executionId);
        const recovery = recoveryReplay(current, fresh.state.revision);
        if (recovery) return recovery;
      }
      throw fail(409, 'Результат записи ещё не подтверждён. Повторите проверку.');
    }
    let entry;
    try {
      entry = dialogues.get(c, fresh.member, fresh.state, body.executionId);
    } catch (error) {
      if (error.status !== 409) throw error;
      return {
        saved: false,
        definitive: true,
        code: 'ASSISTANT_EXECUTION_EXPIRED',
        text: 'Подготовка истекла. Повторите команду.',
        action: null,
        policyVersion: fresh.state.revision,
      };
    }
    fresh = scope(c, body.policyVersion);
    allowed(c, fresh);
    const recovered = recoveryReplay(entry, fresh.state.revision);
    if (recovered) return recovered;
    entryFor(c, body, fresh);
    let record = records.get(entry);
    if (!record) {
      record = {};
      records.set(entry, record);
    }
    if (pending.size >= 100)
      throw fail(429, 'Помощник уже сохраняет много записей. Повторите позже.');
    const promise = Promise.resolve()
      .then(async () => {
        const initial = scope(c, body.policyVersion);
        allowed(c, initial);
        entryFor(c, body, initial);
        if (!record.prepared) record.prepared = prepareExecution(c, entry, now());
        const frozen = record.prepared;
        const headers = {
          ...(c.req?.headers || {}),
          'x-cartoteca-operation': 'assistant-' + entry.id,
          'x-cartoteca-schedule-ack': frozen.acknowledgement,
        };
        const owned = {
          ...c,
          req: c.req
            ? {
                headers,
                get aborted() {
                  return c.req.aborted;
                },
              }
            : { headers },
        };
        const marker =
          (frozen.kind === 'move'
            ? 'assistant-moved:'
            : frozen.kind === 'cancel'
              ? 'assistant-cancelled:'
              : 'assistant-created:') + key;
        const trustedCommit = {
          assert(actor, storage) {
            // allowed() below rechecks executor ownership inside the common cabinet writer.
            const current = { ...c, current: actor };
            const latest = scope(current, body.policyVersion);
            allowed(current, latest);
            if (
              identity(current, latest, body.executionId) !== key ||
              entryFor(current, body, latest) !== entry
            )
              throw fail(409, 'Доступ к подготовленной записи изменился.');
            if (storage.get(marker) === true)
              throw fail(409, 'Запись уже сохранена. Повторите проверку.');
            assertPreparedExecution(current, entry, frozen, now());
          },
          written(storage) {
            storage.set(marker, true);
          },
          // This executor has no second platform record to finalize after the cabinet commit.
          committed() {},
        };
        try {
          await commit(owned, frozen.body, { appointmentCommand: true, trustedCommit });
        } catch (error) {
          const latest = currentScope(c);
          allowed(c, latest);
          const replay = savedReplay(c, key, body.executionId, latest.state.revision);
          if (replay) return replay;
          throw error;
        }
        const result = {
          saved: true,
          ...(frozen.kind === 'move'
            ? { moved: true, operation: 'move' }
            : frozen.kind === 'cancel'
              ? { cancelled: true, operation: 'cancel' }
              : {}),
          appointmentId: frozen.captured.appointment.id,
          text: frozen.captured.text,
          policyVersion: body.policyVersion,
          action: {
            type: 'calendar',
            date: frozen.captured.appointment.date,
            staffId: frozen.captured.staffId || frozen.captured.appointment.staffId,
          },
        };
        entry.executionSaved = { ...result, dialogue: null };
        return result;
      })
      .catch((error) => {
        if (
          !recoverExecutionTime ||
          ![
            'APPOINTMENT_TIME_STEP',
            'ASSISTANT_TIME_UNAVAILABLE',
            'ASSISTANT_CANCEL_CONFIRMATION_STALE',
          ].includes(error.code)
        )
          throw error;
        const latest = scope(c, body.policyVersion);
        allowed(c, latest);
        const replay = savedReplay(c, key, body.executionId, latest.state.revision);
        if (replay) return replay;
        if (dialogues.get(c, latest.member, latest.state, body.executionId) !== entry) throw error;
        const recovery = recoverExecutionTime(c, entry, latest, error, now());
        if (!recovery?.dialogue || recovery.action !== null) throw error;
        records.delete(entry);
        const reply = {
          saved: false,
          definitive: true,
          code: 'ASSISTANT_EXECUTION_REQUIRES_INPUT',
          policyVersion: latest.state.revision,
          recovery: { ...recovery, policyVersion: latest.state.revision },
        };
        entry.executionRecovery = { version: entry.version, response: reply };
        return reply;
      });
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      if (pending.get(key) === promise) pending.delete(key);
    }
  }
  return { execute };
}
module.exports = { createAppointmentExecution };
