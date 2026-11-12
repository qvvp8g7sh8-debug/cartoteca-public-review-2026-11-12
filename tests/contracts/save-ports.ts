import type {Appointment, Visit, Patient, SavePorts} from '../../src/client/contracts/domain';
import type {AppointmentSavePorts, ServiceSavePorts} from '../../src/client/contracts/ports';
declare const appointment: Appointment;
declare const visit: Visit;
declare const patient: Patient;
declare const ports: SavePorts;
declare const appointmentPorts: AppointmentSavePorts;
declare const servicePorts: ServiceSavePorts;

appointment.status = 'completed';
visit.duration = 45;
patient.videoConsent = 'granted';
appointmentPorts.ensurePatient(patient.id);
servicePorts.validateServiceValues({name: 'Synthetic', price: '1234.56', duration: '30'});

// @ts-expect-error factual duration is numeric, never the unparsed form string
visit.duration = '45';
// @ts-expect-error closed statuses use the shared explicit vocabulary
appointment.status = 'finished';
// @ts-expect-error link options must be an object, not a positional boolean
ports.prepareTelegramInvitation(patient.id, true);
// @ts-expect-error an appointment command cannot send arbitrary HTTP requests
appointmentPorts.request('/api/unrelated');
// @ts-expect-error the service port cannot read another patient's clinical card
servicePorts.ensurePatient(patient.id);
// @ts-expect-error patient data does not contain an authorization password
patient.password = 'not-a-real-password';
