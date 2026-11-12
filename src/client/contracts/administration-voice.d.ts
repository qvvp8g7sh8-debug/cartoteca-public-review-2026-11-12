// Platform policy only; no audio, patient, appointment or transcript DTOs.
export type VoiceAssistantProvider = 'demo' | 'timeweb' | 'local';
export type VoiceAssistantLlmProvider = 'demo' | 'timeweb' | 'codex';
export type VoiceAssistantExampleSelection = 'manual' | 'automatic';
export interface VoiceAssistantLimits {
  monthlyBudgetRub: number;
  dailyRequests: number;
  maxTextChars: number;
  maxAudioSeconds: number;
  maxReplyChars: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
}
export type VoiceAssistantMemberLimits = Partial<Omit<VoiceAssistantLimits, 'monthlyBudgetRub'>>;
export interface VoiceAssistantPolicy {
  exampleSelection: VoiceAssistantExampleSelection;
  mode: 'off' | 'selected';
  commands: {
    calendar: boolean;
    clients: boolean;
    prepareAppointment: boolean;
  };
  limits: VoiceAssistantLimits;
  instructions: string;
  dictionary: string;
  examples: VoiceAssistantBehaviorExample[];
}
export interface VoiceAssistantProviders {
  stt: { provider: VoiceAssistantProvider; model: string };
  llm: { provider: VoiceAssistantLlmProvider; model: string };
  tts: { provider: VoiceAssistantProvider; model: string; voice: string };
}
export interface VoiceAssistantRates {
  llmInput: number;
  llmOutput: number;
  sttInput: number;
  sttOutput: number;
  ttsInput: number;
  ttsOutput: number;
}
export interface VoiceAssistantMembership {
  organizationId: string;
  accountId: string;
  membershipId: string;
  organizationName: string;
  displayName: string;
  role: string;
  status: 'active' | 'suspended';
}
export interface AdminVoiceAssistant {
  revision: number;
  policy: VoiceAssistantPolicy;
  providers: VoiceAssistantProviders;
  credentialStatus: { timeweb: { configured: boolean } };
  providerStatus: {
    codex: {
      available: boolean;
      localOnly: true;
      billing: 'codex-subscription';
    };
    local: {
      available: boolean;
      localOnly: true;
      billing: 'local';
      stt: { available: boolean };
      tts: { available: boolean };
    };
  };
  rates: VoiceAssistantRates;
  usage: { month: string; spentRub: number; reservedRub: number };
  memberships: VoiceAssistantMembership[];
  membershipsTruncated: boolean;
  grants: {
    organizationId: string;
    accountId: string;
    membershipId: string;
    limits?: VoiceAssistantMemberLimits;
  }[];
  history: { revision: number; time: number }[];
}
export interface AdminVoiceMember {
  revision: number;
  enabled: boolean;
  membershipId: string;
  effective: { enabled: boolean; reason: string };
  limits: VoiceAssistantMemberLimits | null;
  effectiveLimits: VoiceAssistantLimits;
}
export interface AdminVoiceSettingsCommand {
  expectedRevision: number;
  requestId: string;
  reason: string;
  policy?: Partial<
    Omit<VoiceAssistantPolicy, 'instructions' | 'dictionary' | 'examples' | 'exampleSelection'>
  >;
  providers?: VoiceAssistantProviders;
  rates?: VoiceAssistantRates;
  /** Omit to preserve, null to delete. Never appears in a response. */
  timewebApiKey?: string | null;
}
export interface AdminVoiceMemberCommand {
  expectedRevision: number;
  requestId: string;
  reason: string;
  organizationId: string;
  accountId: string;
  enabled: boolean;
  /** Omit to preserve; null clears personal overrides. Paid budget remains global. */
  limits?: VoiceAssistantMemberLimits | null;
}
export interface AdminVoiceRestoreCommand {
  expectedRevision: number;
  requestId: string;
  reason: string;
  revision: number;
}

