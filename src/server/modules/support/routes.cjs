const { root } = require('../../config.cjs');
const { publicAssetRoot } = require('../../../shared/web-assets.cjs');
const { clientRelease, supportTelegram } = require('../../http/client-release.cjs');
// Public build fingerprint and public contact only; no account or infrastructure details.
const { fail } = require('../../../shared/errors.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/support/improvements',
    access: 'organization',
    async handle({ res, json, url, current, platform }) {
      json(
        res,
        200,
        platform.support.improvements(current, {
          before: url.searchParams.get('before'),
          beforeId: url.searchParams.get('beforeId'),
        }),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/support/improvements',
    access: 'organization',
    async handle({ req, res, json, readBody, current, platform, support, assertCurrent }) {
      const body = await readBody(req, 8192);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body.kind !== undefined && body.kind !== 'improvement')
      )
        throw fail(400, 'Неверный формат предложения.');
      assertCurrent();
      json(res, 202, {
        receipt: platform.support.create(current, { ...body, kind: 'improvement' }, Date.now(), {
          deliveryEnabled: support.status().available,
          emailEnabled: support.status().emailEnabled,
        }),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/app/info',
    access: 'public',
    async handle({ res, json, support }) {
      json(res, 200, {
        version: await clientRelease(publicAssetRoot(root)),
        supportTelegram: supportTelegram(process.env.CARTOTECA_SUPPORT_TELEGRAM),
        supportForm: support.status().available,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/support/requests',
    access: 'session',
    async handle({ req, res, json, readBody, current, platform, support, assertCurrent }) {
      if (!support.status().available) throw fail(503, 'Техподдержка пока не подключена.');
      const body = await readBody(req, 8192);
      assertCurrent();
      json(res, 202, {
        receipt: platform.support.create(current, body, Date.now(), {
          emailEnabled: support.status().emailEnabled,
        }),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/support/requests',
    access: 'session',
    async handle({ res, json, url, current, platform }) {
      json(res, 200, {
        receipt: platform.support.receipt(current.accountId, url.searchParams.get('id') || ''),
      });
    },
  },
];
module.exports = { routes };
