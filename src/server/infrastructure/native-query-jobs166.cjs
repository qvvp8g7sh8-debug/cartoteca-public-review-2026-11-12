const { ArrayBuffer, Int32Array, Atomics } = globalThis;
const HARD_REPLY_BYTES166 = 64 * 1024 * 1024;
const cancelled = () =>
  Object.assign(Error('Запрос отменён.'), {
    status: 499,
    code: 'NATIVE_CANCELLED',
  });
// A job owns its decoded/serialized result under its existing work lease. Reply
// credit controls only transfer/retention; it is never permission to fetch data.
function createNativeQueryJobs166({ parentPort, kernel, capacity = 1, sample = () => {} }) {
  if (![1, 2].includes(capacity)) throw Error('Invalid query job capacity');
  const jobs = new Map();
  function interrupted(job) {
    return job.cancelled || Boolean(job.cancel && Atomics.load(job.cancel, 0));
  }
  function check(job) {
    if (interrupted(job)) throw cancelled();
  }
  function errorReply(id, error) {
    parentPort.postMessage({
      id,
      queryDiagnostics: kernel.stats(),
      error: {
        status: error.status || 500,
        message: error.status ? error.message : 'Не удалось выполнить операцию.',
        ...(error.code ? { code: error.code } : {}),
      },
    });
  }
  async function run(job, message) {
    let result, failure;
    const execution = {
      get memoryClass() {
        return job.memoryClass;
      },
      requestMemoryClass(memoryClass) {
        if (memoryClass !== 'query') return Promise.reject(Error('Invalid read memory class'));
        try {
          check(job);
        } catch (error) {
          return Promise.reject(error);
        }
        if (job.memoryClass === 'query') return Promise.resolve();
        if (job.pendingMemory) return Promise.reject(Error('Read memory upgrade already pending'));
        return new Promise((resolve, reject) => {
          job.pendingMemory = { resolve, reject };
          try {
            parentPort.postMessage({ id: job.id, memoryClass: 'query' });
          } catch (error) {
            job.pendingMemory = null;
            reject(error);
          }
        });
      },
    };
    try {
      check(job);
      sample();
      result = await kernel.run(message.metadata, message.cancel, execution);
      sample();
      check(job);
      if (
        !result ||
        !(result.body instanceof ArrayBuffer) ||
        result.body.byteLength > job.maximumReply
      )
        throw Object.assign(Error('Ответ превышает допустимый размер.'), {
          status: 503,
          code: 'NATIVE_RESPONSE_CAPACITY',
        });
      const bytes = result.body.byteLength;
      if (bytes > job.replyCredit) {
        await new Promise((resolve, reject) => {
          job.pendingReply = { resolve, reject, bytes };
          try {
            parentPort.postMessage({ id: job.id, replyBytes166: bytes });
          } catch (error) {
            job.pendingReply = null;
            reject(error);
          }
        });
        check(job);
      }
      parentPort.postMessage({ id: job.id, result, queryDiagnostics: kernel.stats() }, [
        result.body,
      ]);
      result = null;
    } catch (error) {
      failure = error;
    } finally {
      // Drop the owned body before acknowledging an error to the lease owner.
      result = null;
      jobs.delete(job.id);
      if (failure) errorReply(job.id, failure);
    }
  }
  function receive(message) {
    if (!message || typeof message !== 'object') return;
    const job = jobs.get(message.id);
    if (Object.hasOwn(message, 'cancel166')) {
      if (!job || message.cancel166 !== true) return;
      job.cancelled = true;
      if (job.cancel) Atomics.store(job.cancel, 0, 1);
      const error = cancelled();
      const memory = job.pendingMemory,
        reply = job.pendingReply;
      job.pendingMemory = job.pendingReply = null;
      memory?.reject(error);
      reply?.reject(error);
      return;
    }
    if (Object.hasOwn(message, 'memoryGranted') || Object.hasOwn(message, 'memoryError')) {
      if (!job?.pendingMemory) return;
      const pending = job.pendingMemory;
      job.pendingMemory = null;
      if (message.memoryGranted === 'query' && !message.memoryError && !interrupted(job)) {
        job.memoryClass = 'query';
        pending.resolve();
      } else
        pending.reject(
          interrupted(job)
            ? cancelled()
            : Object.assign(Error('Read memory admission failed'), {
                status: 503,
                code: message.memoryError?.code || 'NATIVE_MEMORY_WORK_CAPACITY',
              }),
        );
      return;
    }
    if (Object.hasOwn(message, 'replyGranted166') || Object.hasOwn(message, 'replyError166')) {
      if (!job?.pendingReply) return;
      const pending = job.pendingReply;
      job.pendingReply = null;
      if (
        message.replyGranted166 === pending.bytes &&
        !message.replyError166 &&
        !interrupted(job)
      ) {
        job.replyCredit = pending.bytes;
        pending.resolve();
      } else
        pending.reject(
          interrupted(job)
            ? cancelled()
            : Object.assign(Error('Read reply admission failed'), {
                status: 503,
                code: 'NATIVE_REPLY_CAPACITY',
              }),
        );
      return;
    }
    // A duplicate start must never acknowledge the still-running owner. Doing
    // so could release its work lease while its SQL is still draining.
    if (job) return;
    if (
      message.kind !== 'query' ||
      !Number.isSafeInteger(message.id) ||
      message.id < 1 ||
      jobs.size >= capacity
    ) {
      errorReply(message.id, Object.assign(Error('Исполнитель временно занят.'), { status: 503 }));
      return;
    }
    const maximumReply = message.maxReplyBytes166 ?? HARD_REPLY_BYTES166;
    const replyCredit = message.replyCredit166 ?? maximumReply;
    if (
      !Number.isSafeInteger(maximumReply) ||
      maximumReply < 1 ||
      maximumReply > HARD_REPLY_BYTES166 ||
      !Number.isSafeInteger(replyCredit) ||
      replyCredit < 1 ||
      replyCredit > maximumReply
    ) {
      errorReply(message.id, Object.assign(Error('Некорректный допуск ответа.'), { status: 503 }));
      return;
    }
    const selected = {
      id: message.id,
      memoryClass: message.memoryClass || 'query',
      cancelled: false,
      cancel: message.cancel ? new Int32Array(message.cancel) : null,
      maximumReply,
      replyCredit,
      pendingMemory: null,
      pendingReply: null,
    };
    jobs.set(selected.id, selected);
    void run(selected, message);
  }
  return { receive, active: () => jobs.size };
}
module.exports = { createNativeQueryJobs166, HARD_REPLY_BYTES166 };
