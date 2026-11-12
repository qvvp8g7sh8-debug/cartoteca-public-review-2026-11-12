const { randomBytes, createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { spokenReply, speechChunks, handoffText } = require('./spoken-reply.cjs');
const { createDialogueRegistry } = require('../dialogue/dialogue-registry.cjs');
const TTL_MS = 10 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
function createSpeechPermits({ now = Date.now, capacity = 512 } = {}) {
  const entries = createDialogueRegistry({
    now,
    capacity,
    // Admission happens before the model/business action. Issuing a response
    // replaces this operation's existing slot and cannot fail for capacity.
    capacityError: () =>
      Object.assign(
        fail(503, 'Не удалось подготовить озвучивание ответа. Проверьте результат на экране.'),
        { code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY', retryAfter: 2, outcomeUnknown: false },
      ),
  });
  let reserved = 0;
  const identity = (c, ticket, revision) =>
    hash(
      JSON.stringify([
        c.current.organizationId,
        c.current.accountId,
        c.current.sessionId,
        c.current.role,
        ticket.id,
        ticket.grantId,
        ticket.attempt,
        revision,
      ]),
    );
  const actor = (c, revision) =>
    JSON.stringify([
      c.current.organizationId,
      c.current.accountId,
      c.current.sessionId,
      c.current.role,
      revision,
    ]);
  function reserve(c, revision) {
    entries.sweep();
    entries.assertSessionCapacity(c.current.sessionId, 32);
    const reservation = Object.freeze({ token: randomBytes(32).toString('base64url') });
    entries.set(reservation.token, {
      reservation,
      actor: actor(c, revision),
      sessionId: c.current.sessionId,
      accountId: c.current.accountId,
      // An admitted operation owns this slot through its finally. A long await
      // cannot expire it between a successful business commit and permit issue.
      expiresAt: Infinity,
    });
    reserved++;
    return reservation;
  }
  function release(reservation) {
    if (reservation && entries.get(reservation.token)?.reservation === reservation) {
      entries.delete(reservation.token);
      reserved--;
    }
  }
  function issue(c, ticket, response, limit, reservation) {
    const owned = reservation || reserve(c, response.policyVersion);
    const entry = entries.get(owned.token);
    if (!entry || entry.reservation !== owned || entry.actor !== actor(c, response.policyVersion))
      throw Object.assign(fail(403, 'Доступ к озвучиванию ответа изменился.'), {
        code: 'ASSISTANT_SPEECH_PROOF_REQUIRED',
      });
    try {
      const permit = {
        token: owned.token,
        answerableText: spokenReply(response, true),
        readonlyText: spokenReply(response, false),
        handoffText: handoffText(response),
      };
      const hashes = new Set();
      for (const text of [permit.answerableText, permit.readonlyText, permit.handoffText]) {
        if (!text || text.length > 16000) continue;
        hashes.add(hash(text.trim()));
        for (const chunk of speechChunks(text, limit)) hashes.add(hash(chunk));
      }
      entries.set(permit.token, {
        identity: identity(c, ticket, response.policyVersion),
        hashes,
        sessionId: c.current.sessionId,
        accountId: c.current.accountId,
        expiresAt: Math.min(now() + TTL_MS, c.current.expiresAt || Infinity),
      });
      reserved--;
      return permit;
    } finally {
      release(owned);
    }
  }
  function requirePermit(c, ticket, body) {
    entries.sweep();
    const entry = typeof body.speechToken === 'string' && entries.get(body.speechToken);
    if (
      !entry ||
      entry.reservation ||
      entry.identity !== identity(c, ticket, body.policyVersion) ||
      typeof body.text !== 'string' ||
      !entry.hashes.has(hash(body.text.trim()))
    )
      throw Object.assign(fail(403, 'Можно озвучить только текущий ответ помощника.'), {
        code: 'ASSISTANT_SPEECH_PROOF_REQUIRED',
      });
  }
  return {
    issue,
    reserve,
    release,
    requirePermit,
    clearSession(id) {
      reserved -= entries.forSession(id).filter((entry) => entry.reservation).length;
      entries.clearSession(id);
    },
    clearAccount(id) {
      reserved -= entries.forAccount(id).filter((entry) => entry.reservation).length;
      entries.clearAccount(id);
    },
    stats() {
      entries.sweep();
      const result = entries.stats();
      return { ...result, reserved, issued: result.active - reserved };
    },
  };
}
module.exports = { createSpeechPermits };
