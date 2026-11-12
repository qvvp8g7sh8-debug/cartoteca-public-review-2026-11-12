const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../../shared/errors.cjs');
const { copyInformationBase } = require('./dialogue-control-turn.cjs');

// Async reads may yield between edits. Keep those edits private until the whole
// turn succeeds; a cancel/new command replaces the live entry and fences it.
function createDialogueReadIsolation(entries, now) {
  const active = new AsyncLocalStorage();
  const conflict = () => fail(409, 'Диалог изменился. Повторите ответ в текущем диалоге.');
  function capture(id) {
    const turn = active.getStore();
    if (!turn) return null;
    if (!turn.rows.has(id)) {
      const base = entries.get(id);
      const draft = base ? structuredClone(base) : undefined;
      if (draft) copyInformationBase(base.response, draft.response);
      turn.rows.set(id, { base, original: base ? structuredClone(base) : undefined, draft });
    }
    return turn.rows.get(id);
  }
  function check() {
    const turn = active.getStore();
    if (!turn || turn.discarded) return;
    for (const guard of turn.guards) guard();
    for (const [id, { base, original, draft }] of turn.rows)
      if (
        entries.get(id) !== base ||
        !isDeepStrictEqual(base, original) ||
        (draft && draft.expiresAt <= now())
      )
        throw conflict();
  }
  async function run(operation) {
    const turn = { rows: new Map(), guards: [], discarded: false };
    return active.run(turn, async () => {
      const result = await operation();
      if (turn.discarded) return result;
      check();
      // Each domain turn owns at most one newly created dialogue. Check capacity
      // before applying anything, so a full registry cannot partially commit.
      for (const { base, draft } of turn.rows.values())
        if (!base && draft) entries.assertCapacity();
      for (const [id, { draft }] of turn.rows)
        if (draft) entries.set(id, draft);
        else entries.delete(id);
      return result;
    });
  }
  return {
    run,
    check,
    fence(guard) {
      active.getStore()?.guards.push(guard);
    },
    discard() {
      const turn = active.getStore();
      if (turn) turn.discarded = true;
    },
    get(id) {
      const row = capture(id);
      return row ? row.draft : entries.get(id);
    },
    set(id, value) {
      const row = capture(id);
      if (row) row.draft = value;
      else entries.set(id, value);
    },
    delete(id) {
      const row = capture(id);
      if (row) row.draft = undefined;
      else entries.delete(id);
    },
  };
}
module.exports = { createDialogueReadIsolation };
