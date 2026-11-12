const { intentNames, commandFields } = require('./intent-contract.cjs');
const { commandCategory } = require('./intent-schema.cjs');
const roles = Object.freeze(['owner', 'salon_admin', 'cosmetologist']);
const definitions = {
  help: ['Помощь', 'none', [['actions/help-response.cjs', 'helpText']]],
  calendar: [
    'Просмотр расписания',
    'read_only',
    [
      ['actions/actions.cjs', 'handoff'],
      ['actions/calendar-read-request.cjs', 'calendarReadIntent'],
    ],
  ],
  clients: [
    'Поиск клиентов',
    'read_only',
    [
      ['actions/actions.cjs', 'handoff'],
      ['language/names/name-directory.cjs', 'resolveClient'],
    ],
  ],
  clientCard: [
    'Открытие карточки',
    'read_only',
    [['actions/client-card-flow.cjs', 'createClientCardFlow']],
  ],
  availability: [
    'Свободное время',
    'read_only',
    [
      ['actions/availability-action.cjs', 'availabilityAction'],
      ['actions/availability.cjs', 'findAvailability'],
    ],
  ],
  prepareAppointment: [
    'Новая запись',
    'conditional_server_execution',
    [
      ['dialogue/dialogue-flow.cjs', 'createAssistantDialogue'],
      ['actions/appointments/appointment-execution.cjs', 'createAppointmentExecution'],
    ],
  ],
  moveAppointment: [
    'Перенос записи',
    'conditional_server_execution',
    [
      ['actions/appointments/appointment-management-flow.cjs', 'createAppointmentManagementFlow'],
      ['actions/appointments/appointment-execution-kind.cjs', 'executionKind'],
    ],
  ],
  cancelAppointment: [
    'Отмена записи',
    'conditional_server_execution',
    [
      ['actions/appointments/appointment-management-flow.cjs', 'createAppointmentManagementFlow'],
      ['actions/appointments/appointment-cancellation-snapshot.cjs', 'confirmCancellation'],
    ],
  ],
  editAppointment: [
    'Открытие редактирования записи',
    'manual_form',
    [['actions/appointments/appointment-management-flow.cjs', 'createAppointmentManagementFlow']],
  ],
};
const unsupportedBranches = Object.freeze([
  'create_client',
  'edit_client',
  'delete_client',
  'bulk_write',
  'recurring_appointments',
]);
function capabilityRegistry() {
  return intentNames.map((id) => {
    const [title, execution, bindings] = definitions[id];
    const write = execution === 'conditional_server_execution';
    return {
      id,
      title,
      functionState: 'implemented',
      policyCategory: commandCategory(id),
      roles: [...roles],
      modelFields: [...commandFields[id]],
      execution,
      authorization: 'server_policy_and_current_scope',
      gates: {
        memberGrant: true,
        commandPolicy: id !== 'help',
        executorOwnership: write,
        savingEnabled: write,
        cancellationConsent: id === 'cancelAppointment',
        outsideHoursConsentRoles: ['prepareAppointment', 'moveAppointment'].includes(id)
          ? ['owner', 'salon_admin']
          : [],
      },
      bindings: bindings.map(([module, exported]) => ({ module, exported })),
    };
  });
}
function capabilityDefinition(id) {
  return capabilityRegistry().find((item) => item.id === id) || null;
}
// This describes existing code. It never grants access or substitutes for policy/ACL/executor checks.
module.exports = { capabilityRegistry, capabilityDefinition, unsupportedBranches, roles };
