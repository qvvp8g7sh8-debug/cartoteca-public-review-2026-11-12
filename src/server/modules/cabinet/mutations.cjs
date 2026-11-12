const { fail } = require('../../../shared/errors.cjs');
const { mergeCosmetologistCabinet } = require('../access/cabinet-policy.cjs');
const { editable, applyChanges } = require('./changes.cjs');
const { writeCabinetMutation } = require('./mutation-write.cjs');
const { performance } = require('node:perf_hooks');
const {
  mutationIdentity,
  readReceipt,
  writeReceipt,
} = require('../../infrastructure/mutation-receipts.cjs');

const { assertChange } = require('./mutation-policy.cjs');
const {
  createAppointmentMutation,
  createAppointmentPatchMutation,
} = require('./appointment-commands.cjs');
const { asyncCompoundMutation } = require('./compound-mutation133.cjs');
// trustedCommit is supplied only by an internal server command, never HTTP input.
async function saveMutation(context, body, options = {}) {
  const mutation = prepareMutation(context, body, options);
  const { storage, initial, next, changedIds, replay, platform } = mutation;
  const stage = (value) => context.recordStage?.(value);
  if (replay) {
    stage('save-response');
    return replay.saved;
  }
  mutation.normalizedImages = mutation.deferredAppointment
    ? new Map()
    : await prepareMutationImages(context, body, mutation);
  mutation.lockStarted = null;
  mutation.platformAcquired = false;
  mutation.schedule = platform.notificationSchedule;
  try {
    // Encrypted candidates do not replace fresh authorization and rebase at commit.
    stage('save-preparation');
    const preparationStarted = performance.now();
    mutation.preparedWrite = mutation.deferredAppointment
      ? null
      : storage.prepareWrite?.(initial, next, { changedIds });
    context.recordTiming?.('save-preparation', performance.now() - preparationStarted);
    const shared = mutation.deferredAppointment
      ? null
      : await require('./shared-mutation.cjs').trySharedMutation(context, mutation);
    const saved = shared ? shared.saved : await commitMutation(context, body, mutation);
    stage('save-response');
    return saved;
  } finally {
    storage.discardPreparedWrite?.(mutation.preparedWrite);
    // Failed admission still contributes wait time and never retries the write.
    if (mutation.lockStarted !== null && !mutation.platformAcquired)
      context.recordTiming?.('save-lock-wait', performance.now() - mutation.lockStarted, true);
  }
}

