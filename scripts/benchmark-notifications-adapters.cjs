// In-memory transports only: never imports an HTTP provider or reads tokens.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { validateManifest } = require('./benchmark-notifications-fixture.cjs');

function createFakeNotificationAdapters(manifest, { latencyMs = 3 } = {}) {
  validateManifest(manifest);
  assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 1000);
  const clients = {
    telegram: new Map(manifest.clients.map((row) => [row.telegram, row])),
    max: new Map(manifest.clients.map((row) => [row.max, row])),
    push: new Map(manifest.devices.map((row) => [row.endpoint, row])),
  };
  const counters = Object.fromEntries(
    ['telegram', 'max', 'push'].map((channel) => [
      channel,
      {
        attempts: 0,
        acknowledged: 0,
        failures: 0,
        aborted: 0,
        duplicates: 0,
        unknownRecipients: 0,
      },
    ]),
  );
  const seen = new Set(),
    organizations = new Set(),
    accounts = new Set(),
    pushEvents = {};
  let inFlight = 0,
    sequence = 0,
    polls = 0;
  async function send(channel, recipient, key, valid, signal, event = '') {
    const counter = counters[channel];
    counter.attempts++;
    const row = clients[channel].get(recipient);
    if (!row) counter.unknownRecipients++;
    if (!row || !valid || typeof key !== 'string' || !key) {
      counter.failures++;
      throw Object.assign(Error('Synthetic provider rejected unexpected delivery'), {
        deliveryUncertain: false,
        status: 400,
        statusCode: 400,
      });
    }
    inFlight++;
    try {
      await wait(latencyMs, undefined, { signal });
      const digest = createHash('sha256')
        .update(JSON.stringify([channel, recipient, key]))
        .digest('hex');
      if (seen.has(digest)) counter.duplicates++;
      seen.add(digest);
      counter.acknowledged++;
      organizations.add(row.organization);
      if (row.account) accounts.add(row.account);
      if (event) pushEvents[event] = (pushEvents[event] || 0) + 1;
      return ++sequence;
    } catch (error) {
      if (error.name === 'AbortError') counter.aborted++;
      else counter.failures++;
      throw error;
    } finally {
      inFlight--;
    }
  }
  const options = {
    commonNotificationsEnabled: true,
    pushEnabled: true,
    maxEnabled: false,
    maxConnectionsEnabled: true,
    // Synthetic inbound identity enables eligibility; transport remains in-memory.
    maxWebhookSecret: 'synthetic-notification-harness-secret-00000001',
    // Public product username is a composition invariant, not a credential.
    // The numeric identity, recipients and transport remain wholly synthetic.
    maxBotIdentity: { botId: '930000001', username: 'id000000000000_1_bot' },
    telegramBot: {
      initialize: async () => ({ username: 'CartotecaSynthetic_bot', botId: '930000002' }),
      async updates(offset, signal) {
        polls++;
        await wait(20000, undefined, { signal });
        return [];
      },
      async send(chatId, text, markup, signal) {
        const callback = markup?.inline_keyboard
          ?.flat()
          .find((button) => button.callback_data?.startsWith('confirm_'))?.callback_data;
        const id = await send(
          'telegram',
          String(chatId),
          callback,
          typeof text === 'string',
          signal,
        );
        return { message_id: id };
      },
    },
    maxBot: {
      async send({ recipient, text, confirmationToken, signal }) {
        const id = await send(
          'max',
          String(recipient?.userId),
          confirmationToken,
          recipient?.botId === '930000001' && typeof text === 'string',
          signal,
        );
        return { message: { body: { mid: 'synthetic-' + id } } };
      },
    },
    async pushSend(subscription, payload) {
      let value;
      try {
        value = JSON.parse(payload);
      } catch {
        value = {};
      }
      const known = clients.push.get(subscription?.endpoint);
      await send(
        'push',
        subscription?.endpoint,
        value.tag,
        value.data?.organizationId === known?.organization &&
          ['change', 'reminder'].includes(value.data?.event),
        undefined,
        value.data?.event,
      );
      return { statusCode: 201 };
    },
    sendMail: null,
    supportDelivery: {},
    telegramAutostart: false,
    pushAutostart: false,
    maxAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
  };
  return {
    options,
    snapshot() {
      return {
        profile: manifest.profile,
        latencyMs,
        counters: structuredClone(counters),
        inFlight,
        polls,
        deliveredOrganizations: organizations.size,
        deliveredAccounts: accounts.size,
        pushEvents: { ...pushEvents },
        deliveryKeys: [...seen].sort(),
        expected: { ...manifest.expected },
        excluded: [...manifest.excluded, 'booking-publication-maintenance'],
      };
    },
    async settle() {
      const deadline = Date.now() + 2000;
      while (inFlight && Date.now() < deadline) await wait(5);
      if (inFlight) throw Error('Synthetic provider did not settle before deadline');
    },
  };
}

module.exports = { createFakeNotificationAdapters };
