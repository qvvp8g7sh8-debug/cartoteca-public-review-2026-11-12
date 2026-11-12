const { fail } = require('../../../../../shared/errors.cjs');
const { readSteps } = require('../../read-steps.cjs');
const { continuationPayload } = require('./continuation-prompt.cjs');
const { parseContinuation } = require('./continuation-contract.cjs');
const { createContinuationRequest } = require('./continuation-request.cjs');
const { zonedClock } = require('../../../../../shared/time-zone.cjs');
function createContinuationRuntime({ dialogues, scope, invoke, timeZone, now = Date.now }) {
  const requests = new Map();
  const identity = (c, state, body) =>
    JSON.stringify([
      c.current.accountId,
      c.current.organizationId,
      c.current.sessionId,
      c.current.role,
      state.revision,
      body.dialogueId,
    ]);
  const zoneFor = (c) =>
    c.assistantReads ? c.assistantReads.timeZone() : timeZone(c.current.organizationId);
  const clockFor = (c) => {
    const zone = zoneFor(c);
    return zone && typeof zone.then === 'function'
      ? zone.then((value) => zonedClock(new Date(now()), value))
      : zonedClock(new Date(now()), zone);
  };
  // A phase owns one bounded RR. It must finish before provider admission;
  // neither authority nor values from this frame authorize a later phase.
  const readPhase = (c, work) =>
    c.assistantReads?.snapshot ? c.assistantReads.snapshot(work) : work();
  function remove(key, record) {
    if (requests.get(key) === record) requests.delete(key);
  }
  function retire(key, record, error) {
    if (!record) return;
    record.cancel(error);
    remove(key, record);
  }
  async function replay(c, body, state, member) {
    scope(c, body.policyVersion);
    return dialogues.continueDialogue(c, body, state, member, await clockFor(c));
  }
  async function follow(c, body, record) {
    if (record.error) throw record.error;
    await record.wait(c);
    const fresh = scope(c, body.policyVersion);
    return {
      ...(await replay(c, body, fresh.state, fresh.member)),
      ...(record.usage ? { usage: record.usage } : {}),
    };
  }
  async function run(c, body, state, member) {
    scope(c, body.policyVersion);
    const key = identity(c, state, body),
      hash = dialogues.fingerprint(body);
    if (body.cancel === true) {
      const result = dialogues.continueDialogue(c, body, state, member, null);
      retire(key, requests.get(key), fail(409, 'Подготовка отменена. Начните новую команду.'));
      return result;
    }
    if (state.providers.llm.provider === 'demo') return replay(c, body, state, member);
    const entry = dialogues.get(c, member, state, body.dialogueId);
    const version = entry.version;
    for (const [oldKey, record] of requests)
      if (record.expiresAt <= now())
        retire(oldKey, record, fail(409, 'Диалог истёк. Начните новую команду.'));
    const prior = requests.get(key);
    if (prior?.hash === hash) return follow(c, body, prior);
    if (prior?.pending) throw fail(429, 'Уточнение уже обрабатывается. Дождитесь ответа.');
    const prepared = await readPhase(c, async () => {
      const zone = await zoneFor(c);
      const clock = zonedClock(new Date(now()), zone);
      const local = {};
      const snapshot = await dialogues.prepareModelTurn(c, body, state, member, clock, local);
      if (snapshot) return { snapshot, zone };
      scope(c, body.policyVersion);
      return {
        local: await dialogues.continueDialogue(c, body, state, member, clock, undefined, local),
      };
    });
    const { snapshot } = prepared;
    if (!snapshot) {
      retire(key, prior);
      return prepared.local;
    }
    // Another request may enter while this one awaits its read phase. Admission
    // below is synchronous, so only one record can own the provider call.
    const latest = requests.get(key);
    if (latest?.hash === hash) return follow(c, body, latest);
    if (latest?.pending) throw fail(429, 'Уточнение уже обрабатывается. Дождитесь ответа.');
    const current = dialogues.get(c, member, state, body.dialogueId);
    if (current.lastHash === hash) return replay(c, body, state, member);
    if (current.version !== version)
      throw fail(409, 'Диалог уже изменился. Повторите последний ответ или начните новую команду.');
    // A malformed or stale replacement must not erase the sent attempt receipt.
    if (latest) retire(key, latest);
    if (requests.size >= 100)
      throw fail(429, 'Помощник уже обрабатывает много уточнений. Повторите позже.');
    const record = createContinuationRequest({
      hash,
      expiresAt: entry.expiresAt,
      remove: (owned) => remove(key, owned),
    });
    const operation = record.context(c);
    requests.set(key, record);
    record.start(async () => {
      const { payload } = continuationPayload(body.text, state, snapshot.context, prepared.zone);
      const inputUpper = Buffer.byteLength(JSON.stringify(payload), 'utf8') + 1024;
      const reserved =
        (inputUpper * state.rates.llmInput +
          state.policy.limits.maxOutputTokens * state.rates.llmOutput) /
        1000000;
      const assert = readSteps(function* () {
        record.check();
        const fresh = scope(operation, body.policyVersion);
        yield dialogues.assertModelTurn(operation, body, fresh.state, fresh.member, snapshot);
        record.check();
      });
      await readPhase(operation, assert);
      const result = await invoke(
        operation,
        body.policyVersion,
        'llm',
        state,
        payload,
        reserved,
        () => ({}),
        readSteps(function* () {
          yield readPhase(operation, assert);
          record.outbound = true;
        }),
      );
      let proposal;
      try {
        proposal = parseContinuation(result.text);
      } catch (error) {
        // Only this pure wire-parser failure is recoverable. Provider, transport,
        // stale snapshot and revoked-scope failures keep their original status.
        if (error.status !== 502) throw error;
        const reply = await readPhase(operation, async () => {
          await assert();
          const fresh = scope(operation, body.policyVersion);
          return dialogues.recoverModelTurn(operation, body, fresh.state, fresh.member, snapshot);
        });
        record.usage = result.usage;
        return { ...reply, ...(result.usage ? { usage: result.usage } : {}) };
      }
      const reply = await readPhase(operation, async () => {
        await assert();
        const fresh = scope(operation, body.policyVersion);
        return dialogues.applyModelTurn(
          operation,
          body,
          fresh.state,
          fresh.member,
          await clockFor(operation),
          proposal,
          snapshot,
        );
      });
      record.usage = result.usage;
      return { ...reply, ...(result.usage ? { usage: result.usage } : {}) };
    });
    const result = await record.wait(c);
    scope(c, body.policyVersion);
    return result;
  }
  function clearAccount(accountId) {
    for (const [key, record] of requests) if (JSON.parse(key)[0] === accountId) retire(key, record);
  }
  function clearSession(sessionId) {
    for (const [key, record] of requests) if (JSON.parse(key)[2] === sessionId) retire(key, record);
  }
  return { run, clearAccount, clearSession };
}
module.exports = { createContinuationRuntime };
