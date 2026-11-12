const { randomBytes, createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { speechEncoding } = require('./pcm-audio.cjs');
const { createDialogueRegistry } = require('../dialogue/dialogue-registry.cjs');
const TTL_MS = 30000;
function speechIdentity(c, state, member, format = 'mp3') {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.current.accountId,
        c.current.organizationId,
        c.current.sessionId,
        c.current.role,
        member.membershipId,
        state.revision,
        state.providers.tts,
        state.credentials.timeweb,
        speechEncoding(format),
      ]),
    )
    .digest('base64url');
}
function createSpeechTickets({ now = Date.now, capacity = 128 } = {}) {
  const entries = createDialogueRegistry({
    now,
    capacity,
    capacityError: () =>
      Object.assign(fail(503, 'Озвучивание занято. Повторите ответ немного позже.'), {
        code: 'ASSISTANT_SPEECH_TICKET_CAPACITY',
        retryAfter: 2,
        outcomeUnknown: false,
      }),
  });
  const turns = createDialogueRegistry({ now, capacity: 512 });
  const api = {
    issue(c, state, member, text, format = 'mp3', proof) {
      speechEncoding(format);
      entries.sweep();
      entries.assertSessionCapacity(c.current.sessionId, 4);
      const id = randomBytes(32).toString('base64url');
      entries.set(id, {
        identity: speechIdentity(c, state, member, format),
        format,
        text,
        ...(proof ? { proof: { ...proof } } : {}),
        version: state.revision,
        accountId: c.current.accountId,
        sessionId: c.current.sessionId,
        expiresAt: Math.min(now() + TTL_MS, c.current.expiresAt || Infinity),
      });
      return (
        '/api/assistant/speak-audio?ticket=' +
        id +
        '&accountContext=' +
        encodeURIComponent(c.current.accountId || '') +
        '&organizationContext=' +
        encodeURIComponent(c.current.organizationId || '')
      );
    },
    take(c, id, scope) {
      entries.sweep();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id))
        throw fail(400, 'Некорректный запрос озвучивания.');
      const entry = entries.get(id);
      if (!entry) throw fail(410, 'Озвучивание истекло. Повторите ответ.');
      const fresh = scope(c, entry.version);
      if (speechIdentity(c, fresh.state, fresh.member, entry.format) !== entry.identity)
        throw fail(403, 'Озвучивание недоступно этой сессии.');
      entries.delete(id);
      return { ...fresh, ticket: entry };
    },
    issueTurn(c, state, member, text, proof, dialogue) {
      turns.sweep();
      entries.sweep();
      const sessionId = c.current.sessionId;
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            speechIdentity(c, state, member, 'pcm'),
            proof.taskRequestId,
            dialogue?.id,
            dialogue?.version,
            'answerable',
            state.revision,
            text,
          ]),
        )
        .digest('hex');
      const previous = turns.get(key);
      if (previous) {
        if (!entries.get(previous.id)) return { replay: true };
        return { streamUrl: previous.streamUrl, expiresAt: previous.ticketExpiresAt };
      }
      turns.assertSessionCapacity(sessionId, 32);
      turns.assertCapacity();
      api.discardTurn(sessionId);
      const streamUrl = api.issue(c, state, member, text, 'pcm', proof);
      const id = new URL(streamUrl, 'https://assistant.invalid').searchParams.get('ticket');
      const ticketExpiresAt = entries.get(id).expiresAt;
      try {
        turns.set(key, {
          key,
          id,
          streamUrl,
          ticketExpiresAt,
          accountId: c.current.accountId,
          sessionId,
          // Remember consumed/expired preparation through the permit lifetime.
          expiresAt: Math.min(now() + 10 * 60 * 1000, c.current.expiresAt || Infinity),
        });
      } catch (error) {
        entries.delete(id);
        throw error;
      }
      // Only pre-issued turn tickets are superseded; ordinary POST tickets stay valid.
      for (const old of turns.forSession(sessionId)) if (old.id !== id) entries.delete(old.id);
      return { streamUrl, expiresAt: ticketExpiresAt };
    },
    discardTurn(sessionId) {
      for (const turn of turns.forSession(sessionId)) entries.delete(turn.id);
    },
    clearSession(id) {
      entries.clearSession(id);
      turns.clearSession(id);
    },
    clearAccount(id) {
      entries.clearAccount(id);
      turns.clearAccount(id);
    },
    stats() {
      entries.sweep();
      return entries.stats();
    },
  };
  return api;
}
module.exports = { createSpeechTickets, speechIdentity };
