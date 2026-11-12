const { performance } = require('node:perf_hooks');
const { fail } = require('../../../shared/errors.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fingerprint } = require('../notifications/appointments.cjs');
const { assertChange } = require('./mutation-policy.cjs');
const { writeCabinetMutation } = require('./mutation-write.cjs');
const { readReceipt, writeReceipt } = require('../../infrastructure/mutation-receipts.cjs');

// Conservative subset whose existing platform effects are all NO-OPs. Never
// postpone a confirmation, cancel, push, or dirty marker across a commit gap.
function hasNoPlatformEffects(platform, org, before, next) {
  if (platform.notificationSchedule && platform.notificationSchedule.enabled !== false)
    return false;
  const zone = platform.organizationTimeZone(org);
  const prior = new Map(
    before.patients.flatMap((p) => p.appointments.map((a) => [a.id, { p, a }])),
  );
  for (const p of next.patients)
    for (const a of p.appointments) {
      const old = prior.get(a.id);
      if (
        !old ||
        old.p.id !== p.id ||
        !isActiveAppointment(a) ||
        isActiveAppointment(old.a) !== isActiveAppointment(a) ||
        fingerprint(old.a, zone) !== fingerprint(a, zone) ||
        platform.appointmentConfirmations.stamp(old.a, zone) !==
          platform.appointmentConfirmations.stamp(a, zone)
      )
        return false;
      prior.delete(a.id);
    }
  return prior.size === 0;
}
async function trySharedMutation(context, input) {
  const { platform, current, token } = context;
  const {
    storage,
    initial,
    next,
    build,
    read,
    partial,
    trustedCommit,
    identity,
    acknowledgement,
    changedIds,
    normalizedImages,
    preparedWrite,
    receiptBody,
    appointmentOnly,
  } = input;
  if (
    !platform.withSharedCabinetCommit ||
    trustedCommit ||
    !hasNoPlatformEffects(platform, current.organizationId, initial, next)
  )
    return null;
  const started = performance.now();
  let acquired = false;
  context.recordStage?.('save-shared-lock');
  try {
    return await platform.withSharedCabinetCommit(
      () => {
        acquired = true;
        context.recordTiming?.('save-shared-lock-wait', performance.now() - started);
        return storage.transaction(
          () => {
            context.recordStage?.('save-shared-revalidation');
            const fresh = context.assertCurrent() || platform.session(token);
            if (!fresh) throw fail(401, 'Войдите в картотеку.');
            const replay =
              identity &&
              readReceipt(storage, fresh, identity.id, identity.hash, { appointmentOnly });
            if (replay) return { saved: replay.saved };
            const before = read(fresh),
              rebased = build(fresh, before);
            // Rebase can change eligibility. Fall back BEFORE any tenant write.
            if (!hasNoPlatformEffects(platform, current.organizationId, before, rebased))
              return null;
            assertChange(platform, fresh, before, rebased, storage, partial, acknowledgement);
            context.recordStage?.('save-shared-write');
            const saved = writeCabinetMutation(
              platform,
              current.organizationId,
              storage,
              before,
              rebased,
              changedIds,
              normalizedImages,
              preparedWrite,
              { sharedNoEffects: true, appointmentOnly },
            );
            writeReceipt(storage, fresh, identity, saved, receiptBody, partial);
            context.recordStage?.('save-shared-commit');
            return { saved };
          },
          'IMMEDIATE',
          (ms) => context.recordTiming?.('save-shared-cabinet-commit', ms),
        );
      },
      {
        bytes: Buffer.byteLength(JSON.stringify(receiptBody)) * 3,
        cancelled: () => Boolean(context.req?.aborted || context.res?.destroyed),
      },
    );
  } finally {
    // Admission can fail before the callback. Do not hide its wait or count a
    // later authorization/tenant error as failure to acquire the shared fence.
    if (!acquired)
      context.recordTiming?.('save-shared-lock-wait', performance.now() - started, true);
  }
}
module.exports = { trySharedMutation, hasNoPlatformEffects };
