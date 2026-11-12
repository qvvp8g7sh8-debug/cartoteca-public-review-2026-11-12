const { createHash, randomUUID } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { createDialogueRegistry, DEFAULT_CAPACITY } = require('./dialogue-registry.cjs');
const { createDialogueReadIsolation } = require('./dialogue-read-isolation.cjs');
const TTL_MS = 10 * 60 * 1000;
const MAX_DIALOGUES = DEFAULT_CAPACITY;
function createDialogueStore({ now = Date.now, capacity = MAX_DIALOGUES } = {}) {
  const registry = () => createDialogueRegistry({ now, capacity });
  const entries = registry(),
    commands = registry(),
    pending = registry();
  let sequence = 0;
  const isolated = createDialogueReadIsolation(entries, now);
  const identity = (c, member, revision) =>
    JSON.stringify([
      c.current.accountId,
      c.current.organizationId,
      c.current.sessionId,
      c.current.role,
      member.membershipId,
      revision,
    ]);
  function sweep() {
    entries.sweep();
    commands.sweep();
    pending.sweep();
  }
  function retireAccepted(accountId) {
    entries.clearAccount(accountId);
    commands.clearAccount(accountId);
  }
  function invalidatePending(accountId, through = Infinity) {
    for (const ticket of pending.forAccount(accountId))
      if (ticket.sequence <= through) pending.delete(ticket.token);
  }
  function clearAccount(accountId) {
    retireAccepted(accountId);
    invalidatePending(accountId);
  }
  function prepareCommand(c, member, state) {
    sweep();
    const ticket = Object.freeze({
      key: identity(c, member, state.revision),
      token: randomUUID(),
      accountId: c.current.accountId,
      sessionId: c.current.sessionId,
      sequence: ++sequence,
      expiresAt: Math.min(now() + TTL_MS, c.current.expiresAt || Infinity),
    });
    pending.set(ticket.token, ticket);
    return ticket;
  }
  function acceptCommand(ticket) {
    sweep();
    const accepted = commands.get(ticket?.key);
    if (accepted && accepted.token === ticket.token) return ticket;
    if (!ticket || pending.get(ticket.token) !== ticket)
      throw fail(409, 'Эту команду заменила новая или доступ изменился. Повторите нужную команду.');
    const ownedCommands = commands.forAccount(ticket.accountId);
    const current = ownedCommands[0];
    if (current && current.sequence > ticket.sequence) {
      pending.delete(ticket.token);
      throw fail(409, 'Эту команду заменила новая. Повторите нужную команду.');
    }
    // Admission failure cannot invalidate any previously accepted command/dialogue.
    commands.assertCapacity(ownedCommands.length);
    retireAccepted(ticket.accountId);
    // A dispatch fences older candidates, but a newer request may still be in admission.
    invalidatePending(ticket.accountId, ticket.sequence);
    commands.set(ticket.key, {
      token: ticket.token,
      accountId: ticket.accountId,
      sessionId: ticket.sessionId,
      sequence: ticket.sequence,
      expiresAt: ticket.expiresAt,
    });
    return ticket;
  }
  function abandonCommand(ticket) {
    if (ticket && pending.get(ticket.token) === ticket) pending.delete(ticket.token);
  }
  function beginCommand(c, member, state) {
    const ticket = prepareCommand(c, member, state);
    try {
      return acceptCommand(ticket);
    } finally {
      abandonCommand(ticket);
    }
  }
  function assertCommand(ticket) {
    sweep();
    if (!ticket || commands.get(ticket.key)?.token !== ticket.token)
      throw fail(409, 'Эту команду заменила новая. Повторите нужную команду.');
  }
  function create(c, member, state, ticket, data) {
    if (ticket?.key !== identity(c, member, state.revision))
      throw fail(409, 'Доступ к команде изменился. Начните новую команду.');
    assertCommand(ticket);
    isolated.fence(() => assertCommand(ticket));
    const entry = {
      id: randomUUID(),
      identity: identity(c, member, state.revision),
      accountId: c.current.accountId,
      sessionId: c.current.sessionId,
      expiresAt: Math.min(now() + TTL_MS, c.current.expiresAt || Infinity),
      version: 0,
      turns: 0,
      data,
      options: new Map(),
      response: null,
    };
    isolated.set(entry.id, entry);
    return entry;
  }
  function get(c, member, state, id) {
    sweep();
    const entry = isolated.get(id);
    if (!entry || entry.identity !== identity(c, member, state.revision))
      throw fail(409, 'Диалог истёк или доступ изменился. Начните новую команду.');
    return entry;
  }
  function fingerprint(body) {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }
  return {
    runIsolated: isolated.run,
    assertIsolated: isolated.check,
    discardIsolated: isolated.discard,
    assertCandidate(ticket) {
      sweep();
      if (pending.get(ticket?.token) !== ticket) assertCommand(ticket);
    },
    prepareCommand,
    acceptCommand,
    abandonCommand,
    beginCommand,
    assertCommand,
    create,
    get,
    fingerprint,
    clearAccount,
    invalidatePending,
    remove(id) {
      const entry = isolated.get(id);
      if (entry) invalidatePending(entry.accountId);
      isolated.delete(id);
    },
    clearSession(sessionId) {
      entries.clearSession(sessionId);
      commands.clearSession(sessionId);
      pending.clearSession(sessionId);
    },
    stats() {
      sweep();
      return { dialogues: entries.stats(), commands: commands.stats(), pending: pending.stats() };
    },
  };
}
module.exports = { createDialogueStore, TTL_MS, MAX_DIALOGUES };
