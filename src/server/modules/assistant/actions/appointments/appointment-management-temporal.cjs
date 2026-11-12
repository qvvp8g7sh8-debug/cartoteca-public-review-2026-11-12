const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
const {
  maskManagementEntities,
  temporalWordsOnly,
} = require('./appointment-management-entities.cjs');
const { relativeOperation } = require('../../dialogue/dialogue-repair-parse.cjs');
const { applyRepair } = require('../../dialogue/dialogue-repair-apply.cjs');
const { wholeDateAnswer } = require('../../language/time/whole-date-answer.cjs');
const { windowBounds } = require('../../language/time/booking-time-window.cjs');
const {
  validProposal,
  inheritMonthContext,
  dayEvidence,
} = require('../../dialogue/bare-day-proposal.cjs');
const fold = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
const clean = (value) => value.replace(/^[\s,;.!?…]+|[\s,;.!?…]+$/gu, '').trim();
const keepClock =
  /^(?:в то же время|на то же время|оставь(?:те)?(?: прежнее)? время|время (?:оставь(?:те)?|не меняй(?:те)?))$/u;
function managementRelativeProof(intent, raw, clock) {
  let text = maskManagementEntities(intent, raw);
  text = clean(
    fold(text)
      .replace(
        /^(?:(?:пожалуйста|можешь|можете|можно|мне нужно|мне надо|нужно|надо|я хочу|хочу|клиента|клиентки|пациента|пациентки|для)[,\s]*)+/u,
        '',
      )
      .replace(/[,\s]+пожалуйста$/u, ''),
  );
  if (!text || text.length > 160) return {};
  // The shared relative grammar consumes a complete clause. The only other
  // accepted clause is a whole date; an entity or condition cannot disappear.
  const words = text.split(/\s+/u),
    matches = new Map();
  for (let split = 0; split <= words.length; split++) {
    const left = clean(words.slice(0, split).join(' '));
    const right = clean(words.slice(split).join(' '));
    for (const [candidate, remainder] of [
      [left, right],
      [right, left],
    ]) {
      if (!candidate) continue;
      const operation = relativeOperation(candidate);
      const keepTime = keepClock.test(candidate);
      if (!keepTime && !['shiftTime', 'shiftDate'].includes(operation?.kind)) continue;
      const date = remainder ? wholeDateAnswer(remainder, clock) : null;
      const bare =
        remainder && dayEvidence(remainder)?.whole
          ? bookingTemporalConstraints({ intent: 'prepareAppointment' }, remainder, clock)
          : null;
      if (remainder && !date && !validProposal(bare?.dateProposal)) continue;
      const proof = {
        ...(date ? { date } : bare || {}),
        ...(keepTime ? { keepTime: true } : { relativeTarget: operation }),
      };
      matches.set(JSON.stringify(proof), proof);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : {};
}
function initializeManagementTarget(m, source, clock) {
  const hasTarget = Boolean(m.initialDate || m.initialTime || m.relativeTarget || m.keepTime);
  m.targetDate = m.dateRequired
    ? null
    : m.initialDate || (hasTarget && !m.keepTime ? source.date : null);
  m.targetTime = m.initialTime || (m.keepTime ? source.time : null);
  if (windowBounds(m.initialWindow)) {
    m.targetWindow = structuredClone(m.initialWindow);
    m.targetWindowDate = m.targetDate;
    m.rangeSummary = !m.nearestRequested;
  }
  m.hasTarget = hasTarget;
  if (!m.relativeTarget) return;
  const operation = m.relativeTarget;
  const preview = {
    data: {
      date: m.targetDate || source.date,
      time: source.time,
      duration: source.duration,
      roomId: '',
    },
  };
  const result = applyRepair(preview, operation, clock);
  if (result.message) {
    m.relativeHelp = result.message;
    m.targetTime = null;
    return;
  }
  if (!m.dateRequired || operation.kind === 'shiftDate') {
    m.targetDate = preview.data.date;
    m.dateRequired = false;
  }
  if (operation.kind === 'shiftTime') {
    m.targetTime = preview.data.time;
    m.timeRequired = false;
  }
}
function wholeManagementTemporalProof(raw, clock, contextDate = null) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const text = clean(fold(raw));
  // The parser may extract temporal evidence from a larger command. A local
  // target transition must prove that it did not discard a client, service,
  // condition, alternative or second action while extracting that evidence.
  if (!text || !temporalWordsOnly(text) || /\d\p{L}/u.test(text)) return null;
  const relative = managementRelativeProof({}, text, clock);
  if (relative.relativeTarget || relative.keepTime) return relative;
  const context = /^\d{4}-\d{2}$/u.test(contextDate || '') ? contextDate + '-01' : contextDate;
  const proof = inheritMonthContext(
    bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, clock),
    context,
  );
  if (windowBounds(proof.timeWindow) && !proof.time) proof.seekSlots = true;
  return ['date', 'time', 'dateProposal', 'timeWindow', 'timeWindowRequired'].some((field) =>
    Object.hasOwn(proof, field),
  )
    ? proof
    : null;
}
function combinedManagementTemporal(entry, raw, clock) {
  const m = entry.data.management;
  // Plain numerical replies may be a displayed choice or a contextual day.
  // Their existing step-aware parsers decide that meaning.
  if (/^\d{1,2}[.!?…]?$/u.test(raw.trim())) return null;
  const proof = wholeManagementTemporalProof(raw, clock, m.targetDate || m.dateMonthContext);
  if (!proof || proof.relativeTarget || proof.keepTime) return null;
  // The dedicated date parser also understands compact ASR date boundaries and
  // contextual day replies. Keep single-date/valid-clock answers on those paths;
  // the combined transition owns partial or complete date+clock compositions.
  if (!Object.hasOwn(proof, 'time')) return null;
  if (!Object.hasOwn(proof, 'date') && proof.time !== null && !proof.timeWindowRequired)
    return null;
  return { kind: 'targetConstraints', constraints: proof };
}
module.exports = {
  managementRelativeProof,
  initializeManagementTarget,
  combinedManagementTemporal,
  wholeManagementTemporalProof,
  keepClock,
};
