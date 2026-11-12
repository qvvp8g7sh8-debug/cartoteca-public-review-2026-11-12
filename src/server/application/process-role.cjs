const ROLES = new Set(['combined', 'web', 'background', 'preflight']);
const AUTOSTARTS = [
  'telegramAutostart',
  'maxAutostart',
  'pushAutostart',
  'supportAutostart',
  'adminEmailAutostart',
  'bookingPublicationAutostart',
];

function processRole(value = 'combined') {
  if (!ROLES.has(value)) throw Error('Invalid application process role.');
  return value;
}

function runtimeOptions(options) {
  const role = processRole(options.processRole);
  if (role === 'combined' || role === 'background') return { ...options, processRole: role };
  const disabled = Object.fromEntries(AUTOSTARTS.map((name) => [name, false]));
  if (role === 'web')
    return {
      ...options,
      ...disabled,
      processRole: role,
      telegramIdentityAutostart:
        options.telegramIdentityAutostart ?? options.telegramAutostart !== false,
    };
  // Preflight checks local prepared data only. Even explicit adapters cannot start delivery.
  return {
    ...options,
    ...disabled,
    processRole: role,
    paymentNetworkEnabled: false,
    maxEnabled: false,
    pushEnabled: false,
    maxConnectionsEnabled: false,
    commonNotificationsEnabled: false,
    telegramIdentityAutostart: false,
    maxBot: null,
    maxBotIdentity: null,
    maxWebhookSecret: '',
    sendMail: null,
    telegramBot: null,
    supportBot: null,
    supportDelivery: { telegram: null, email: null },
  };
}

module.exports = { processRole, runtimeOptions };
