// Provider authentication, not browser cookies/CSRF. Only this exact route is exempt.
const { fail } = require('../../../shared/errors.cjs');
const { maxJSONReviver } = require('./max-adapter.cjs');
const routes = [
  {
    method: 'POST',
    path: '/api/max/webhook',
    access: 'public',
    provider: 'max',
    async handle(c) {
      const secret = c.req.headers['x-max-bot-api-secret'];
      c.maxRuntime.authenticate(secret);
      if (c.req.headers['content-encoding'] && c.req.headers['content-encoding'] !== 'identity')
        throw fail(415, 'Сжатые события MAX не поддерживаются.');
      if (Number(c.req.headers['content-length'] || 0) > 32768)
        throw fail(413, 'Превышен размер события MAX.');
      c.req.setTimeout(10000, () => c.req.destroy());
      const event = await c.readBody(c.req, 32768, maxJSONReviver);
      const result = c.maxRuntime.accept(secret, event);
      // 200 only after the encrypted inbox transaction committed. No patient data in response.
      return c.json(c.res, 200, result);
    },
  },
];
module.exports = { routes };
