// Explicit migration staging: serve static pages, block API and every background writer.
function gatedRelease(options) {
  if (!options.releaseGate) return options;
  return {
    ...options,
    paymentNetworkEnabled: false,
    maxEnabled: false,
    pushEnabled: false,
    pushAutostart: false,
    maxConnectionsEnabled: false,
    commonNotificationsEnabled: false,
    sendMail: null,
    telegramBot: null,
    supportBot: null,
    supportDelivery: { telegram: null, email: null },
    telegramAutostart: false,
    supportAutostart: false,
    maxAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
  };
}
module.exports = { gatedRelease };