export interface VoiceAssistantBehaviorExpected {
  mode?: 'day' | 'week' | 'month';
  endDate?: string;
  endTime?: string;
  intent: 'help' | 'calendar' | 'clients' | 'clientCard' | 'availability' | 'prepareAppointment';
  query?: string;
  date?: string;
  time?: string;
  staffQuery?: string;
  serviceQuery?: string;
  duration?: number;
}
export interface VoiceAssistantBehaviorExample {
  id: string;
  text: string;
  referenceDate: string;
  referenceTime: string;
  enabled: boolean;
  expected: VoiceAssistantBehaviorExpected;
}
export interface VoiceAssistantBehaviorRules {
  exampleSelection: VoiceAssistantExampleSelection;
  instructions: string;
  dictionary: string;
  examples: VoiceAssistantBehaviorExample[];
}
export interface VoiceAssistantBehaviorVersion {
  version: number;
  time: number | null;
  actorId: string | null;
  reason: string;
  current: boolean;
}
export interface AdminVoiceBehavior {
  revision: number;
  version: number;
  rules: VoiceAssistantBehaviorRules;
  versions: VoiceAssistantBehaviorVersion[];
  limits: {
    maxExamples: number;
    maxEnabledExamples: number;
    maxCandidateExamples: number;
    maxExampleTextChars: number;
    maxEnabledExamplesBytes: number;
    maxInstructionsChars: number;
    maxDictionaryChars: number;
    maxRulesBytes: number;
    maxCodexInputBytes: number;
  };
  llmProvider: { provider: VoiceAssistantLlmProvider; model: string };
}
export interface VoiceAssistantBehaviorChanges {
  exampleSelection: {
    changed: boolean;
    before: VoiceAssistantExampleSelection;
    after: VoiceAssistantExampleSelection;
  };
  instructions: { changed: boolean; before: string; after: string };
  dictionary: { changed: boolean; before: string; after: string };
  examples: {
    added: VoiceAssistantBehaviorExample[];
    removed: VoiceAssistantBehaviorExample[];
    changed: {
      id: string;
      before: VoiceAssistantBehaviorExample;
      after: VoiceAssistantBehaviorExample;
    }[];
    orderChanged: boolean;
  };
}
export interface AdminVoiceBehaviorComparison {
  revision: number;
  fromVersion: number;
  toVersion: number;
  before: VoiceAssistantBehaviorRules;
  after: VoiceAssistantBehaviorRules;
  changes: VoiceAssistantBehaviorChanges;
}
export type AdminVoiceBehaviorPreviewCommand = { expectedRevision: number } & (
  | { rules: VoiceAssistantBehaviorRules; sourceVersion?: never }
  | { sourceVersion: number; rules?: never }
);
export interface AdminVoiceBehaviorPreview {
  revision: number;
  version: number;
  sourceVersion: number | null;
  rules: VoiceAssistantBehaviorRules;
  changes: VoiceAssistantBehaviorChanges;
  reviewHash: string;
}
export interface AdminVoiceBehaviorApproveCommand {
  expectedRevision: number;
  requestId: string;
  reason: string;
  rules: VoiceAssistantBehaviorRules;
  reviewHash: string;
  confirmed: true;
}
export interface AdminVoiceBehaviorRestoreCommand {
  expectedRevision: number;
  requestId: string;
  reason: string;
  sourceVersion: number;
  reviewHash: string;
  confirmed: true;
}

export type VoiceAssistantScenarioStatus =
  'supported' | 'manual' | 'needs_clarification' | 'unsupported';
export interface VoiceAssistantScenarioContext {
  referenceDate: string;
  referenceTime: string;
  timeZone: string;
  locale?: string;
}
export interface VoiceAssistantScenario {
  id: string;
  category: string;
  title?: string;
  text: string;
  referenceDate: string;
  referenceTime: string;
  timeZone: string;
  context?: VoiceAssistantScenarioContext;
  current: {
    intent: VoiceAssistantBehaviorExpected | null;
    status: VoiceAssistantScenarioStatus;
    outcome: string;
    limitations: string[];
  };
  tags: string[];
  preconditions?: string[];
  futureTarget?: {
    capability: string;
    fields?: Record<string, unknown>;
    notes?: string;
  };
}
export interface AdminVoiceScenarioLibrary {
  schemaVersion: 1;
  context: VoiceAssistantScenarioContext;
  total: number;
  offset: number;
  limit: number;
  categories: { id: string; title: string; count: number }[];
  statuses: {
    id: VoiceAssistantScenarioStatus;
    title: string;
    count: number;
  }[];
  packs: { id: string; title: string; description: string; count?: number }[];
  cases: VoiceAssistantScenario[];
}
