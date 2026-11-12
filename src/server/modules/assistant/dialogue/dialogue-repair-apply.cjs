const { acceptText } = require('./dialogue-input.cjs');
const { fields, clearField } = require('./dialogue-options.cjs');
const { requestSlots } = require('./dialogue-slots.cjs');
const { MAX_SHOWN_SLOTS } = require('../actions/representative-slots.cjs');
const { windowBounds } = require('../language/time/booking-time-window.cjs');
const { applyTimeWindow } = require('./dialogue-booking-time.cjs');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function help(message) {
  return { message };
}
function shiftedEdits(data, input) {
  if (input.kind === 'shiftTime') {
    if (!DATE.test(data.date || '') || !TIME.test(data.time || ''))
      return help('Сначала укажите исходные дату и время, затем попросите сдвинуть время.');
    if (!Number.isSafeInteger(input.minutes) || !input.minutes || Math.abs(input.minutes) > 1440)
      return help('Назовите точное время или однозначный сдвиг в минутах.');
    const [hour, minute] = data.time.split(':').map(Number);
    const total = hour * 60 + minute + input.minutes;
    if (total < 0 || total >= 1440)
      return help('Такой сдвиг меняет день. Укажите новую дату и точное время отдельно.');
    return {
      edits: [
        {
          field: 'time',
          text:
            String(Math.floor(total / 60)).padStart(2, '0') +
            ':' +
            String(total % 60).padStart(2, '0'),
        },
      ],
    };
  }
  if (!DATE.test(data.date || ''))
    return help('Сначала укажите исходную дату, затем попросите перенести её на несколько дней.');
  if (!Number.isSafeInteger(input.days) || !input.days || Math.abs(input.days) > 366)
    return help('Укажите точную дату или однозначный сдвиг не больше 366 дней.');
  const stamp = Date.parse(data.date + 'T12:00:00Z') + input.days * 86400000;
  const date = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : '';
  if (!DATE.test(date)) return help('Для этой даты укажите новое значение полностью.');
  return { edits: [{ field: 'date', text: date }] };
}
function repairFocus(data) {
  const field = data.repairField;
  if (!fields.includes(field)) return null;
  const filled = {
    client: Boolean(data.patient),
    staff: Boolean(data.staff),
    service: data.serviceChosen === true,
    date: Boolean(data.date),
    time: Boolean(data.time),
    duration: Boolean(data.duration) && data.durationSource !== 'required',
  };
  if (filled[field]) {
    delete data.repairField;
    return null;
  }
  return field === 'service' && !data.staff ? 'staff' : field;
}
function rejectTime(entry) {
  const data = structuredClone(entry.data);
  if (!data.staff || !data.date || !data.serviceChosen || !data.duration)
    return help('Сначала уточним специалиста, услугу, дату и длительность.');
  const anchor = data.time || data.preferredTime || '';
  const candidates = [...(data.currentSlots || [])];
  if (TIME.test(data.time || ''))
    candidates.push({ date: data.date, time: data.time, staffId: data.staff.id });
  const history = [...(data.shownSlots || []), ...candidates].filter(
    (slot) =>
      slot.date === data.date && slot.staffId === data.staff.id && TIME.test(slot.time || ''),
  );
  data.timeRequired = false;
  requestSlots(data, anchor);
  // Bind the rejection history to precisely the criteria used by bookingSlotView.
  data.slotCriteria = JSON.stringify([
    data.date,
    data.staff.id,
    data.service?.id || '',
    data.duration,
    data.timeWindow,
  ]);
  data.shownSlots = [...new Map(history.map((slot) => [slot.time, slot])).values()].slice(
    -MAX_SHOWN_SLOTS,
  );
  delete data.currentSlots;
  data.repairField = 'time';
  entry.data = data;
  return {};
}
function applyRepair(entry, input, clock) {
  if (input.kind === 'rejectTime') return rejectTime(entry);
  const patch = input.kind === 'patch' ? input : shiftedEdits(entry.data, input);
  if (patch.message) return patch;
  if (
    !Array.isArray(patch.edits) ||
    !patch.edits.length ||
    patch.edits.length > fields.length ||
    patch.edits.some((edit) => !fields.includes(edit.field) || typeof edit.text !== 'string') ||
    new Set(patch.edits.map((edit) => edit.field)).size !== patch.edits.length
  )
    return help('Назовите каждое изменяемое поле один раз и укажите новое значение.');
  const data = structuredClone(entry.data);
  // Apply dependencies first: selecting another specialist invalidates the old catalog service.
  if (
    Object.hasOwn(patch, 'timeWindow') &&
    (!windowBounds(patch.timeWindow) || patch.edits.some((edit) => edit.field === 'time'))
  )
    return help('Уточните один период поиска без отдельного точного времени.');
  const edits = [...patch.edits].sort(
    (left, right) => fields.indexOf(left.field) - fields.indexOf(right.field),
  );
  try {
    for (const { field, text } of edits) {
      if (field !== 'service' || !data.servicePicker?.categoryId || data.serviceChosen)
        clearField(data, field);
      acceptText(data, field, text, clock);
    }
  } catch (error) {
    if (error.status !== 400) throw error;
    return help('Исправления пока не применены. ' + error.message);
  }
  const retainedAfter =
    entry.data.seekSlots && !edits.some((edit) => edit.field === 'time')
      ? entry.data.slotAfterTime
      : '';
  if (patch.timeWindow) applyTimeWindow(data, patch.timeWindow);
  else if (TIME.test(retainedAfter || '')) requestSlots(data, retainedAfter);
  else if (input.seekSlots === true) requestSlots(data);
  const changed = edits.map((edit) => edit.field);
  const pending = changed.find(
    (field) =>
      ['client', 'staff', 'service'].includes(field) &&
      !(field === 'client' ? data.patient : field === 'staff' ? data.staff : data.serviceChosen),
  );
  if (pending) data.repairField = pending;
  if (
    changed.includes('staff') &&
    !changed.includes('service') &&
    data.serviceQuery &&
    !data.serviceChosen
  )
    data.repairField = 'service';
  entry.data = data;
  return {};
}
module.exports = { applyRepair, repairFocus };
