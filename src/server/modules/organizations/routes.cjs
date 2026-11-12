const { fail } = require('../../../shared/errors.cjs');
const { deliverInvitation } = require('./invitation-delivery.cjs');
const routes = [
  {
    method: 'POST',
    path: '/api/organization/specialty',
    access: 'organization',
    async handle(context) {
      const values = await context.readBody(context.req);
      context.assertCurrent();
      return context.json(context.res, 200, {
        ...context.platform.updateStaffSpecialty(context.token, values),
        invitationMailConfigured: context.invitationMailConfigured,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/organization/access',
    access: 'session',
    async handle(context) {
      const {
        req,
        res,
        url,
        current,
        platform,
        token,
        tenantStore,
        json,
        readBody,
        setCookie,
        sendLink,
        clientAddress,
        expectedOrigin,
      } = context;

      return json(res, 200, {
        ...platform.organizationAccess(current.organizationId, current.accountId),
        assistant: platform.assistant.access(current),
        invitationMailConfigured: context.invitationMailConfigured,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/organization/invitations',
    access: 'organization',
    async handle(context) {
      const body = await context.readBody(context.req);
      const result = await deliverInvitation(context, { role: body.role, email: body.email });
      return context.json(context.res, 201, result);
    },
  },
  {
    method: 'POST',
    path: '/api/organization/invitations/resend',
    access: 'organization',
    async handle(context) {
      const body = await context.readBody(context.req);
      const result = await deliverInvitation(context, { invitationId: body.invitationId });
      return context.json(context.res, 200, result);
    },
  },
  {
    method: 'POST',
    path: '/api/organization/invitations/revoke',
    access: 'organization',
    async handle(context) {
      const body = await context.readBody(context.req);
      context.platform.revokeEmailInvitation({
        organizationId: context.current.organizationId,
        actorId: context.current.accountId,
        invitationId: body.invitationId,
      });
      return context.json(context.res, 200, {
        message: 'Приглашение отозвано.',
        access: {
          ...context.platform.organizationAccess(
            context.current.organizationId,
            context.current.accountId,
          ),
          invitationMailConfigured: context.invitationMailConfigured,
        },
      });
    },
  },
  {
    method: 'POST',
    path: '/api/organization/members',
    access: 'session',
    async handle(context) {
      const {
        req,
        res,
        url,
        current,
        platform,
        token,
        tenantStore,
        json,
        readBody,
        setCookie,
        sendLink,
        clientAddress,
        expectedOrigin,
      } = context;

      const body = await readBody(req);
      return json(res, 200, {
        ...platform.updateMembership({
          organizationId: current.organizationId,
          actorId: current.accountId,
          accountId: body.accountId,
          role: body.role,
          status: body.status,
        }),
        invitationMailConfigured: context.invitationMailConfigured,
      });
    },
  },
];
module.exports = { routes };
