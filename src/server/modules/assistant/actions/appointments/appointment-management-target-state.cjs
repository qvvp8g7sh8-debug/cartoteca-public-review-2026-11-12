const { clearTargetWindow, resetSource } = require('./appointment-management-repair.cjs');
const { windowBounds } = require('../../language/time/booking-time-window.cjs');
function resetTargetSearch(m) {
  delete m.closedConfirmation;
  delete m.movePreparation;
  delete m.pendingShift;
  delete m.relativeHelp;
  delete m.rangeReason;
  delete m.dateRejection;
  m.rangeOffset = 0;
}
function applyTargetPatch(m, input) {
  const pendingWindow = !m.targetDate && (m.targetWindow || m.initialWindow);
  resetTargetSearch(m);
  for (const edit of input.edits || []) {
    if (edit.field === 'date') {
      clearTargetWindow(m);
      delete m.initialWindow;
      delete m.dateProposal;
      m.initialDate = m.targetDate = edit.text;
      m.dateRequired = false;
      m.dateMonthContext = edit.text.slice(0, 7);
      if (pendingWindow && windowBounds(pendingWindow)) {
        m.initialWindow = structuredClone(pendingWindow);
        m.targetWindow = structuredClone(pendingWindow);
        m.targetWindowDate = edit.text;
      }
    } else if (edit.field === 'time') {
      clearTargetWindow(m);
      delete m.initialWindow;
      m.initialTime = m.targetTime = m.requestedTime = edit.text;
      m.timeRequired = false;
      m.timeWindowRequired = false;
      delete m.relativeTarget;
      delete m.keepTime;
    }
  }
  if (input.proposal) {
    clearTargetWindow(m);
    m.dateProposal = structuredClone(input.proposal);
    m.initialDate = m.targetDate = null;
    m.dateRequired = true;
  }
  if (input.window && windowBounds(input.window)) {
    m.initialWindow = structuredClone(input.window);
    m.targetWindow = structuredClone(input.window);
    m.targetWindowDate = m.targetDate;
    m.timeWindowRequired = false;
  }
  if (input.seekSlots) {
    m.initialTime = m.targetTime = null;
    m.timeRequired = true;
    m.nearestRequested = input.nearest || null;
    m.rangeSummary = !input.nearest;
    delete m.relativeTarget;
    delete m.keepTime;
    delete m.requestedTime;
  } else m.rangeSummary = Boolean(m.targetWindow && !m.targetTime);
  m.hasTarget = true;
}
function editTargetDate(m) {
  resetTargetSearch(m);
  clearTargetWindow(m);
  delete m.initialWindow;
  delete m.dateProposal;
  m.initialDate = m.targetDate = null;
  m.dateRequired = true;
  m.rangeSummary = false;
}
function editTargetTime(m) {
  resetTargetSearch(m);
  clearTargetWindow(m);
  delete m.initialWindow;
  delete m.requestedTime;
  delete m.relativeTarget;
  delete m.keepTime;
  m.initialTime = m.targetTime = null;
  m.timeRequired = true;
  m.timeWindowRequired = false;
  m.nearestRequested = null;
  m.rangeSummary = false;
}
function prepareSourceReselection(m) {
  const dateRequired = m.dateRequired;
  const unresolvedRelative = !m.source && m.relativeTarget;
  const unresolvedKeepTime = !m.source && m.keepTime === true;
  m.initialDate = dateRequired
    ? null
    : Object.hasOwn(m, 'targetDate')
      ? m.targetDate
      : m.initialDate;
  m.initialTime = m.timeRequired
    ? null
    : Object.hasOwn(m, 'targetTime')
      ? m.targetTime || m.requestedTime || null
      : m.initialTime || null;
  if (m.targetWindow && m.targetWindowDate === m.targetDate)
    m.initialWindow = structuredClone(m.targetWindow);
  resetSource(m);
  resetTargetSearch(m);
  m.dateRequired = dateRequired;
  m.timeRequired = !m.initialTime;
  if (!unresolvedRelative) delete m.relativeTarget;
  if (!unresolvedKeepTime) delete m.keepTime;
}
// A repeated command carries proof of absence versus an explicit unresolved field.
// Never recover a rejected clock/date from the previous target or requestedTime.
function applyTargetConstraints(m, proof) {
  const edits = ['date', 'time']
    .filter((field) => typeof proof[field] === 'string')
    .map((field) => ({ field, text: proof[field] }));
  if (proof.date === null) editTargetDate(m);
  if (proof.time === null || proof.timeWindowRequired) editTargetTime(m);
  if (edits.length || proof.dateProposal || proof.timeWindow || proof.seekSlots)
    applyTargetPatch(m, {
      edits,
      proposal: proof.dateProposal,
      window: proof.timeWindow,
      seekSlots: proof.seekSlots,
      nearest: proof.nearestRequested,
    });
  if (proof.timeWindowRequired) m.timeWindowRequired = true;
  if (proof.relativeTarget || proof.keepTime) applyRelativeTarget(m, proof);
  if (proof.dateRejection === 'past' && m.dateRequired) m.dateRejection = 'past';
}
function applyRelativeTarget(m, input) {
  resetTargetSearch(m);
  m.relativeTarget = input.relativeTarget;
  m.keepTime = input.keepTime === true;
  if (m.keepTime || input.relativeTarget?.kind === 'shiftTime') {
    clearTargetWindow(m);
    delete m.initialWindow;
    m.timeWindowRequired = false;
    m.rangeSummary = false;
    m.nearestRequested = null;
  }
  if (input.date) {
    m.initialDate = m.targetDate = input.date;
    m.dateRequired = false;
    delete m.dateProposal;
    m.dateMonthContext = input.date.slice(0, 7);
  }
  if (input.dateProposal) {
    m.dateProposal = structuredClone(input.dateProposal);
    m.initialDate = m.targetDate = null;
    m.dateRequired = true;
  }
  m.initialTime = null;
  m.hasTarget = true;
}
module.exports = {
  applyTargetPatch,
  resetTargetSearch,
  editTargetDate,
  editTargetTime,
  prepareSourceReselection,
  applyTargetConstraints,
  applyRelativeTarget,
};
