const { fail } = require('../../../shared/errors.cjs');

async function deliverInvitation(context, values) {
  const { current, platform } = context;
  context.assertMailAvailable();
  const identity = { organizationId: current.organizationId, actorId: current.accountId };
  const invitation = platform.prepareEmailInvitation({ ...identity, ...values });
  const delivery = { ...identity, invitationId: invitation.id, token: invitation.token };
  try {
    await context.sendInvitation(invitation);
    context.assertCurrent();
  } catch (error) {
    try {
      platform.finishEmailInvitation(delivery, false);
    } catch {
      /* A revoked/rotated link stays invalid. */
    }
    throw error.status
      ? error
      : fail(503, 'Письмо не отправлено. Попробуйте повторную отправку позже.');
  }
  const completed = platform.finishEmailInvitation(delivery, true);
  if (completed.error) throw completed.error;
  return {
    message: 'Приглашение отправлено на почту. Доступ появится после его принятия.',
    access: {
      ...platform.organizationAccess(current.organizationId, current.accountId),
      invitationMailConfigured: true,
    },
  };
}
module.exports = { deliverInvitation };
