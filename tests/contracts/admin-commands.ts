import type {
  OrganizationAccessCommand,
  OrganizationProfileCommand,
  SubscriptionCommand,
  EmailRecoveryCommand,
  SupportMessageCommand,
  SupportStateCommand,
} from '../../src/client/contracts/administration';

const common = { requestId: '00000000-0000-4000-8000-000000000000', expectedRevision: 0 };
const access: OrganizationAccessCommand = {
  ...common,
  organizationId: 'o',
  status: 'suspended',
  reason: 'Reviewed',
};
const profile: OrganizationProfileCommand = {
  ...common,
  organizationId: 'o',
  changes: { city: 'Казань' },
};
const subscription: SubscriptionCommand = {
  ...common,
  organizationId: 'o',
  reason: 'Manual access',
  plan: 'paid',
  limits: { patients: 100, photos: 500, publicBooking: true, automaticNotifications: false },
};
const recovery: EmailRecoveryCommand = {
  ...common,
  accountId: 'a',
  email: 'new@example.test',
  password: 'synthetic',
  reason: 'Verified owner',
  identityConfirmed: true,
};
const state: SupportStateCommand = { ...common, caseId: 'c', state: 'waiting', claim: true };
const message: SupportMessageCommand = { ...common, caseId: 'c', kind: 'internal', text: 'Note' };
// @ts-expect-error Blocking an organization must never implicitly change its plan.
const mixed: OrganizationAccessCommand = { ...access, plan: 'paid' };
// @ts-expect-error Identity verification cannot be skipped.
const unverified: EmailRecoveryCommand = { ...recovery, identityConfirmed: false };
// @ts-expect-error A message is not a case-state command.
const wrongState: SupportStateCommand = { ...state, text: 'Reply' };
const wrongLimits: SubscriptionCommand = {
  ...subscription,
  // @ts-expect-error Runtime counts and flags have distinct types.
  limits: { ...subscription.limits, photos: '500' },
};
void [
  access,
  profile,
  subscription,
  recovery,
  state,
  message,
  mixed,
  unverified,
  wrongState,
  wrongLimits,
];
