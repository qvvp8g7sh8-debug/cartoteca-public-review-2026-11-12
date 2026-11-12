const { fail } = require('../../../shared/errors.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { assertTransport } = require('../../modules/assistant/buffered-request.cjs');
const { createReadOperationClient } = require('./read-operation-client145.cjs');
const { createOperationCryptoCache } = require('./read-operation-crypto145.cjs');
const { operationScope, createOperationContext } = require('./read-operation-context145.cjs');
const { authorityValue } = require('./read-session152.cjs');
const { createAssistantReadFrame } = require('./assistant-read-frame.cjs');
const { beginAssistantTiming, assistantOutcome } = require('../assistant-timing.cjs');

// One lazy physical reader belongs to the assistant owner, not to a user/turn.
// A bounded FIFO serializes its RR snapshots without blocking the JS event loop.
function createAssistantReads(config, dependencies = {}) {
  if (config?.storageBackend !== 'postgres' || config.postgresRevisionProfile !== 3) return null;
  let ready,
    closing = false,
    tail = Promise.resolve(),
    pending = 0;
  const cache = new Map();
  const frames = new AsyncLocalStorage();
  async function initialize() {
    const engine = await (dependencies.createReadOperationClient || createReadOperationClient)(
      config,
    );
    try {
      const crypto = await createOperationCryptoCache(config.dataDir, engine.marker);
      return { engine, crypto };
    } catch (error) {
      await engine.close();
      throw error;
    }
  }
  function bind(c) {
    const expected = { ...c.current };
    function active() {
      assertTransport(c);
      if (closing) throw fail(503, 'Помощник завершает работу.');
      c.assertAssistantReadCurrent?.();
      if (!c.transportAbortSignal && (c.req?.aborted || c.res?.destroyed || c.signal?.aborted))
        throw fail(499, 'Запрос отменён.');
      for (const key of ['accountId', 'organizationId', 'sessionId', 'role', 'globalAdmin'])
        if (expected[key] !== c.current[key])
          throw fail(403, 'Доступ изменился. Повторите запрос.');
    }
    function authorize(value) {
      active();
      if (!value?.supported || !value.current) throw fail(401, 'Войдите в картотеку.');
      const fresh = value.current;
      if (fresh.globalAdmin || !['owner', 'salon_admin', 'cosmetologist'].includes(fresh.role))
        throw fail(403, 'Нет доступа к картотеке.');
      for (const key of ['accountId', 'organizationId', 'sessionId', 'role', 'globalAdmin'])
        if (fresh[key] !== expected[key]) throw fail(403, 'Доступ изменился. Повторите запрос.');
    }
    async function execute(kind, input) {
      active();
      const joined = frames.getStore();
      if (joined) {
        joined.frame.check();
        if (
          joined.token !== c.token ||
          ['accountId', 'organizationId', 'sessionId', 'role', 'globalAdmin'].some(
            (key) => joined.current[key] !== expected[key],
          )
        )
          throw fail(403, 'Нельзя объединять чтения разных учётных записей.');
        return kind === 'snapshot' ? input.callback() : joined.frame.read(kind, input, active);
      }
      if (pending >= 16) throw fail(503, 'Помощник занят. Повторите запрос.');
      const end = beginAssistantTiming(c.assistantTiming, 'data-read', 'turn', 'none');
      let outcome = 'completed';
      pending++;
      const preceding = tail;
      let release, runtime;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await preceding;
        active();
        ready ||= initialize().catch((error) => {
          ready = null;
          throw error;
        });
        runtime = await ready;
        const { engine, crypto } = runtime;
        active();
        const platformCrypto = await crypto.forPlatform(active);
        authorize(authorityValue(await engine.authority(c.token, active), platformCrypto.decode));
        const selected = operationScope(engine.marker, expected.organizationId);
        if (selected.unsupported) throw fail(503, 'Кабинет ещё не подготовлен для чтения.');
        const platformOnly =
          kind === 'snapshot'
            ? input.platformOnly
            : kind === 'timeZone' || kind === 'serviceGroups';
        const result = await engine.run(
          {
            scope: selected.scope,
            deferCatalog: true,
            platformOnly,
            assertActive: active,
            finish167: {
              token: c.token,
              accept: (rows) => authorize(authorityValue(rows, platformCrypto.decode)),
            },
          },
          async (operation) => {
            const prepared = await createOperationContext(
              config,
              operation,
              expected,
              selected.relativeDirectory,
              crypto,
              { platformOnly },
            );
            const frame = createAssistantReadFrame(
              { operation, prepared, current: expected, cache },
              active,
              platformOnly,
            );
            try {
              return await frames.run({ frame, token: c.token, current: expected }, () =>
                kind === 'snapshot' ? input.callback() : frame.read(kind, input, active),
              );
            } finally {
              try {
                await frame.finish();
              } finally {
                prepared.close();
              }
            }
          },
        );
        if (result?.unsupported) throw fail(503, 'Чтение помощника пока недоступно.');
        active();
        return result;
      } catch (error) {
        outcome = assistantOutcome(error);
        if (runtime && !runtime.engine.available166()) {
          ready = null;
          cache.clear();
          runtime.crypto.close();
          await runtime.engine.close().catch(() => {});
        }
        throw error;
      } finally {
        end(outcome);
        pending--;
        release();
      }
    }
    return {
      snapshot(callback, { platformOnly = false } = {}) {
        if (typeof callback !== 'function' || typeof platformOnly !== 'boolean')
          throw fail(400, 'Некорректная операция чтения помощника.');
        return execute('snapshot', { callback, platformOnly });
      },
      directory: (query, limit, options = {}) => execute('directory', { query, limit, ...options }),
      summaries: (ids, options = {}) => execute('summaries', { ids, ...options }),
      appointmentContext: () => execute('appointmentContext', {}),
      availability: (input) => execute('availability', input),
      selected: (ids = [], serviceIds = []) => execute('selected', { ids, serviceIds }),
      calendar: (from, to, options = {}) => execute('calendar', { from, to, options }),
      timeZone: () => execute('timeZone', {}),
      serviceGroups: () => execute('serviceGroups', {}),
      revision: () => execute('revision', {}),
    };
  }
  return {
    bind,
    async close() {
      closing = true;
      await tail;
      cache.clear();
      if (ready) {
        const value = await ready.catch(() => null);
        value?.crypto.close();
        await value?.engine.close();
      }
    },
    stats: () => ({ pending, capacity: 1, cachedDirectories: cache.size }),
  };
}
module.exports = { createAssistantReads };
