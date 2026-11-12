const { fail } = require('../../../shared/errors.cjs');

const CHANNELS = Object.freeze(['telegram', 'max']);
const PREFERENCES = Object.freeze(['auto', ...CHANNELS, 'manual']);

function deliveryPreference(value) {
  if (!PREFERENCES.includes(value)) throw fail(400, 'Выберите Telegram, MAX или ручную связь.');
  return value;
}

// Preparation only: the caller must authorize and reread the appointment and links.
// This function neither persists a choice nor sends, retries or switches providers.
function selectDelivery({ preference = 'auto', override = 'auto', providers = {} } = {}) {
  deliveryPreference(preference);
  deliveryPreference(override);
  if (!providers || typeof providers !== 'object' || Array.isArray(providers))
    throw fail(400, 'Некорректное состояние каналов связи.');
  const requested = override === 'auto' ? preference : override;
  const options = CHANNELS.filter((channel) => {
    const provider = providers[channel];
    return (
      provider?.configured === true &&
      provider.connected === true &&
      provider.enabled === true &&
      provider.linked === true
    );
  });
  const result = (mode, channel, reason) =>
    Object.freeze({ mode, channel, reason, options: Object.freeze([...options]) });
  if (requested === 'manual') return result('manual', null, 'manual_selected');
  if (requested !== 'auto')
    return options.includes(requested)
      ? result('automatic', requested, 'explicit_selection')
      : result('blocked', requested, 'selected_channel_unavailable');
  if (options.length === 1) return result('automatic', options[0], 'only_available_channel');
  if (options.length > 1) return result('choice_required', null, 'choose_preferred_channel');
  return result('blocked', null, 'no_available_channel');
}

module.exports = { CHANNELS, deliveryPreference, selectDelivery };
