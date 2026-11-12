const { fail } = require('../../../../shared/errors.cjs');
const { minutes, validDate } = require('../../../../shared/work-schedule.cjs');
const MAX_REPRESENTATIVE_SLOTS = 3;
const MAX_SHOWN_SLOTS = 12;

function representativeOptions({ limit, shownSlots = [], preferredTime } = {}) {
  if (
    (preferredTime !== undefined && !Number.isFinite(minutes(preferredTime))) ||
    !Array.isArray(shownSlots) ||
    shownSlots.length > MAX_SHOWN_SLOTS ||
    shownSlots.some(
      (slot) =>
        !slot ||
        !validDate(slot.date) ||
        !Number.isFinite(minutes(slot.time)) ||
        typeof slot.staffId !== 'string' ||
        !slot.staffId ||
        slot.staffId.length > 160,
    )
  )
    throw fail(400, 'Обновите варианты времени для выбранной даты.');
  return {
    limit:
      Number.isSafeInteger(limit) && limit > 0
        ? Math.min(MAX_REPRESENTATIVE_SLOTS, limit)
        : MAX_REPRESENTATIVE_SLOTS,
    shownSlots: shownSlots.map(({ date, time, staffId }) => ({ date, time, staffId })),
    ...(preferredTime === undefined ? {} : { preferredTime }),
  };
}
function representativeSlots(slots, values = {}) {
  const { duration } = values;
  if (
    !Array.isArray(slots) ||
    !Number.isSafeInteger(duration) ||
    duration < 5 ||
    duration > 1440 ||
    duration % 5 ||
    slots.some(
      (slot) =>
        !slot ||
        !validDate(slot.date) ||
        slot.date !== slots[0].date ||
        !Number.isFinite(minutes(slot.time)) ||
        slot.duration !== duration ||
        typeof slot.staffId !== 'string' ||
        !slot.staffId,
    )
  )
    throw fail(400, 'Выберите одну дату и длительность с шагом 5 минут.');
  const options = representativeOptions(values);
  if (!slots.length) return { slots: [], truncated: false };
  const date = slots[0].date,
    staffIds = new Set(slots.map((slot) => slot.staffId)),
    history = new Map();
  for (const slot of options.shownSlots)
    if (slot.date === date && staffIds.has(slot.staffId))
      history.set(JSON.stringify([slot.staffId, slot.time]), slot);
  const shown = [...history.values()],
    distance = Math.max(60, duration),
    limit = Math.min(options.limit, MAX_SHOWN_SLOTS - shown.length),
    closeToShown = (slot) =>
      shown.some(
        (previous) =>
          previous.staffId === slot.staffId &&
          Math.abs(minutes(previous.time) - minutes(slot.time)) < distance,
      );
  const candidates = slots
    .filter((slot) => !closeToShown(slot))
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time) || a.staffId.localeCompare(b.staffId));
  const selected = [];
  if (limit && candidates.length) {
    const anchor =
      options.preferredTime === undefined
        ? candidates[0]
        : candidates.reduce((best, slot) =>
            Math.abs(minutes(slot.time) - minutes(options.preferredTime)) <
            Math.abs(minutes(best.time) - minutes(options.preferredTime))
              ? slot
              : best,
          );
    selected.push(anchor);
  }
  // Keep the earliest and latest actual starts, then fill the largest uncovered gap.
  while (selected.length < limit) {
    let best = null,
      bestDistance = -1;
    for (const slot of candidates) {
      const gap = Math.min(
        ...selected.map((row) => Math.abs(minutes(row.time) - minutes(slot.time))),
      );
      if (gap >= distance && gap > bestDistance) {
        best = slot;
        bestDistance = gap;
      }
    }
    if (!best) break;
    selected.push(best);
  }
  const truncated =
    shown.length + selected.length < MAX_SHOWN_SLOTS &&
    candidates.some((slot) =>
      selected.every((row) => Math.abs(minutes(row.time) - minutes(slot.time)) >= distance),
    );
  return {
    slots: selected.sort(
      (a, b) => a.time.localeCompare(b.time) || a.staffId.localeCompare(b.staffId),
    ),
    truncated,
  };
}
module.exports = {
  MAX_REPRESENTATIVE_SLOTS,
  MAX_SHOWN_SLOTS,
  representativeOptions,
  representativeSlots,
};
