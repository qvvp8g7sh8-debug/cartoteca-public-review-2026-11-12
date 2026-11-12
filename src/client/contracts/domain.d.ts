export type FormValues = Record<string, string>;
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export type View = 'card' | 'clients' | 'calendar' | 'services' | 'settings';
export interface PatientNames {
  name: string;
  firstName: string;
  lastName: string;
  middleName: string;
  designation: string;
}
export interface Photo {
  data: string;
  caption?: string;
}
export interface Service {
  id: string;
  staffId?: string;
  name: string;
  category?: string;
  product?: string;
  description?: string;
  duration: string;
  price: number;
}
export interface ServiceSnapshot {
  id: string;
  name: string;
  category: string;
  categoryTitle: string;
  product?: string;
  description?: string;
  duration: number;
  price: number;
}
export interface Appointment {
  id: string;
  date: string;
  time: string;
  duration: number;
  service: string;
  serviceItems?: ServiceSnapshot[];
  staffId?: string;
  roomId?: string;
  notes?: string;
  status?: AppointmentStatus;
  completedVisitId?: string;
  /** Server-owned projection from a committed online booking request. */
  bookingSource?: 'online';
  notificationConfirmedAt?: number | null;
  notificationConfirmedChannel?: 'telegram' | 'max' | '';
  deliveryReady?: boolean;
  deliveryPreference?: 'auto' | 'telegram' | 'max' | 'manual';
  deliveryRevision?: number;
  deliveryChannel?: 'telegram' | 'max' | '';
  deliveryChannels?: ('telegram' | 'max')[];
  deliveryStatuses?: { channel: 'telegram' | 'max'; status: string }[];
  deliveryStatus?: string | null;
}
// Read-only calendar projection; contact data is not stored on an appointment.
export interface CalendarAppointment extends Appointment {
  patientId: string;
  patientName: string;
  patientPhone?: string;
}
export interface PersonalEvent {
  id: string;
  date: string;
  time: string;
  duration: number;
  staffId: string;
  notes: string;
  busy?: boolean;
}
export interface CalendarPersonalEvent extends PersonalEvent {
  personal: true;
  kind: 'personal';
  personalContinuation?: boolean;
}
export interface Visit {
  id: string;
  date: string;
  procedure: string;
  time?: string;
  duration?: number;
  type?: string;
  product?: string;
  amount?: string;
  zones?: string;
  notes?: string;
  reaction?: string;
  recommendations?: string;
  photos: Photo[];
  staffId?: string;
  appointmentId?: string;
  serviceItems?: ServiceSnapshot[];
}
export interface Patient {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  designation?: string;
  phone?: string;
  birth?: string;
  allergies?: string;
  notes?: string;
  createdBy?: string;
  videoConsent?: 'granted' | 'refused' | 'unknown';
  clientMark?: 'none' | 'star' | 'attention' | 'flag';
  clientMarkNote?: string;
  visits: Visit[];
  appointments: Appointment[];
}
/** A read-only page. Its patient deliberately lacks complete visit/appointment arrays. */
export interface PatientCardView {
  patient: Omit<Patient, 'visits' | 'appointments'>;
  revision: number;
  history: {
    entries: ({ kind: 'visit'; record: Visit } | { kind: 'appointment'; record: Appointment })[];
    total: number;
    photoCount: number;
    nextCursor: string | null;
  };
  upcoming: { entries: Appointment[]; total: number; nextCursor: string | null };
}
export interface VisitValues extends FormValues {
  date: string;
  procedure: string;
  duration: string;
  staffId: string;
  time: string;
  notes: string;
}
export interface AppointmentEdit {
  patientId: string;
  before: Appointment;
  revision: number;
  account: string;
}
export interface EditorMode {
  pointEdit?: AppointmentEdit;
  staffId?: string;
  kind:
    | 'patient'
    | 'patientMark'
    | 'patientMarkView'
    | 'service'
    | 'appointment'
    | 'personalEvent'
    | 'visit'
    | 'appointmentOutcome'
    | 'appointmentActions'
    | 'workSchedule';
  id?: string | null;
  patientId?: string;
  appointmentId?: string | null;
  source?: 'calendar' | 'card' | 'services';
  appendOnly?: boolean;
  appointmentLegacyService?: string;
  appointmentLegacyDuration?: number;
  serviceItems?: ServiceSnapshot[];
}
// Save commands require an active editor. The lifecycle controller enforces that precondition.
export interface SaveState {
  account?: { id?: string; organizationId?: string; role?: string };
  editorMode: EditorMode;
  data: Patient[];
  services: Service[];
  SERVICE_CATEGORIES: { id: string; title: string }[];
  currentView: View;
  workspace: {
    enabled: boolean;
    staffRules?: { staffId: string; preventOverlap: boolean }[];
    rooms?: { active: boolean; preventOverlap?: boolean }[];
  };
  selectedId: string;
  appointmentFromServices: boolean;
  calendarAnchorDate: Date;
  uploadItems: Photo[];
  activeTab: 'visits' | 'profile' | 'photos';
}

export interface SavePorts {
  $(selector: string): HTMLElement;
  validateServiceValues(values: FormValues): string;
  validateAppointmentValues(values: FormValues): string;
  validatePatientValues(values: FormValues): string;
  validateVisitDuration(values: FormValues): string;
  configureServiceView(values: { category: string }): void;
  formatPrice(value: number): string;
  saveServices(): Promise<void>;
  closeEditor(): void;
  restoreAppointmentEditor(createdId?: string): boolean;
  setView(view: View): void | Promise<void>;
  toast(message: string): void;
  ensurePatient(id: string, options?: { force?: boolean }): Promise<Patient>;
  assertAppointmentEdit(edit: AppointmentEdit): void;
  patientFormValues(values: FormValues, options?: { appointment?: boolean }): PatientNames;
  accountId(): string;
  isActiveAppointment(appointment: Appointment): boolean;
  isClosedAppointment(appointment: Appointment): boolean;
  selectedServiceItems(name: string, id?: string): ServiceSnapshot[];
  save(options?: { scheduleAcknowledgement?: string }): Promise<void>;
  saveAppointmentChange(
    edit: AppointmentEdit,
    after: Appointment,
    options?: { scheduleAcknowledgement?: string },
  ): Promise<void>;
  confirmAppointmentWorkSchedule(appointment: Appointment): Promise<string | false>;
  assertAppointmentAvailability(appointment: Appointment): Promise<void>;
  clearServiceSelection(): void;
  parseDate(value: string): Date;
  prepareTelegramInvitation(id: string, options?: { quiet?: boolean }): Promise<unknown>;
  renderList(options?: { immediate?: boolean }): void;
  renderDetail(): void;
}
