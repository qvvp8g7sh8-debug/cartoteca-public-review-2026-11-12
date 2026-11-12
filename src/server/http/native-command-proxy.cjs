const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { fail } = require('../../shared/errors.cjs');
const { createNativeProxy } = require('./native-proxy.cjs');
const { commandNotStarted } = require('../infrastructure/native-command-outcome151.cjs');
const {
  commandRetainedFloor,
  commandRetainedLimit,
} = require('../infrastructure/native-command-ticket.cjs');
const { AbortController } = globalThis;
// One bounded queue owns admission; an admitted request is forwarded exactly once
// to a free owner. Neither failures nor uncertain outcomes select another owner.
function createNativeCommandProxy({
  endpoint,
  reserve,
  ownerCount = 2,
  workBudget = null,
  physicalClosed = null,
  waitMs = 5000,
  timeoutMs = 120000,
  now = () => performance.now(),
  createProxy = createNativeProxy,
}) {
  if (
    typeof endpoint !== 'function' ||
    typeof reserve !== 'function' ||
    !Number.isSafeInteger(ownerCount) ||
    ownerCount < 1 ||
    ownerCount > 4 ||
    (ownerCount > 2 && workBudget === null) ||
    (workBudget !== null &&
      (typeof workBudget.acquire !== 'function' ||
        !Number.isSafeInteger(workBudget.waitMs) ||
        workBudget.waitMs < 1 ||
        workBudget.waitMs > 5000)) ||
    (physicalClosed !== null && typeof physicalClosed !== 'function') ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 1 ||
    waitMs > 5000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw Error('Invalid native command proxy bounds.');
  const pendingLimit = 16,
    waiting = [];
  const slots = Array.from({ length: ownerCount }, (_, index) => {
    const slot = { index, busy: false, ticket: null };
    slot.proxy = createProxy({
      endpoint: () => ({ ...endpoint(index), commandTicket: slot.ticket }),
      activeLimit: 1,
      pendingLimit: 0,
      waitMs,
      timeoutMs,
    });
    return slot;
  });
  let closed = false;
  function cleanup(entry) {
    clearTimeout(entry.timer);
    if (entry.cancel) {
      entry.req.removeListener('aborted', entry.cancel);
      entry.req.removeListener('error', entry.cancel);
      entry.res.removeListener('close', entry.cancel);
    }
  }
  function rejectWaiting(entry, error) {
    const index = waiting.indexOf(entry);
    if (index < 0) return;
    waiting.splice(index, 1);
    cleanup(entry);
    entry.workAbort?.abort();
    entry.workLease?.release();
    entry.reject(commandNotStarted(error));
    advance();
  }
  function start(entry, slot) {
    cleanup(entry);
    if (entry.req.aborted || entry.res.destroyed) {
      entry.workLease?.release();
      return entry.reject(fail(499, 'Запрос отменён.'));
    }
    slot.scope = entry.scope;
    slot.busy = true;
    slot.ticket = randomUUID();
    let lease;
    try {
      lease = reserve(slot.index, slot.ticket);
    } catch (error) {
      slot.busy = false;
      slot.scope = null;
      slot.ticket = null;
      entry.workLease?.release();
      entry.reject(commandNotStarted(error));
      advance();
      return;
    }
    const transport = async () => {
      let timer,
        forwarded = false;
      const cancel = () => lease.cancel();
      entry.req.once('aborted', cancel);
      entry.req.once('error', cancel);
      entry.res.once('close', cancel);
      try {
        await Promise.race([
          lease.ready,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(fail(504, 'Время ожидания истекло. Проверьте результат операции.')),
              workBudget ? Math.max(1, Math.ceil(entry.deadline - now())) : waitMs,
            );
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        entry.req.removeListener('aborted', cancel);
        entry.req.removeListener('error', cancel);
        entry.res.removeListener('close', cancel);
        if (entry.req.aborted || entry.res.destroyed) throw fail(499, 'Запрос отменён.');
        forwarded = true;
        return await slot.proxy.run(entry.req, entry.res);
      } catch (error) {
        lease.cancel();
        throw forwarded ? error : commandNotStarted(error);
      } finally {
        clearTimeout(timer);
        entry.req.removeListener('aborted', cancel);
        entry.req.removeListener('error', cancel);
        entry.res.removeListener('close', cancel);
      }
    };
    let physicalSettled = !workBudget;
    // Physical completion can precede a slow HTTP drain. Only the private owner
    // ACK may reduce working memory; the owner itself stays busy until both end.
    const completion = Promise.resolve(lease.completed).then((report) => {
      physicalSettled = true;
      const bytes = report?.retainedBytes;
      if (
        workBudget &&
        Number.isSafeInteger(bytes) &&
        bytes >= commandRetainedFloor &&
        bytes <= commandRetainedLimit
      )
        entry.workLease?.reduceTo?.(bytes);
    });
    completion.catch(() => {});
    transport()
      .then(entry.resolve, entry.reject)
      .then(async () => {
        try {
          await completion;
        } catch {
          // An owner may reject completion while shutdown is still in progress.
          // Only its successful physical-close promise can settle that case.
          if (workBudget && physicalClosed) {
            try {
              await physicalClosed();
              physicalSettled = true;
            } catch {}
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!physicalSettled) return;
        entry.workLease?.release();
        slot.busy = false;
        slot.scope = null;
        slot.ticket = null;
        advance();
      });
  }
  function acquireWork(entry) {
    entry.workAbort = new AbortController();
    entry.workPending = true;
    let admission;
    try {
      const exclusive = entry.req.method === 'PUT' || entry.req.method === 'PATCH';
      admission = workBudget.acquire(exclusive ? 'command-exclusive' : 'command', {
        signal: entry.workAbort.signal,
        timeoutMs: Math.max(1, Math.ceil(entry.deadline - now())),
      });
    } catch (error) {
      rejectWaiting(entry, error);
      return;
    }
    Promise.resolve(admission).then(
      (lease) => {
        if (!waiting.includes(entry)) return lease.release();
        entry.workLease = lease;
        entry.workPending = false;
        advance();
      },
      (error) => {
        rejectWaiting(entry, error);
        advance();
      },
    );
  }
  function advance() {
    while (!closed && waiting.length) {
      const slot = slots.find((candidate) => !candidate.busy);
      if (!slot) return;
      // The scope header schedules work only; it never supplies authorization.
      // Preserve one cabinet's order while another cabinet can use a free owner.
      const eligible = (entry) =>
        !slots.some((candidate) => candidate.busy && candidate.scope === entry.scope);
      // An already acquired lease must reach an owner before a follower can
      // wait for its memory. Otherwise scope bypass could strand the lease.
      const reserved = waiting.findIndex((entry) => eligible(entry) && entry.workLease);
      const index = reserved >= 0 ? reserved : waiting.findIndex(eligible);
      if (index < 0) return;
      const entry = waiting[index];
      if (now() >= entry.deadline) {
        waiting.splice(index, 1);
        cleanup(entry);
        entry.workAbort?.abort();
        entry.workLease?.release();
        entry.reject(commandNotStarted(fail(503, 'Сервер временно занят. Повторите запрос.')));
      } else if (workBudget && !entry.workLease) {
        // Owner FIFO comes first: a request waiting for a busy command owner
        // must not consume transient memory needed by an executable query.
        if (!entry.workPending) acquireWork(entry);
        return;
      } else {
        waiting.splice(index, 1);
        start(entry, slot);
      }
    }
  }
  return {
    run(req, res) {
      req.pause();
      return new Promise((resolve, reject) => {
        if (closed) return reject(commandNotStarted(fail(503, 'Сервер останавливается.')));
        if (req.aborted || res.destroyed) return reject(fail(499, 'Запрос отменён.'));
        const admissionWaitMs = Math.min(waitMs, workBudget?.waitMs ?? waitMs);
        const header = req.headers?.['x-cartoteca-organization-id'];
        const scope =
          typeof header === 'string' && header.length <= 120 ? header : Symbol('unscoped');
        const entry = { req, res, resolve, reject, scope, deadline: now() + admissionWaitMs };
        const slot = slots.find((candidate) => !candidate.busy);
        if (
          !workBudget &&
          slot &&
          waiting.length === 0 &&
          !slots.some((candidate) => candidate.busy && candidate.scope === entry.scope)
        )
          return start(entry, slot);
        if (waiting.length >= pendingLimit)
          return reject(commandNotStarted(fail(503, 'Сервер временно занят.')));
        entry.cancel = () => rejectWaiting(entry, fail(499, 'Запрос отменён.'));
        req.once('aborted', entry.cancel);
        req.once('error', entry.cancel);
        res.once('close', entry.cancel);
        entry.timer = setTimeout(
          () => rejectWaiting(entry, fail(503, 'Сервер временно занят. Повторите запрос.')),
          admissionWaitMs,
        );
        entry.timer.unref?.();
        waiting.push(entry);
        advance();
      });
    },
    close() {
      closed = true;
      for (const entry of waiting.splice(0)) {
        cleanup(entry);
        entry.workAbort?.abort();
        entry.workLease?.release();
        entry.reject(commandNotStarted(fail(503, 'Сервер останавливается.')));
      }
      for (const slot of slots) slot.proxy.close();
    },
    stats: () => ({
      active: slots.filter((slot) => slot.busy).length,
      pending: waiting.length,
      activeLimit: ownerCount,
      pendingLimit,
      ...(workBudget ? { workPending: waiting.filter((entry) => entry.workPending).length } : {}),
      owners: slots.map((slot) => slot.proxy.stats()),
    }),
  };
}
module.exports = { createNativeCommandProxy };
