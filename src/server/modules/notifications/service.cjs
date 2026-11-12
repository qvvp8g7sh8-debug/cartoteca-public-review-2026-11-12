const { fail } = require('../../../shared/errors.cjs');
function createNotifications({ channels = {}, outbox } = {}) {
  return {
    status: () => ({ connected: Object.keys(channels), queueConnected: Boolean(outbox) }),
    async enqueue({ organizationId, channel, recipient, template, payload, idempotencyKey }) {
      if (!organizationId || !channel || !recipient || !template || !idempotencyKey)
        throw fail(400, 'Неполные данные уведомления.');
      if (!outbox || !channels[channel]) throw fail(503, 'Канал уведомлений не подключён.');
      return outbox.enqueue({
        organizationId,
        channel,
        recipient,
        template,
        payload,
        idempotencyKey,
      });
    },
    async deliver(job) {
      const adapter = channels[job.channel];
      if (!adapter) throw fail(503, 'Канал уведомлений не подключён.');
      return adapter.send({
        recipient: job.recipient,
        template: job.template,
        payload: job.payload,
        idempotencyKey: job.idempotencyKey,
      });
    },
  };
}
module.exports = { createNotifications };
