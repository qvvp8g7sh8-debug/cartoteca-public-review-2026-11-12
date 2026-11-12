// Matched in-memory providers. Fault plans are finite functional tests only.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { createModelCassette } = require('./benchmark-mixed92-providers.cjs');
const { createFakeNotificationAdapters } = require('./benchmark-notifications-adapters.cjs');
const { digest, controlIdentity } = require('./benchmark-mixed95-profile.cjs');
function createAdapters(job, role, manifest) {
  const fake = createFakeNotificationAdapters(manifest, { latencyMs: job.notificationDelayMs });
  const cassette = createModelCassette({ latencyMs: job.modelDelayMs });
  const delivery = job.resources[role].processRole !== 'web';
  const forbidden = { send: 0, poll: 0, model: 0 },
    identityCalls = { telegram: 0 };
  const trace = [],
    totals = {
      sends: 0,
      polls: 0,
      answers: 0,
      clears: 0,
      faults: 0,
      completed: 0,
      traceDropped: 0,
    };
  let active = 0,
    syntheticSequence = 100000;
  const known = (channel, id) =>
    manifest.clients.some((row) => row[channel] === String(id)) ||
    manifest.staffReceivers?.some((row) => row.channel === channel && row.recipient === String(id));
  const record = (channel, kind, recipient, outcome) => {
    if (trace.length >= 256) {
      totals.traceDropped++;
      return;
    }
    trace.push({
      channel,
      kind,
      recipientHash: digest(String(recipient)),
      timeMs: performance.now(),
      outcome,
    });
  };
  async function outbound(channel, kind, recipient, signal, callback) {
    if (!delivery) {
      forbidden[kind === 'polls' ? 'poll' : 'send']++;
      throw Error('Web attempted background transport');
    }
    totals[kind]++;
    active++;
    try {
      record(channel, kind, recipient, 'started');
      if (
        job.functionalScenario === 'telegram429' &&
        channel === 'telegram' &&
        kind === 'sends' &&
        totals.faults === 0
      ) {
        totals.faults++;
        throw Object.assign(Error('Synthetic429'), {
          status: 429,
          statusCode: 429,
          retryAfter: 1,
          deliveryUncertain: false,
        });
      }
      if (
        job.functionalScenario === 'max-answer-retry' &&
        kind === 'answers' &&
        totals.faults === 0
      ) {
        totals.faults++;
        throw Object.assign(Error('Synthetic callback outage'), { status: 503 });
      }
      if (job.functionalScenario === 'slow-telegram' && channel === 'telegram' && kind === 'sends')
        await sleep(3000, undefined, { signal });
      const result = await callback();
      totals.completed++;
      record(channel, kind, recipient, 'completed');
      return result;
    } catch (error) {
      record(channel, kind, recipient, 'error-' + (error.status || error.name));
      throw error;
    } finally {
      active--;
    }
  }
  const initialize = fake.options.telegramBot.initialize;
  fake.options.telegramBot.initialize = async (...args) => {
    identityCalls.telegram++;
    return initialize(...args);
  };
  const telegramSend = fake.options.telegramBot.send,
    updates = fake.options.telegramBot.updates;
  fake.options.telegramBot.send = (...args) =>
    outbound('telegram', 'sends', args[0], args[3], async () => {
      const confirmation = args[2]?.inline_keyboard
        ?.flat()
        .some((item) => item.callback_data?.startsWith('confirm_'));
      if (
        job.mode === 'functional' &&
        !confirmation &&
        known('telegram', args[0]) &&
        typeof args[1] === 'string'
      ) {
        await sleep(3, undefined, { signal: args[3] });
        return { message_id: ++syntheticSequence };
      }
      return telegramSend(...args);
    });
  fake.options.telegramBot.updates = (...args) =>
    outbound('telegram', 'polls', 'bot', args[1], () => updates(...args));
  const maxSend = fake.options.maxBot.send;
  fake.options.maxBot.send = (input) =>
    outbound('max', 'sends', input.recipient?.userId, input.signal, async () => {
      const result =
        job.mode === 'functional' &&
        !input.confirmationToken &&
        known('max', input.recipient?.userId) &&
        input.recipient?.botId === manifest.clients[0].bot
          ? (await sleep(3, undefined, { signal: input.signal }),
            { message: { body: { mid: 'synthetic-extra-' + ++syntheticSequence } } })
          : await maxSend(input);
      // The real generated confirmation proof is observable only to the finite fork
      // parent, never printed or included in a benchmark artifact/control snapshot.
      if (job.mode === 'functional' && input.confirmationToken)
        process.send?.({
          event: 'mixed95-functional-max-send',
          identity: controlIdentity(job, role),
          token: input.confirmationToken,
          userId: input.recipient.userId,
          mid: result.message.body.mid,
        });
      return result;
    });
  fake.options.maxBot.answer = (id, _notification, signal) =>
    outbound('max', 'answers', id, signal, async () => {
      await sleep(3, undefined, { signal });
      return { success: true };
    });
  fake.options.maxBot.clearButtons = (id, signal) =>
    outbound('max', 'clears', id, signal, async () => {
      await sleep(3, undefined, { signal });
      return { success: true };
    });
  const push = fake.options.pushSend;
  fake.options.pushSend = (...args) =>
    outbound('push', 'sends', args[0]?.endpoint, undefined, () => push(...args));
  return {
    fake,
    cassette,
    forbidden,
    identityCalls,
    fetch(...args) {
      if (job.resources[role].processRole === 'background') {
        forbidden.model++;
        throw Error('Background cannot execute assistant');
      }
      return cassette.fetch(...args);
    },
    proof: () => ({ ...totals, active, trace: structuredClone(trace) }),
    async settle() {
      const deadline = Date.now() + 8000;
      while (active && Date.now() < deadline) await sleep(5);
      assert.equal(active, 0, 'Actual role transport did not settle');
      await fake.settle();
    },
  };
}
module.exports = { createAdapters };
