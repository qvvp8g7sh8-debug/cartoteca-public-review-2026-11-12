const {
  clearSourceDate,
  clearSourceTime,
  setSourceDay,
} = require('./appointment-management-repair.cjs');
function applySourceConstraints(m, proof = {}) {
  if (proof.date !== undefined) {
    clearSourceDate(m);
    if (m.operation !== 'move') m.dateRequired = proof.date === null;
    if (proof.date) {
      m.sourceDate = proof.date;
      delete m.sourceDateRequired;
    }
  }
  if (proof.dateProposal) {
    setSourceDay(m, proof.dateProposal.day);
    delete m.sourceDateRequired;
    if (m.operation !== 'move') m.dateRequired = false;
  }
  if (proof.time !== undefined) {
    clearSourceTime(m);
    if (m.operation !== 'move') m.timeRequired = proof.time === null;
    if (proof.time) {
      m.sourceTime = proof.time;
      delete m.sourceTimeRequired;
    }
  }
  if (proof.timeWindow && !proof.timeWindowRequired) {
    m.sourceWindow = structuredClone(proof.timeWindow);
    delete m.sourceTime;
    delete m.sourceTimeRequired;
    if (m.operation !== 'move') m.timeRequired = false;
  } else if (proof.time !== undefined || proof.timeWindowRequired) delete m.sourceWindow;
}
module.exports = { applySourceConstraints };
