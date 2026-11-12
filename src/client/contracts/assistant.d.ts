export interface AssistantSpeechPermit {
  token: string;
  answerableText: string;
  readonlyText: string;
  handoffText: string;
}
export type AssistantIntentName =
  | 'help'
  | 'calendar'
  | 'clients'
  | 'clientCard'
  | 'availability'
  | 'prepareAppointment'
  | 'moveAppointment'
  | 'cancelAppointment'
  | 'editAppointment';
export type AssistantDialogueField = 'client' | 'staff' | 'service' | 'date' | 'time' | 'duration';
export interface AssistantDialogue {
  id: string;
  version: number;
  step: AssistantDialogueField | 'review' | 'availability' | 'appointment';
  prompt: string;
  information?: boolean;
  manualInputRequired?: boolean;
  serviceGroupTitle?: string;
  phase?:
    | 'date'
    | 'period'
    | 'slots'
    | 'closedDay'
    | 'clientChoice'
    | 'serviceChoice'
    | 'appointmentChoice'
    | 'cancelConfirmation';
  controls?: { id: string; label: string }[];
  options: { id: string; label: string; suggested?: boolean }[];
  fields: { key: AssistantDialogueField; label: string; value: string }[];
  canEdit: AssistantDialogueField[];
  input: {
    type: 'text' | 'date' | 'time' | 'number';
    field: AssistantDialogueField | 'appointment';
  } | null;
  expiresAt: number;
}
export type AssistantAction =
  | { type: 'calendar'; date: string; mode?: 'day' | 'week' | 'month'; staffId?: string }
  | { type: 'clients'; query: string }
  | { type: 'clientCard'; patientId: string }
  | {
      type: 'appointmentPreview';
      operation: 'move' | 'edit' | 'cancel';
      patientId: string;
      appointmentId: string;
      sourceStamp: string;
      date?: string;
      time?: string;
      roomId?: string;
    }
  | {
      type: 'prepareAppointment';
      patientId: string;
      staffId: string;
      date: string;
      time: string;
      duration: number;
      serviceIds?: string[];
      roomId?: string;
    }
  | { type: 'cancelAppointment'; executionId: string }
  | { type: 'moveAppointment'; executionId: string }
  | {
      type: 'createAppointment';
      executionId: string;
      patientId: string;
      staffId: string;
      date: string;
      time: string;
      duration: number;
      serviceIds?: string[];
      roomId?: string;
    };
export interface AssistantAppointmentExecutionReply {
  taskRequestId?: string;
  speechPermit?: AssistantSpeechPermit;
  saved: true;
  alreadySaved?: true;
  appointmentId: string | null;
  operation?: 'cancel' | 'move';
  cancelled?: true;
  moved?: true;
  text: string;
  policyVersion: number;
  action: { type: 'calendar'; date: string; staffId: string } | null;
}
export interface AssistantTurnReply {
  taskRequestId?: string;
  speechPermit?: AssistantSpeechPermit;
  speech?: AssistantSpeakReply & { expiresAt: number };
  speechReplay?: true;
  draftCancelled?: true;
  text: string;
  policyVersion: number;
  demo?: boolean;
  action: AssistantAction | null;
  dialogue?: AssistantDialogue | null;
  readOnlySlots?: {
    date: string;
    time: string;
    endTime: string;
    duration: number;
    staffName: string;
  }[];
}
export interface AssistantAppointmentExecutionNeedsInputReply {
  saved: false;
  definitive: true;
  code: 'ASSISTANT_EXECUTION_REQUIRES_INPUT';
  policyVersion: number;
  recovery: AssistantTurnReply & { action: null; dialogue: AssistantDialogue };
}
export type AssistantAppointmentExecutionResult =
  | AssistantAppointmentExecutionReply
  | AssistantAppointmentExecutionNeedsInputReply
  | {
      saved: false;
      definitive: true;
      code: 'ASSISTANT_EXECUTION_EXPIRED';
      text: string;
      action: null;
      policyVersion: number;
    };
export type AssistantTurnCommand = {
  speech?: { format: 'pcm'; stream: true; mode: 'answerable' };
} & (
  | { text: string }
  | ({ dialogueId: string; dialogueVersion: number } & (
      { text: string } | { choice: string } | { edit: AssistantDialogueField } | { cancel: true }
    ))
);

/** Only opaque dialogue metadata is accepted; hint text is computed by the server. */
export interface AssistantTranscribeCommand {
  audioBase64: string;
  mimeType: 'audio/wav';
  policyVersion: number;
  availabilityTurn?: 'plain' | 'pcm';
  dialogueId?: string;
  dialogueVersion?: number;
}
export interface AssistantSpeechContext {
  dialogueId: string;
  dialogueVersion: number;
  step: AssistantDialogue['step'];
  optionCount: number;
  phase?: AssistantDialogue['phase'];
}
export interface AssistantCaptureOptions {
  /** Internal consumer clone of a microphone held only by the active voice session. */
  acquireMedia?: () => Promise<MediaStream>;
  silenceStop?: boolean;
  initialCommand?: boolean;
  startCue?: boolean;
  shortAnswer?: boolean;
  /** Explicit endpoint profile; false preserves a full-phrase pause with short-answer onset. */
  shortSilence?: boolean;
}
/** In-memory numeric offsets from the last observed VAD-positive frame, or turn start.
 * pcmRenderStartMs is a worklet render acknowledgement, not physical speaker latency.
 * Missing keys mean unobserved phases. Server spans overlap and must not be added.
 */
export interface AssistantTurnTiming {
  readonly turn: number;
  readonly vadOrigin: 0 | 1;
  readonly [metric: string]: number;
}

/** Stream tickets are same-origin, short-lived and bound to the current authenticated scope. */
export interface AssistantSpeakCommand {
  taskRequestId?: string;
  speechToken?: string;
  text: string;
  policyVersion: number;
  stream?: true;
  format?: 'pcm';
}
interface AssistantSpeakReplyBase {
  text: string;
  policyVersion: number;
  demo?: boolean;
  local?: boolean;
}
export type AssistantSpeakReply = AssistantSpeakReplyBase &
  (
    | { streamUrl: string; mimeType: 'audio/mpeg'; audioBase64?: never }
    | {
        streamUrl: string;
        mimeType: 'audio/pcm';
        audioBase64?: never;
        sampleRate: 24000;
        channels: 1;
        sampleFormat: 's16le';
        playbackRate: 1;
      }
    | {
        streamUrl?: never;
        audioBase64: string;
        mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg' | 'audio/mp4';
      }
    | { streamUrl?: never; audioBase64: null; mimeType: null }
  );
export interface AssistantSpeechCapabilities {
  stt?: { contextHints?: boolean; availabilityTurn?: boolean };
  tts: { streaming?: boolean; directPcm?: boolean; turnTicket?: boolean };
}

/** Local playback descriptor, not a successful HTTP reply. The protected POST
 * confirms policyVersion in its response headers before any PCM is accepted. */
export interface AssistantDirectPcmPlayback {
  text: string;
  policyVersion: number;
  streamUrl?: never;
  audioBase64?: never;
  mimeType: 'audio/pcm';
  sampleRate: 24000;
  channels: 1;
  sampleFormat: 's16le';
  playbackRate: 1;
  streamRequest: Omit<AssistantSpeakCommand, 'stream'> & { format: 'pcm' };
  onRefused?: (status: number, code?: string) => void;
}
