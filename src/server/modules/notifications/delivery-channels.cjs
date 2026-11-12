// All explicitly connected, ready providers receive the same appointment reminder.
// No preference, implicit fallback or future WhatsApp implementation is inferred.
function deliveryChannels(providers = {}) {
  return Object.freeze(
    ['telegram', 'max'].filter((channel) => {
      const provider = providers[channel];
      return (
        provider?.configured === true &&
        provider.connected === true &&
        provider.enabled === true &&
        provider.linked === true
      );
    }),
  );
}
module.exports = { deliveryChannels };
