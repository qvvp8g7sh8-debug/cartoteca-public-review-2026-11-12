const { fail } = require('../../../../shared/errors.cjs');
const { dialogueControl } = require('./dialogue-control.cjs');
const { assertTransport } = require('../buffered-request.cjs');
const { createContinuationRequest } = require('./continuation/continuation-request.cjs');

// Reserve a continuation before its first async read/model admission. This is
// per dialogue, never a global queue, and cancellation can always pass through.
function createPendingDialogueReads({
  scope,
  fingerprint,
  verify = () => {},
  isStop,
  capacity = 100,
}) {
  const pending = new Map();
  async function run(c, body, operation) {
    if (
      !body.dialogueId ||
      body.newCommand === true ||
      body.cancel === true ||
      (isStop ? isStop(c, body) : dialogueControl(body.text, 'create') === 'stop')
    )
      return operation(c);
    const key = JSON.stringify([
      c.current.accountId,
      c.current.organizationId,
      c.current.sessionId,
      c.current.role,
      body.policyVersion,
      body.dialogueId,
    ]);
    const hash = fingerprint(body);
    const previous = pending.get(key);
    if (previous) {
      if (previous.hash !== hash)
        throw fail(429, 'Уточнение уже обрабатывается. Дождитесь ответа.');
      const result = await previous.wait(c);
      assertTransport(c);
      const fresh = scope(c, body.policyVersion);
      verify(c, body, fresh);
      return structuredClone(result);
    }
    if (pending.size >= capacity) throw fail(429, 'Помощник занят. Повторите уточнение позже.');
    const record = createContinuationRequest({
      hash,
      expiresAt: c.current.expiresAt,
      remove(owned) {
        if (pending.get(key) === owned) pending.delete(key);
      },
    });
    pending.set(key, record);
    record.start(() => operation(record.context(c)));
    return record.wait(c);
  }
  return { run };
}
module.exports = { createPendingDialogueReads };
