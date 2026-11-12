const { fail } = require('../../shared/errors.cjs');
const { performance } = require('node:perf_hooks');

const PHOTO_RESPONSE_DEADLINE_MS = 30000;
async function servePhoto({
  req,
  res,
  id,
  requireCurrent,
  assertRequestContext,
  tenantStore,
  responseDeadlineMs = PHOTO_RESPONSE_DEADLINE_MS,
}) {
  if (
    !Number.isSafeInteger(responseDeadlineMs) ||
    responseDeadlineMs < 1 ||
    responseDeadlineMs > PHOTO_RESPONSE_DEADLINE_MS
  )
    throw Error('Invalid photo response deadline.');
  let expired = false,
    settled = false,
    handedOff = false,
    releasePhoto = () => {};
  const deadlineAt = performance.now() + responseDeadlineMs;
  const release = () => {
    releasePhoto();
    releasePhoto = () => {};
  };
  const cleanup = () => {
    clearTimeout(deadline);
    res.removeListener('finish', onSettled);
    res.removeListener('close', onSettled);
  };
  const onSettled = () => {
    settled = true;
    cleanup();
    release();
  };
  const deadline = setTimeout(() => {
    expired = true;
    // Destroy requests closure; the retained Buffer is not free until finish/close.
    if (!res.destroyed) res.destroy();
  }, responseDeadlineMs);
  deadline.unref?.();
  res.once('finish', onSettled);
  res.once('close', onSettled);
  try {
    const current = requireCurrent();
    if (current.globalAdmin)
      throw fail(403, 'Главный администратор не имеет доступа к фотографиям.');
    assertRequestContext(current);
    assertRequestContext(current, true, true);
    const storage = tenantStore(current.organizationId);
    const cancelled = () =>
      expired || performance.now() >= deadlineAt || req.aborted || res.destroyed;
    const authorize = () => {
      if (cancelled()) throw fail(408, 'Загрузка фотографии остановлена.');
      const fresh = requireCurrent();
      assertRequestContext(fresh);
      assertRequestContext(fresh, true, true);
      if (
        fresh.accountId !== current.accountId ||
        fresh.organizationId !== current.organizationId ||
        fresh.role !== current.role ||
        fresh.globalAdmin !== current.globalAdmin
      )
        throw fail(403, 'Доступ изменился. Повторите операцию.');
      if (fresh.role === 'cosmetologist' && !storage.indexes.photoVisible(id, fresh))
        throw fail(404, 'Фотография не найдена.');
    };
    authorize();
    const image = await storage.photoAsync(id, {
      authorize,
      cancelled,
      retain: (done) => {
        let released = false;
        releasePhoto = () => {
          if (released) return;
          released = true;
          done();
        };
        if (settled) release();
      },
    });
    authorize();
    res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.buffer.length });
    handedOff = true;
    return res.end(req.method === 'HEAD' ? undefined : image.buffer);
  } catch (error) {
    if (handedOff && !settled && !res.destroyed) res.destroy();
    throw error;
  } finally {
    // No bytes were queued: the read has actually settled, so release is safe.
    // Once handed to HTTP, destroyed=true alone never releases its reservation.
    if (!handedOff) {
      cleanup();
      release();
    }
  }
}
module.exports = { servePhoto, PHOTO_RESPONSE_DEADLINE_MS };