function prepareMutation(
  context,
  body,
  { partial = false, trustedCommit, appointmentCommand = false } = {},
) {
  const { current, platform, tenantStore, token } = context;
  const command = appointmentCommand
    ? createAppointmentMutation(body)
    : partial
      ? createAppointmentPatchMutation(body)
      : null;
  if (command) partial = true;
  const appointmentOnly =
    appointmentCommand &&
    ['delta-v1', 'point-v1'].includes(context.req?.headers?.['x-cartoteca-appointment-response']);
  const receiptBody = command?.receiptBody || body;
  const stage = (value) => context.recordStage?.(value);
  stage('save-open');
  const storage = tenantStore(current.organizationId);
  stage('save-identity');
  const identity = mutationIdentity(context, body, partial);
  const build =
    command?.build ||
    ((user, before) =>
      partial
        ? applyChanges(user, before, body)
        : user.role === 'cosmetologist'
          ? mergeCosmetologistCabinet(user, before, editable(body))
          : editable(body));
  const changedIds =
    command?.changedIds ||
    (partial
      ? { patients: body.patients.map((c) => c.id), services: body.services.map((c) => c.id) }
      : undefined);
  if (
    command &&
    appointmentCommand &&
    context.req?.headers?.['x-cartoteca-appointment-response'] === 'point-v1'
  )
    command.appointmentRead.bounded = true;
  const read = (actor = current) => {
    const compact = command && storage.readAppointmentMutation?.(command.appointmentRead, actor);
    if (compact) {
      command.acceptCompact(compact);
      return compact;
    }
    return storage.readForMutation
      ? storage.readForMutation(changedIds)
      : partial
        ? storage.readSelected(changedIds.patients, changedIds.services)
        : storage.read();
  };
  // A typed point command cannot submit patient/history/photo changes. Its
  // authoritative read/build/policy pass happens once inside the ordinary
  // owning compound transaction. Large/legacy/trusted commands keep preparation.
  if (
    appointmentCommand &&
    context.req?.headers?.['x-cartoteca-appointment-response'] === 'point-v1' &&
    storage.capabilities?.normalizedRecords &&
    platform.withAsyncCompoundMutation &&
    !trustedCommit
  )
    return {
      current,
      platform,
      token,
      storage,
      command,
      appointmentOnly,
      receiptBody,
      identity,
      build,
      changedIds,
      read,
      partial,
      trustedCommit,
      acknowledgement: context.req?.headers?.['x-cartoteca-schedule-ack'],
      deferredAppointment: true,
    };
  let replay;
  stage('save-initial-read');
  const initial = storage.transaction(() => {
    context.assertCurrent();
    replay =
      identity && readReceipt(storage, current, identity.id, identity.hash, { appointmentOnly });
    return replay ? null : read();
  }, 'DEFERRED');
  if (replay) return { storage, replay };
  stage('save-validation');
  const validationStarted = performance.now();
  const next = build(current, initial);
  const acknowledgement = context.req?.headers?.['x-cartoteca-schedule-ack'];
  assertChange(
    platform,
    current,
    initial,
    next,
    storage,
    partial,
    acknowledgement,
    trustedCommit?.acceptance,
  );
  context.recordTiming?.('save-validation', performance.now() - validationStarted);
  return {
    current,
    platform,
    token,
    storage,
    command,
    appointmentOnly,
    receiptBody,
    identity,
    build,
    changedIds,
    read,
    partial,
    trustedCommit,
    initial,
    next,
    acknowledgement,
  };
}

async function prepareMutationImages(context, body, mutation) {
  const { storage, partial, command, next } = mutation;
  const stage = (value) => context.recordStage?.(value);
  // Expensive image decoding is outside database locks. Rebase and authorize again at commit.
  const imagePayload =
    partial && !command
      ? {
          revision: 0,
          patients: body.patients.flatMap((change) => (change.after ? [change.after] : [])),
          services: [],
        }
      : next;
  const photoStarted = performance.now();
  stage('photo-preparation');
  const normalizedImages = await storage.prepareImages(imagePayload, () => context.assertCurrent());
  context.recordTiming?.('photo-preparation', performance.now() - photoStarted);
  return normalizedImages;
}

async function commitMutation(context, body, mutation) {
  const { current, platform, schedule, identity, storage, trustedCommit } = mutation;
  const stage = (value) => context.recordStage?.(value);
  let intent;
  if (schedule?.enabled) {
    // This separately committed marker survives a later cabinet/platform
    // commit gap. It is not a grant of access and is never retried blindly.
    stage('save-notification-intent');
    const intentStarted = performance.now();
    try {
      intent = schedule.beginIntentAsync
        ? await schedule.beginIntentAsync(current.organizationId, identity?.id || '', {
            cancelled: () => Boolean(context.req?.aborted || context.res?.destroyed),
          })
        : schedule.beginIntent(current.organizationId, identity?.id || '');
      context.recordTiming?.('save-notification-intent', performance.now() - intentStarted);
    } catch (error) {
      context.recordTiming?.('save-notification-intent', performance.now() - intentStarted, true);
      throw error;
    }
  }
  // The platform lock is acquired before the cabinet transaction.
  mutation.lockStarted = performance.now();
  stage('save-platform-lock');
  return await asyncCompoundMutation(
    platform,
    storage,
    current.organizationId,
    trustedCommit?.acceptance ? 'booking' : 'cabinet',
    () => commitCabinetMutation(context, mutation, intent),
    {
      bytes: Buffer.byteLength(JSON.stringify(body)) * 3,
      ...(mutation.deferredAppointment ? { atomicStatements: true } : {}),
      cancelled: () => Boolean(context.req?.aborted || context.res?.destroyed),
      committed: (ms) => context.recordTiming?.('save-platform-commit', ms),
    },
  );
}

