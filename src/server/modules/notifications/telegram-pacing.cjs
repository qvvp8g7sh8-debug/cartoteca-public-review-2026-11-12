const { setTimeout: sleep } = require('node:timers/promises');

// One leader owns all outgoing messages for this bot, including command replies.
function createTelegramPacing({ clock = Date.now, wait = sleep } = {}) {
  let next = 0;
  const chats = new Map();
  const delivering = new Set();
  function readyAt(chat) {
    return Math.max(next, chats.get(String(chat)) || 0);
  }
  function reserve(chat) {
    const now = clock();
    if (readyAt(chat) > now) return false;
    if (chats.size >= 10000) {
      for (const [key, until] of chats) if (until <= now) chats.delete(key);
    }
    next = now + 100;
    chats.set(String(chat), now + 1000);
    return true;
  }
  function pause(seconds) {
    const value = Number(seconds);
    next = Math.max(next, clock() + (Number.isFinite(value) && value > 0 ? value : 30) * 1000);
  }
  const remaining = (chat) => Math.max(0, readyAt(chat) - clock());
  async function acquire(chat, signal, maxWait = Infinity) {
    const deadline = clock() + maxWait;
    for (;;) {
      signal?.throwIfAborted();
      if (reserve(chat)) return true;
      if (readyAt(chat) > deadline) return false;
      await wait(Math.min(1000, Math.max(1, remaining(chat))), undefined, { signal });
    }
  }
  async function acquireDelivery(chat, signal, maxWait = Infinity) {
    signal?.throwIfAborted();
    const key = String(chat);
    if (delivering.has(key)) return false;
    delivering.add(key);
    try {
      if (await acquire(chat, signal, maxWait)) return true;
    } catch (error) {
      delivering.delete(key);
      throw error;
    }
    delivering.delete(key);
    return false;
  }
  return {
    readyAt,
    reserve,
    pause,
    remaining,
    acquire,
    acquireDelivery,
    releaseDelivery: (chat) => delivering.delete(String(chat)),
  };
}
module.exports = { createTelegramPacing };
