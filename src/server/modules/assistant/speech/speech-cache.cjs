const { createHash } = require('node:crypto');
const { speechEncoding } = require('./pcm-audio.cjs');
// Deliberately exact: arbitrary replies, names, dates and user speech never enter this cache.
const { GENERIC_QUESTIONS, cacheableGenericSpeech } = require('./generic-responses.cjs');
const MAX_BYTES = 2 * 1024 * 1024;
function createSpeechCache({ now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    bytes -= entry.bytes?.length || 0;
  }
  function touch(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    entries.set(key, entry);
  }
  function makeRoom(requiredBytes = 0, requiredEntries = 0, keep) {
    for (const [key, entry] of entries) {
      if (entries.size + requiredEntries <= 24 && bytes + requiredBytes <= MAX_BYTES) return true;
      // Never detach an in-flight generation or its coalesced followers.
      if (entry.done && entry !== keep) remove(key, entry);
    }
    return entries.size + requiredEntries <= 24 && bytes + requiredBytes <= MAX_BYTES;
  }
  function claimFor(entry, owner) {
    return {
      owner,
      promise: entry.promise,
      get generation() {
        return entry.generation;
      },
    };
  }
  return {
    claim(state, organizationId, text, format = 'mp3') {
      const encoding = speechEncoding(format);
      if (!cacheableGenericSpeech(text)) return null;
      for (const [key, entry] of entries)
        if (entry.expiresAt <= now() && entry.done) remove(key, entry);
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            organizationId,
            state.revision,
            state.providers.tts,
            state.credentials.timeweb,
            state.policy.limits,
            state.rates,
            encoding,
            text,
          ]),
        )
        .digest('base64url');
      const existing = entries.get(key);
      if (existing) {
        if (existing.done) touch(key, existing);
        return claimFor(existing, false);
      }
      if (!makeRoom(0, 1)) return null;
      let resolve;
      const entry = {
        promise: new Promise((r) => {
          resolve = r;
        }),
        done: false,
        generation: null,
      };
      entries.set(key, entry);
      return Object.assign(claimFor(entry, true), {
        bindGeneration(generation) {
          if (!entry.done && entries.get(key) === entry && !entry.generation)
            entry.generation = generation;
        },
        finish(buffer) {
          if (entry.done) return;
          entry.done = true;
          entry.generation = null;
          entry.expiresAt = now() + 15 * 60 * 1000;
          if (buffer.length <= 256 * 1024 && makeRoom(buffer.length, 0, entry)) {
            entry.bytes = buffer;
            bytes += buffer.length;
            touch(key, entry);
          } else remove(key, entry);
          resolve({ bytes: buffer });
        },
        fail(error) {
          if (entry.done) return;
          entry.done = true;
          entry.generation = null;
          remove(key, entry);
          resolve({ error });
        },
      });
    },
  };
}
module.exports = { createSpeechCache, GENERIC_QUESTIONS };