// This entire platform-lock callback is synchronous; only admission may await.
function commitCabinetMutation(context, mutation, intent) {
  const {
    current,
    platform,
    token,
    storage,
    schedule,
    identity,
    read,
    build,
    partial,
    trustedCommit,
    acknowledgement,
    changedIds,
    normalizedImages,
    preparedWrite,
    receiptBody,
    appointmentOnly,
    lockStarted,
  } = mutation;
  const stage = (value) => context.recordStage?.(value);
  const assertIntent = () => {
    if (!intent) return;
    stage('save-intent-guard');
    schedule.assertIntent(intent);
  };
  mutation.platformAcquired = true;
  context.recordTiming?.('save-lock-wait', performance.now() - lockStarted);
  const transactionStarted = performance.now();
  let cabinetAcquired = false,
    transactionCompleted = false;
  stage('save-cabinet-lock');
  try {
    const result = storage.transaction(
      () => {
        cabinetAcquired = true;
        context.recordTiming?.('save-cabinet-lock-wait', performance.now() - transactionStarted);
        stage('save-revalidation');
        const revalidationStarted = performance.now();
        const fresh = context.assertCurrent() || platform.session(token);
        if (!fresh) throw fail(401, 'Войдите в картотеку.');
        assertIntent();
        const replay =
          identity && readReceipt(storage, fresh, identity.id, identity.hash, { appointmentOnly });
        if (replay) {
          schedule?.markDirty(current.organizationId);
          assertIntent();
          stage('save-cabinet-commit');
          return replay.saved;
        }
        const before = read(fresh),
          rebased = build(fresh, before);
        trustedCommit?.assert(fresh, storage);
        assertChange(
          platform,
          fresh,
          before,
          rebased,
          storage,
          partial,
          acknowledgement,
          trustedCommit?.acceptance,
        );
        assertIntent();
        context.recordTiming?.('save-revalidation', performance.now() - revalidationStarted);
        stage('save-write');
        const writeStarted = performance.now();
        const saved = writeCabinetMutation(
          platform,
          current.organizationId,
          storage,
          before,
          rebased,
          changedIds,
          normalizedImages,
          preparedWrite,
          { appointmentOnly },
        );
        stage('save-receipt');
        writeReceipt(storage, fresh, identity, saved, receiptBody, partial);
        context.recordTiming?.('save-write', performance.now() - writeStarted);
        trustedCommit?.written(storage);
        // Expiry during synchronous SQL/crypto must still roll the cabinet
        // back; recovery cannot retire an intent before a late writer commits.
        assertIntent();
        stage('save-cabinet-commit');
        return saved;
      },
      'IMMEDIATE',
      (ms) => context.recordTiming?.('save-cabinet-commit', ms),
    );
    // Cabinet commit precedes the platform commit. The command's durable
    // cabinet marker reconciles a crash in this cross-database gap.
    stage('save-trusted-commit');
    trustedCommit?.committed(storage);
    if (intent) schedule.ackIntent(intent);
    stage('save-platform-commit');
    transactionCompleted = true;
    return result;
  } finally {
    if (!cabinetAcquired)
      context.recordTiming?.(
        'save-cabinet-lock-wait',
        performance.now() - transactionStarted,
        true,
      );
    context.recordTiming?.(
      'save-transaction',
      performance.now() - transactionStarted,
      !transactionCompleted,
    );
  }
}
module.exports = { saveMutation };
