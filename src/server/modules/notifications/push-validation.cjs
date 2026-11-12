const { fail } = require('../../../shared/errors.cjs');
const CHANGE_EVENTS = [
  'created',
  'moved',
  'cancelled',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
];
const EVENTS = ['new-request', 'confirmation', ...CHANGE_EVENTS, 'reminder'];
// The legacy umbrella remains valid input, but responses expose each actual category.
function expandedEvents(events) {
  const selected = new Set(events.flatMap((event) => (event === 'change' ? CHANGE_EVENTS : event)));
  return EVENTS.filter((event) => selected.has(event));
}
function eventCategory(event, reference = {}) {
  if (event !== 'change') return event;
  if (reference.removed) return 'removed';
  return CHANGE_EVENTS.includes(reference.notice) ? reference.notice : 'updated';
}
const defaults = () => ({ events: [...EVENTS], leadMinutes: 120, reminderMode: 'workday' });
// Old leadMinutes described individual appointments, not the new workday reminder.
const storedPreferences = (value) => ({
  events: expandedEvents(Array.isArray(value?.events) ? value.events : EVENTS),
  leadMinutes: value?.reminderMode === 'workday' ? value.leadMinutes : 120,
  reminderMode: 'workday',
});
function subscription(value) {
  try {
    const url = new URL(value?.endpoint);
    const host = url.hostname;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.href.length > 4096 ||
      !(
        host === 'fcm.googleapis.com' ||
        host === 'updates.push.services.mozilla.com' ||
        /^[a-z0-9-]+\.push\.apple\.com$/.test(host) ||
        /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)
      )
    )
      throw Error();
    const keys = {};
    for (const [key, length] of [
      ['p256dh', 65],
      ['auth', 16],
    ]) {
      const text = value.keys?.[key];
      if (
        typeof text !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(text) ||
        Buffer.from(text, 'base64url').length !== length ||
        Buffer.from(text, 'base64url').toString('base64url') !== text
      )
        throw Error();
      keys[key] = text;
    }
    require('node:crypto').ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1');
    return { endpoint: url.href, keys };
  } catch {
    throw fail(400, 'Браузер вернул неподдерживаемое подключение уведомлений.');
  }
}
function preferences(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['events', 'leadMinutes', 'reminderMode'].includes(k)) ||
    (value.reminderMode !== undefined && value.reminderMode !== 'workday') ||
    !Array.isArray(value.events) ||
    new Set(value.events).size !== value.events.length ||
    value.events.some((x) => x !== 'change' && !EVENTS.includes(x)) ||
    ![15, 30, 45, 60, 120].includes(value.leadMinutes)
  )
    throw fail(400, 'Выберите события и время напоминания.');
  return {
    events: expandedEvents(value.events),
    leadMinutes: value.leadMinutes,
    reminderMode: 'workday',
  };
}
module.exports = {
  subscription,
  preferences,
  storedPreferences,
  defaults,
  eventCategory,
  EVENTS,
  CHANGE_EVENTS,
};
