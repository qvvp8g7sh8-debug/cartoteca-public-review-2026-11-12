// Platform DTOs only. Organization membership never implies platform capabilities.
export type AdminAccess = 'active' | 'suspended';
export type AdminPlan = 'free' | 'paid';
export type SupportState = 'new' | 'in_progress' | 'waiting' | 'resolved';
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'waiting';
export interface AdminCommand {
  requestId: string;
  expectedRevision: number;
}
export interface ReasonedCommand extends AdminCommand {
  reason: string;
}
export interface OrganizationProfileCommand extends AdminCommand {
  organizationId: string;
  changes: {
    name?: string;
    city?: string;
    phone?: string;
  };
}
export interface OrganizationAccessCommand extends ReasonedCommand {
  organizationId: string;
  status: AdminAccess;
}
export interface SubscriptionLimits {
  patients: number;
  photos: number;
  publicBooking: boolean;
  automaticNotifications: boolean;
}
export interface SubscriptionCommand extends ReasonedCommand {
  organizationId: string;
  plan: AdminPlan;
  limits: SubscriptionLimits;
}
export interface AccountAccessCommand extends ReasonedCommand {
  accountId: string;
  status: AdminAccess;
}
export interface AccountSessionsCommand extends ReasonedCommand {
  accountId: string;
}
export interface EmailRecoveryCommand extends AccountSessionsCommand {
  email: string;
  identityConfirmed: true;
  password: string;
}
export interface SupportStateCommand extends AdminCommand {
  caseId: string;
  state: SupportState;
  claim?: boolean;
}
export interface SupportMessageCommand extends AdminCommand {
  caseId: string;
  kind: 'internal' | 'reply';
  text: string;
}
export interface AdminCommandResult {
  ok: true;
  revision: number;
  pending?: boolean;
  queued?: boolean;
  messageId?: string;
  recoveryId?: string;
  expiresAt?: number;
}
export interface AdminPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}
export interface AdminOrganization {
  id: string;
  name: string;
  city: string;
  phone: string;
  timeZone: string;
  ownerId: string | null;
  ownerName: string;
  ownerEmail: string;
  status: AdminAccess;
  createdAt: number;
  plan: AdminPlan | null;
  subscriptionStatus: string | null;
  limits: SubscriptionLimits | null;
  members: number;
}
export interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  globalAdmin: boolean;
  status: AdminAccess;
  createdAt: number;
  emailVerified: boolean;
}
export interface AdminOrganizationDetail extends Omit<AdminOrganization, 'members'> {
  revision: number;
  subscriptionRevision: number;
  subscriptionChangedAt: number | null;
  lastActivityAt: number | null;
  members: {
    accountId: string;
    role: string;
    status: AdminAccess;
    displayName: string;
    email: string;
  }[];
  usage: { available: boolean; patients?: number; photos?: number; initialized?: boolean };
  subscriptionTerms: {
    source: 'manual';
    actorId: string;
    at: number;
    reason: string;
    paymentVerified: false;
  } | null;
}
export interface AdminAccountDetail extends AdminAccount {
  revision: number;
  lastLoginAt: number | null;
  sessions: number;
  memberships: {
    organizationId: string;
    organizationName: string;
    role: string;
    status: AdminAccess;
  }[];
  mailConfigured: boolean;
  recovery: { id: string; expiresAt: number; email: string; deliveries: AdminDelivery[] } | null;
}
export interface AdminDelivery {
  kind: string;
  status: DeliveryState;
  attempts: number;
}
export interface AdminSupportMessage {
  id: string;
  kind: 'internal' | 'reply' | 'author';
  createdAt: number;
  text: string;
  actorId: string;
  deliveries: AdminDelivery[];
}
export interface AdminSupportCase {
  id: string;
  accountId: string;
  organizationId: string | null;
  displayName: string;
  email: string;
  organization: string;
  description: string;
  revision: number;
  state: SupportState;
  createdAt: number;
  changedAt: number;
  assignedTo: string | null;
  mailConfigured: boolean;
  messages: AdminSupportMessage[];
  messagesNext: { before: number; beforeId: string } | null;
  deliveries: { channel: string; status: DeliveryState; attempts: number }[];
}
/** Allowlisted recovery metadata; never an archive/key/endpoint or patient record. */
export type BackupState =
  | 'preparing'
  | 'copying'
  | 'uploading'
  | 'drilling'
  | 'protected'
  | 'local_only'
  | 'failed'
  | 'interrupted';
export type BackupError =
  | 'BACKUP_FAILED'
  | 'BACKUP_DISK_SPACE'
  | 'BACKUP_REMOTE_FAILED'
  | 'BACKUP_REMOTE_RETENTION'
  | 'BACKUP_REMOTE_CHECKSUM'
  | 'BACKUP_DRILL_FAILED'
  | 'BACKUP_LEASE_LOST'
  | 'BACKUP_SOURCE_TOO_LARGE';
export interface AdminBackupStatus {
  configured: boolean;
  health: 'unconfigured' | 'unavailable' | 'stale' | 'failed' | 'incomplete' | 'protected';
  remoteConfigured?: boolean;
  observedAt?: number | null;
  lastLocalAt?: number | null;
  lastRemoteAt?: number | null;
  lastDrillAt?: number | null;
  cadenceHours?: number | null;
  state?: BackupState;
  error?: BackupError | null;
  durationMilliseconds?: number | null;
  archiveBytes?: number | null;
  availableBytes?: number | null;
  recent?: { startedAt: number | null; finishedAt: number | null; state: BackupState }[];
}
