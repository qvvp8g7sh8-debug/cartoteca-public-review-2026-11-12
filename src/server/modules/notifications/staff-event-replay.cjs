const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const journal = require('./appointment-event-journal.cjs');
const { replayStaffAppointmentEvents } = require('./staff-appointment-events.cjs');
const { channelEnabled } = require('./staff-event-preferences.cjs');
function createStaffEventReplay({
  platform,
  tenantStore,
  store,
  clock = Date.now,
  channel = 'telegram',
}) {
  let cursor = '',
    nextAt = 0,
    error = '';
  function replayOne(org, signal, canRun) {
    if (store.hasAppointmentRecipients?.(org) === false) return;
    const storage = tenantStore(org),
      nested = store.inTransaction();
    // An empty durable journal is a read-only negative hint. A concurrent append
    // stays durable for the next sweep; positive work is reread and authorized
    // under the original platform -> cabinet transaction below.
    if (
      !nested &&
      !storage.transaction(
        () => journal.pending(storage, clock(), 'staff').length > 0,
        storage.db?.dialect === 'postgres' ? 'READONLY' : 'DEFERRED',
      )
    )
      return;
    const deliver = () =>
      storage.transaction(
        () => replayStaffAppointmentEvents(platform, org, storage, clock()),
        'DEFERRED',
      );
    const accepted = nested
      ? deliver()
      : compoundMutation(platform, storage, org, 'journal', deliver);
    if (nested || signal?.aborted || !canRun() || !accepted.length) return;
    // Platform COMMIT already succeeded. Retire by ID under a fresh cabinet lock;
    // another worker may have appended new entries between these transactions.
    storage.transaction(() => journal.retire(storage, accepted, clock()));
  }
  const replay = (signal, canRun = () => true) => {
    if (
      !tenantStore ||
      clock() < nextAt ||
      typeof store?.organizationPage !== 'function' ||
      typeof platform.withWriteLock !== 'function' ||
      signal?.aborted ||
      !canRun()
    )
      return;
    if (!channelEnabled(platform, channel)) {
      nextAt = clock() + 5000; // Negative discovery only; every later send still checks fresh authority.
      return;
    }
    const page = store.organizationPage(cursor, 5);
    cursor = page.cursor;
    nextAt = clock() + (cursor ? 250 : 15000);
    let failed = false;
    for (const org of page.organizations) {
      if (signal?.aborted || !canRun() || !channelEnabled(platform, channel)) return;
      try {
        replayOne(org, signal, canRun);
      } catch {
        // The durable cabinet entry stays for a later sweep. A failed tenant
        // must not prevent healthy tenants or already queued messages running.
        failed = true;
      }
    }
    error = failed ? 'Не удалось восстановить часть уведомлений об изменениях записей.' : '';
  };
  replay.batched = async (
    signal,
    canRun = () => true,
    runBackgroundWork = (callback) => callback(),
  ) => {
    const lifetime = () => !signal?.aborted && canRun();
    const active = () => lifetime() && channelEnabled(platform, channel);
    if (
      !tenantStore ||
      clock() < nextAt ||
      !lifetime() ||
      typeof store?.organizationPage !== 'function' ||
      typeof platform.withWriteLock !== 'function'
    )
      return;
    if (!channelEnabled(platform, channel)) {
      nextAt = clock() + 5000;
      return;
    }
    const discovery = runBackgroundWork(
      () => (active() ? store.organizationPage(cursor, 5) : null),
      '',
      lifetime,
    );
    const page = discovery && typeof discovery.then === 'function' ? await discovery : discovery;
    if (!page || !active()) return;
    cursor = page.cursor;
    nextAt = clock() + (cursor ? 250 : 15000);
    let failed = false;
    for (const org of page.organizations) {
      if (!active()) return;
      try {
        const pending = runBackgroundWork(
          () => {
            if (active()) replayOne(org, signal, canRun);
          },
          org,
          lifetime,
        );
        if (pending && typeof pending.then === 'function') await pending;
      } catch {
        failed = true; // Durable journal stays for a later fair sweep.
      }
    }
    error = failed ? 'Не удалось восстановить часть уведомлений об изменениях записей.' : '';
  };
  replay.status = () => ({ error });
  return replay;
}
module.exports = { createStaffEventReplay };
