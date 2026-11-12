const { privacyConsent } = require('../../../shared/privacy-consent.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/admin/security/mfa',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, c.platform.adminMfa.status(c.token));
    },
  },
  ...['prepare', 'enable', 'disable', 'recovery'].map((action) => ({
    method: 'POST',
    path: '/api/admin/security/mfa/' + action,
    access: 'global',
    async handle(c) {
      const input = await c.readBody(c.req, 2048);
      c.assertCurrent();
      const result = await c.platform.adminMfa[action](c.token, input, {
        assertCurrent: c.assertCurrent,
      });
      c.assertCurrent();
      return c.json(c.res, 200, result);
    },
  })),
  {
    method: 'GET',
    path: '/api/account/profile',
    access: 'session',
    async handle(c) {
      return c.json(c.res, 200, c.platform.accountProfile(c.token));
    },
  },
  {
    method: 'POST',
    path: '/api/account/profile',
    access: 'session',
    async handle(c) {
      const values = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.updateAccountProfile(c.token, values));
    },
  },
  {
    method: 'GET',
    path: '/api/auth/session',
    access: 'public',
    async handle(context) {
      const { res, current, platform, json } = context;
      const session = current;
      return json(res, 200, {
        multiUser: true,
        lazyReads: true,
        configured: platform.hasAccounts(),
        assistant: platform.assistant.access(session),
        ...(session && !session.organizationId
          ? { organizationAccess: session.organizationAccess || 'none' }
          : {}),
        user: session
          ? {
              id: session.accountId,
              email: session.email,
              displayName: session.displayName,
              role: session.role,
              globalAdmin: session.globalAdmin,
              organizationId: session.organizationId,
            }
          : null,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/register',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody, sendLink, clientAddress } = context;

      const body = await readBody(req);
      context.assertMailAvailable();
      platform.consumePublicAuthRequest('register', body.email, clientAddress(req));
      const consent = privacyConsent(body, 'registration');
      const created = await platform.registerOwner(
        { ...body, privacyConsent: consent },
        clientAddress(req),
      );
      // An unverified signup must not allocate a clinical database or photo directory.
      // The tenant pool creates them lazily on the first authorized clinical request.
      try {
        await sendLink(
          body.email.trim().toLowerCase(),
          'verify-email',
          created.verificationToken,
          'verify',
        );
      } catch (error) {
        platform.revokeEmailVerification(created.verificationToken);
        throw error;
      }
      return json(res, 201, { message: 'Проверьте почту и подтвердите регистрацию.' });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/verify-email',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody } = context;

      platform.verifyEmail((await readBody(req)).token);
      return json(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody, setCookie, clientAddress } = context;

      const body = await readBody(req);
      const result = await platform.login(
        body.email,
        body.password,
        req.headers['user-agent'],
        clientAddress(req),
        body.oneTimeCode,
      );
      setCookie(res, result.token);
      return json(res, 200, {
        user: result.account,
        memberships: result.memberships,
        organizationId: result.organizationId,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    access: 'public',
    async handle(context) {
      const { res, platform, token, json } = context;
      platform.logout(token);
      // Revocation is server-side. A delayed response must not expire a newer account cookie.
      return json(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/select-organization',
    access: 'public',
    async handle(context) {
      const { req, res, platform, token, json, readBody } = context;
      return json(
        res,
        200,
        platform.selectOrganization(token, (await readBody(req)).organizationId),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/auth/forgot',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody, sendLink, clientAddress } = context;

      const body = await readBody(req);
      context.assertMailAvailable();
      platform.consumePublicAuthRequest('forgot', body.email, clientAddress(req));
      const reset = platform.requestPasswordReset(body.email);
      if (reset)
        try {
          await sendLink(body.email.trim().toLowerCase(), 'reset', reset, 'reset');
        } catch (error) {
          platform.revokePasswordReset(reset);
          throw error;
        }
      return json(res, 200, { message: 'Если учётная запись существует, ссылка отправлена.' });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/reset',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody } = context;
      const body = await readBody(req);
      await platform.resetPassword(body.token, body.password);
      // Reset revokes the recipient's sessions without changing another account's browser cookie.
      return json(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/invitations/accept',
    access: 'public',
    async handle(context) {
      const { req, res, platform, json, readBody, clientAddress } = context;

      const body = await readBody(req);
      const info = platform.emailInvitationInfo(body.token);
      const consent = info.passwordSetupRequired ? privacyConsent(body, 'registration') : null;
      const accepted = await platform.acceptEmailInvitation(
        { ...body, privacyConsent: consent },
        clientAddress(req),
      );
      return json(res, 200, accepted);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/invitations/info',
    access: 'public',
    async handle(context) {
      const body = await context.readBody(context.req);
      return context.json(context.res, 200, context.platform.emailInvitationInfo(body.token));
    },
  },
];
module.exports = { routes };
