const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  createAssistantReads,
} = require('../src/server/infrastructure/postgres/assistant-reads.cjs');
const {
  createReadOperationClient,
} = require('../src/server/infrastructure/postgres/read-operation-client145.cjs');
const {
  createContinuationRuntime,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
test(
  'continuation phases own bounded real native RR, never a provider lifetime',
  { timeout: 120000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t),
      trace = [];
    let transaction = false,
      afterCommit,
      finishBarrier,
      reads;
    try {
      reads = createAssistantReads(f.config, {
        createReadOperationClient(config) {
          return createReadOperationClient(config, {
            createClient(options) {
              const client = new Client(options),
                query = client.query.bind(client);
              client.query = async (input, ...args) => {
                const sql = typeof input === 'string' ? input : input.text;
                trace.push(sql);
                if (sql.includes('fence_locked') && finishBarrier) await finishBarrier;
                const pending = query(input, ...args);
                if (sql === 'COMMIT' && afterCommit) {
                  finishBarrier = pending.then(() => afterCommit?.());
                }
                const result = await pending;
                if (/^BEGIN/i.test(sql)) transaction = true;
                if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false;
                if (sql === 'COMMIT' && finishBarrier) await finishBarrier;
                return result;
              };
              return client;
            },
          });
        },
      });
      const actor = f.actors[0],
        sessionId = f.a.p
          .prepare('SELECT id FROM platform_sessions WHERE token_hash=?')
          .get(f.database.tokenHash(actor.token)).id;
      const base = {
        current: { ...actor, sessionId, globalAdmin: false },
        token: actor.token,
        assertCurrent() {},
        assertAssistantReadCurrent() {},
      };
      const state = {
        revision: 1,
        providers: { llm: { provider: 'codex' } },
        rates: { llmInput: 0, llmOutput: 0 },
        policy: { limits: { maxOutputTokens: 100 } },
      };
      async function run(mode, options = {}) {
        const controller = new AbortController(),
          c = { ...base, transportAbortSignal: controller.signal };
        c.assistantReads = reads.bind(c);
        let applied = false,
          version = 0,
          providerCalls = 0,
          zoneReads = 0;
        const originalZone = c.assistantReads.timeZone;
        c.assistantReads.timeZone = () => {
          zoneReads++;
          return originalZone();
        };
        const entry = { expiresAt: Date.now() + 60000 };
        const dialogues = {
          fingerprint: () => mode,
          get: () => entry,
          async prepareModelTurn() {
            assert.equal(transaction, true);
            await c.assistantReads.appointmentContext();
            if (options.cancel) controller.abort();
            return mode === 'local'
              ? null
              : { context: { step: 'date', missingFields: ['date'], fields: [], options: [] } };
          },
          async continueDialogue() {
            assert.equal(transaction, true);
            await c.assistantReads.appointmentContext();
            applied = true;
            return { ok: true };
          },
          async assertModelTurn() {
            assert.equal(transaction, true);
            if (version) throw Object.assign(Error('version changed'), { status: 409 });
            await c.assistantReads.appointmentContext();
          },
          async applyModelTurn() {
            assert.equal(transaction, true);
            await c.assistantReads.appointmentContext();
            applied = true;
            return { ok: true };
          },
        };
        const runtime = createContinuationRuntime({
          dialogues,
          scope() {
            if (options.policyChanged && providerCalls)
              throw Object.assign(Error('policy changed'), { status: 409 });
            return { state, member: {} };
          },
          timeZone: () => 'Europe/Moscow',
          async invoke(...args) {
            assert.equal(transaction, false, 'RR closed before provider admission');
            providerCalls++;
            await args[7]();
            assert.equal(transaction, false, 'outbound assertion RR closed before provider');
            if (options.version) version++;
            if (options.revoke)
              await f.admin.query(
                "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
                [f.platform.storeId, actor.accountId],
              );
            return { text: JSON.stringify(continuationExample({ operation: 'repeat' })) };
          },
        });
        const start = trace.length;
        try {
          const result = await runtime.run(
            c,
            { text: 'Synthetic unclear answer', dialogueId: 'synthetic', policyVersion: 1 },
            state,
            {},
          );
          return { result, applied, providerCalls, zoneReads, sql: trace.slice(start) };
        } catch (error) {
          error.observed = { applied, providerCalls, zoneReads, sql: trace.slice(start) };
          throw error;
        }
      }
      await t.test('local preparation and replay share one RR and one timezone read', async () => {
        const r = await run('local');
        assert.equal(r.applied, true);
        assert.equal(r.providerCalls, 0);
        assert.equal(r.zoneReads, 1);
        assert.equal(r.sql.filter((s) => /^BEGIN/i.test(s)).length, 1);
        assert.equal(r.sql.filter((s) => s === 'COMMIT').length, 1);
      });
      await t.test('model provider outside RR and application owns a fresh frame', async () => {
        const r = await run('model');
        assert.equal(r.applied, true);
        assert.equal(r.providerCalls, 1);
        assert.equal(r.zoneReads, 2);
        assert.ok(r.sql.filter((s) => s === 'COMMIT').length >= 4);
        assert.equal(transaction, false);
      });
      await t.test('cancel during native prepare rolls back and cannot apply', async () => {
        await assert.rejects(
          run('local', { cancel: true }),
          (e) =>
            e.code === 'ASSISTANT_REQUEST_ABORTED' &&
            !e.observed.applied &&
            e.observed.sql.includes('ROLLBACK'),
        );
        assert.equal(transaction, false);
      });
      await t.test('version changes across provider prevent apply', async () => {
        await assert.rejects(
          run('model', { version: true }),
          (e) => e.status === 409 && !e.observed.applied && e.observed.providerCalls === 1,
        );
        assert.equal(transaction, false);
      });
      await t.test('policy revision changes across provider prevent apply', async () => {
        await assert.rejects(
          run('model', { policyChanged: true }),
          (e) => e.status === 409 && !e.observed.applied,
        );
        assert.equal(transaction, false);
      });

      await t.test(
        'actual service local continuation uses fewer native frames than captured baseline',
        async () => {
          const path = require('node:path'),
            Module = require('node:module'),
            { createHash } = require('node:crypto'),
            fs = require('node:fs');
          const directory = path.join(f.dir, 'platform');
          const {
            createAssistantStore,
          } = require('../src/server/modules/assistant/access/store.cjs');
          const store = createAssistantStore({ ...f.database, directory });
          const membership = f.a.p
            .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
            .get(actor.organizationId, actor.accountId);
          store.update((state) => {
            state.policy.mode = 'selected';
            state.providers.llm = { provider: 'codex', model: 'codex-default' };
            state.grants = [
              {
                organizationId: actor.organizationId,
                accountId: actor.accountId,
                membershipId: createHash('sha256')
                  .update(
                    JSON.stringify([actor.organizationId, actor.accountId, membership.created_at]),
                  )
                  .digest('base64url'),
              },
            ];
          });
          const context = {
            ...f.database,
            fail: require('../src/shared/errors.cjs').fail,
            billing: { hasServiceConnection: () => false, isServiceEnabled: () => false },
          };
          Object.assign(
            context,
            require('../src/server/modules/organizations/time-zone.cjs').createOrganizationTimeZone(
              context,
            ),
          );
          const platform = {
            ...context,
            ...require('../src/server/modules/workspace/service.cjs').createWorkspace(context),
            ...require('../src/server/modules/services/groups.cjs').createServiceGroups(context),
          };
          const currentContext = { ...base, tenantStore: () => f.storage, platform };
          const runtimeFile = path.resolve(
            'src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs',
          );
          const old = new Module(runtimeFile, module);
          old.filename = runtimeFile;
          old.paths = Module._nodeModulePaths(path.dirname(runtimeFile));
          old._compile(
            fs.readFileSync(
              'work/voice-speed-implementation-next/before/src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs',
              'utf8',
            ),
            runtimeFile,
          );
          const serviceFile = path.resolve('src/server/modules/assistant/service.cjs'),
            oldService = new Module(serviceFile, module);
          oldService.filename = serviceFile;
          oldService.paths = Module._nodeModulePaths(path.dirname(serviceFile));
          const originalRequire = oldService.require.bind(oldService);
          oldService.require = (id) =>
            id === './dialogue/continuation/continuation-runtime.cjs'
              ? old.exports
              : originalRequire(id);
          oldService._compile(fs.readFileSync(serviceFile, 'utf8'), serviceFile);
          const result = [];
          for (const [name, createAssistant] of [
            ['baseline', oldService.exports.createAssistant],
            ['candidate', require('../src/server/modules/assistant/service.cjs').createAssistant],
          ]) {
            const api = createAssistant(
              { ...context, assistantReads: reads },
              {
                directory,
                codex: {
                  available: true,
                  async run(call) {
                    assert.equal(transaction, false);
                    await call.onOutbound();
                    assert.equal(transaction, false);
                    return {
                      text: JSON.stringify(
                        continuationExample({ operation: 'clarify', field: 'client' }),
                      ),
                    };
                  },
                },
              },
            );
            const initial = await api.turn(currentContext, {
              text: 'Запиши клиента',
              policyVersion: 0,
            });
            assert.ok(initial.dialogue);
            const start = trace.length;
            const local = await api.turn(currentContext, {
              text: 'Повтори',
              policyVersion: 0,
              dialogueId: initial.dialogue.id,
              dialogueVersion: initial.dialogue.version,
            });
            assert.ok(local.dialogue);
            assert.equal(local.dialogue.step, initial.dialogue.step);
            assert.equal(local.action, null);
            result.push({
              name,
              frames: trace.slice(start).filter((sql) => sql === 'COMMIT').length,
            });
            const model = await api.turn(currentContext, {
              text: 'Неясное синтетическое значение',
              policyVersion: 0,
              dialogueId: local.dialogue.id,
              dialogueVersion: local.dialogue.version,
            });
            assert.ok(model.dialogue);
            assert.equal(model.action, null);
            if (name === 'candidate') {
              const initial = await api.turn(currentContext, {
                text: 'Запиши клиента',
                policyVersion: 0,
              });
              let commits = 0;
              afterCommit = async () => {
                if (++commits !== 2) return;
                afterCommit = null;
                await f.admin.query(
                  "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
                  [f.platform.storeId, actor.accountId],
                );
              };
              const body = {
                policyVersion: 0,
                dialogueId: initial.dialogue.id,
                dialogueVersion: initial.dialogue.version,
                text: 'Повтори',
              };
              await assert.rejects(api.turn(currentContext, body), { status: 401 });
              afterCommit = null;
              await f.admin.query(
                "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND account_id=$2",
                [f.platform.storeId, actor.accountId],
              );
              const retry = await api.turn(currentContext, { ...body, text: 'Повторите' });
              assert.ok(retry.dialogue, 'failed native finish did not advance the live dialogue');
              assert.equal(retry.dialogue.version, initial.dialogue.version + 1);
              assert.equal(retry.action, null);
            }
          }
          assert.ok(result[1].frames < result[0].frames, 'actual service reduces native RR count');
          t.diagnostic(
            JSON.stringify({ actualService: true, actualPostgres: true, localFrames: result }),
          );
        },
      );
      await t.test('real native membership revocation after provider prevents apply', async () => {
        await assert.rejects(
          run('model', { revoke: true }),
          (e) => [401, 403].includes(e.status) && !e.observed.applied,
        );
        assert.equal(transaction, false);
      });
      t.diagnostic(
        JSON.stringify({
          actualPostgres: true,
          providerNetwork: false,
          rawIdentitiesPrinted: false,
        }),
      );
    } finally {
      await reads?.close();
      await f.close();
    }
  },
);
