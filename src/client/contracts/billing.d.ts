import type { ReasonedCommand } from './administration';

export interface PaidPackage {
  id: string;
  title: string;
  priceKopecks: number;
  taskLimit: number;
  enabled: boolean;
  version: number;
}
export interface PaidPackageSubscription {
  active: boolean;
  packageId: string | null;
  title: string | null;
  source: 'paid' | 'trial' | null;
  testMode?: boolean;
  enabled?: boolean;
  connectionRevision?: number;
  startsAt: number | null;
  endsAt: number | null;
  taskLimit: number;
  usedTasks: number;
  reservedTasks: number;
  remainingTasks: number;
}
export interface PaidServicesView {
  available: boolean;
  packages: PaidPackage[];
  subscription: PaidPackageSubscription | null;
  paymentReady: boolean;
  receiptEmailRequired: true;
  termsVersion: 'packages-20261019-draft';
  paymentNotice: string;
}
export interface PackageCheckoutCommand {
  packageId: string;
  packageVersion: number;
  requestId: string;
  receiptEmail: string;
  acceptedTermsVersion: PaidServicesView['termsVersion'];
}
export interface PackagePayment {
  checkoutId: string;
  status: 'creating' | 'pending' | 'succeeded' | 'canceled' | 'uncertain' | 'review' | 'rejected';
  confirmationUrl?: string | null;
  testMode?: boolean;
  notice?: string;
  receiptRegistration?: 'pending' | 'succeeded' | 'canceled' | null;
}
export type AdminPaymentReviewAction =
  | 'reconcile'
  | 'retry_create'
  | 'request_refund_review'
  | 'request_receipt_review'
  | 'check_refund'
  | 'check_receipt';
export interface AdminPaymentReviewState {
  status: string;
  checkedAt?: number;
  automatic?: false;
  knownRefundedKopecks?: number;
  records?: unknown[];
}
export interface AdminPaymentOrder extends PackagePayment {
  id?: string;
  revision?: number;
  title?: string;
  time?: number;
  createdAt?: number;
  priceKopecks?: number;
  canRetryCreate?: boolean;
  reconciliation?: AdminPaymentReviewState;
  refund?: AdminPaymentReviewState;
  closingReceipt?: AdminPaymentReviewState;
}
export interface AdminPaymentReviewCommand extends ReasonedCommand {
  checkoutId: string;
  action: AdminPaymentReviewAction;
  paymentId?: string;
  referenceId?: string;
}
export interface AdminPackageSummary {
  paidRevenueRub: number;
  providerCostRub: number;
  trialGrants: number;
  activePackages: number;
  uncoveredRub?: number;
  uncertainCalls?: number;
  pendingReservations?: number;
  paidRevenueKopecks?: string;
  providerCostMicrorub?: string;
}
export interface AdminPackageOrganization {
  organizationId: string;
  organizationName: string;
  subscription: PaidPackageSubscription | null;
  costRub: number;
  paidRub: number;
  paidKopecks?: string;
  costMicrorub?: string;
}
export interface PackageReceiptConfiguration {
  fiscalProvider: '' | 'external' | 'yookassa';
  purchaseModel: 'package';
  paymentMode: '' | 'full_payment' | 'full_prepayment';
  vatCode: number | null;
  taxSystemCode: number | null;
  paymentSubject: '' | 'payment' | 'service' | 'property_right' | 'intellectual_activity';
  description: string;
}
export interface AdminPaymentConfiguration {
  configured: boolean;
  revision: number;
  shopId: string;
  secretConfigured: boolean;
  returnOrigin: string;
  testMode: boolean;
  receiptConfig: PackageReceiptConfiguration;
  ready: boolean;
  notice: string;
  networkEnabled?: boolean;
}
export type AdminBillingScope =
  { type: 'platform' } | { type: 'organization'; organizationId: string; name: string };
export interface AdminBillingSummaryView {
  available: boolean;
  summary: AdminPackageSummary;
  periodLabel: string;
  scope: AdminBillingScope;
}
export interface AdminBillingOrganizationsView {
  available: boolean;
  organizations: AdminPackageOrganization[];
  nextOffset: number | null;
  total: number;
}
export interface AdminBillingOrdersView {
  available: boolean;
  orders: AdminPaymentOrder[];
  nextCursor: string | null;
}
export interface AdminBillingView extends AdminBillingSummaryView {
  available: boolean;
  catalogRevision: number;
  configured: boolean;
  packages: PaidPackage[];
  summary: AdminPackageSummary;
  organizations: AdminPackageOrganization[];
  organization?: { id: string; name: string };
  subscription?: PaidPackageSubscription | null;
  paymentConfiguration: AdminPaymentConfiguration;
  orders?: AdminPaymentOrder[];
  nextOffset?: number | null;
  organizationTotal?: number;
  ordersNextCursor?: string | null;
}
export interface AdminPackageCommand extends ReasonedCommand {
  id: string;
  title: string;
  priceRub: string;
  taskLimit: number;
  enabled: boolean;
}
export interface AdminPackageTrialCommand extends Pick<ReasonedCommand, 'requestId' | 'reason'> {
  organizationId: string;
  packageId: string;
}
export interface AdminPaymentSettingsCommand extends ReasonedCommand {
  configured: boolean;
  shopId: string;
  /** Write only. Omit to preserve; never returned by the server. */
  secretKey?: string;
  clearSecret?: boolean;
  returnOrigin: string;
  testMode: boolean;
  receiptConfig: PackageReceiptConfiguration;
}
