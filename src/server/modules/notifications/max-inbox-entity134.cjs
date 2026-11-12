const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { maxId } = require('./max-adapter.cjs');
const { LEASE_MS } = require('./max-runtime-lease.cjs');
const { statements, terminalPurge } = require('../../infrastructure/postgres/max-inbox-sql134.cjs');
// Closed operational scopes, not organizations: an accepted MAX event may not
// identify its cabinet yet. Only acceptance increases the protected capacities.
function createMaxInboxEntities(c, botHash) {
  const { db, open, seal, limitKey, entityQueueTransaction } = c;
  const prepared = Object.fromEntries(
    Object.entries(statements).map(([name, entry]) => [name, db.prepare(entry.sql)]),
  );
  const decode = (row) => (row ? { ...row, decoded: open(row.value) } : null);
  const transact = (kind, key, work, botKey) =>
    entityQueueTransaction(work, {
      domain: 'max-inbox',
      kind,
      key,
      ...(botKey ? { botHash: botKey } : {}),
    });
  const bot = (key, work) => transact('bot', key, work);
  const event = (row, work) => transact('event', row.id, work, row.bot_hash);
  const current = (key, owner, until, now) => {
    const row = db
      .prepare('SELECT owner,lease_until FROM max_runtime_leases WHERE bot_hash=?')
      .get(key);
    return !!row && row.owner === owner && row.lease_until === until && row.lease_until > now;
  };
  function purge(rows, now) {
    if (!rows.length) return;
    db.prepare(terminalPurge(rows.length).sql).run(
      ...rows.flatMap((row) => [row.id, row.status, row.expires_at]),
      now,
    );
  }
  function accept(botId, incoming, now) {
    const serialized = JSON.stringify(incoming),
      key =
        incoming.update_type === 'message_callback'
          ? [maxId(botId), incoming.update_type, incoming.callback.callback_id]
          : [
              maxId(botId),
              incoming.update_type,
              incoming.timestamp,
              incoming.user.user_id,
              incoming.payload || '',
            ];
    const eventHash = limitKey('max-inbox-event', JSON.stringify(key));
    const contentHash = limitKey('max-inbox-content', serialized),
      botKey = botHash(botId);
    return transact('admission', botKey, () => {
      purge(
        db
          .prepare(
            "SELECT id,status,expires_at FROM max_event_inbox WHERE status IN ('done','failed') AND expires_at<=? ORDER BY expires_at,id LIMIT 64",
          )
          .all(now),
        now,
      );
      const read = db.prepare('SELECT * FROM max_event_inbox WHERE event_hash=?');
      let prior = read.get(eventHash);
      // Retention expiry must precede payload-conflict checking, even if the
      // bounded global page has not reached this particular duplicate yet.
      if (prior && ['done', 'failed'].includes(prior.status) && prior.expires_at <= now) {
        purge([prior], now);
        prior = read.get(eventHash);
      }
      if (prior) {
        if (open(prior.value).contentHash !== contentHash)
          throw fail(409, 'Содержимое события MAX изменилось.');
        return { repeated: true };
      }
      if (
        db.prepare('SELECT count(*) n FROM max_event_inbox').get().n >= 20000 ||
        db
          .prepare(
            "SELECT count(*) n FROM max_event_inbox WHERE status IN ('pending','processing')",
          )
          .get().n >= 5000 ||
        db
          .prepare('SELECT count(*) n FROM max_event_inbox WHERE bot_hash=? AND created_at>?')
          .get(botKey, now - 60000).n >= 600
      )
        throw fail(429, 'Очередь MAX заполнена. Повторите доставку позже.');
      prepared.insert.run(
        crypto.randomUUID(),
        botKey,
        eventHash,
        seal({ event: incoming, contentHash }),
        now,
        now,
        now + 7 * 86400000,
      );
      return { repeated: false };
    });
  }
  function claim(botId, now, authority = null) {
    const botKey = botHash(botId);
    const candidate = db.prepare(
      "SELECT id,bot_hash FROM max_event_inbox WHERE bot_hash=? AND ((status='pending' AND next_at<=?) OR (status='processing' AND lease_until<=?)) ORDER BY created_at,id LIMIT 1",
    );
    // A bounded number of expired/exhausted heads is retired one event at a
    // time. No processor scans or updates another bot's event state.
    for (let visit = 0; visit < 64; visit++) {
      const head = candidate.get(botKey, now, now);
      if (!head) return null;
      const outcome = event(head, () => {
        if (authority && !current(botKey, authority.owner, authority.until, now))
          return { denied: true };
        let row = db
          .prepare('SELECT * FROM max_event_inbox WHERE id=? AND bot_hash=?')
          .get(head.id, botKey);
        if (
          !row ||
          !['pending', 'processing'].includes(row.status) ||
          (row.status === 'processing' && row.lease_until > now)
        )
          return {};
        if (row.expires_at <= now || row.attempt >= 10) {
          prepared.fail.run(
            row.id,
            botKey,
            row.status,
            row.attempt,
            row.lease_until,
            row.lease_id,
            now,
            now,
          );
          return {};
        }
        if (row.status === 'processing') {
          if (
            !prepared.recover.run(row.id, botKey, row.attempt, row.lease_until, row.lease_id, now)
              .changes
          )
            return {};
          row = { ...row, status: 'pending', lease_until: 0, lease_id: null };
        }
        if (row.next_at > now) return {};
        const lease = crypto.randomUUID(),
          until = now + 120000;
        const changed = prepared.claim.run(
          until,
          lease,
          row.id,
          botKey,
          row.attempt,
          row.lease_until,
          row.lease_id,
          now,
          now,
        ).changes;
        return changed
          ? {
              row: decode({
                ...row,
                status: 'processing',
                attempt: row.attempt + 1,
                lease_until: until,
                lease_id: lease,
              }),
            }
          : {};
      });
      if (outcome.denied) return null;
      if (outcome.row) return outcome.row;
    }
    return null;
  }
  function saveResult(row, result) {
    const value = {
      ...row.decoded,
      result: {
        ...(result.callbackId
          ? { callbackId: result.callbackId, notification: result.notification }
          : {}),
      },
    };
    const changed = event(
      row,
      () =>
        prepared.save.run(
          seal(value),
          row.id,
          row.bot_hash,
          row.lease_id,
          row.lease_until,
          row.attempt,
        ).changes,
    );
    if (changed) row.decoded = value;
    return !!changed;
  }
  return {
    accept,
    claim,
    saveResult,
    acquire(botId, owner, now) {
      const key = botHash(botId);
      return !!bot(key, () => prepared.acquire.run(key, owner, now + LEASE_MS, now).changes);
    },
    renew(botId, owner, expectedUntil, now) {
      const key = botHash(botId);
      return !!bot(
        key,
        () => prepared.renew.run(now + LEASE_MS, key, owner, expectedUntil, now).changes,
      );
    },
    release(botId, owner) {
      const key = botHash(botId);
      return bot(key, () => prepared.release.run(key, owner));
    },
    finish(row, status, nextAt = 0) {
      return !!event(
        row,
        () =>
          prepared.finish.run(
            status,
            nextAt,
            row.id,
            row.bot_hash,
            row.lease_id,
            row.lease_until,
            row.attempt,
          ).changes,
      );
    },
    defer(row, nextAt) {
      return !!event(
        row,
        () =>
          prepared.defer.run(
            nextAt,
            row.id,
            row.bot_hash,
            row.lease_id,
            row.lease_until,
            row.attempt,
          ).changes,
      );
    },
  };
}
module.exports = { createMaxInboxEntities };
