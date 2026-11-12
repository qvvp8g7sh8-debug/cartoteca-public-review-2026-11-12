const { fail } = require('../../../../shared/errors.cjs');
const { keys, boundedText } = require('../interpretation/intent-schema.cjs');
const { normalizeRules, rulesFromPolicy } = require('./behavior-schema.cjs');
function initialBehavior() {
  return { version: 0, current: null, history: [] };
}
function metadata(value, nullable = false) {
  const allowedNull = nullable && value.time === null && value.actorId === null;
  if (
    !allowedNull &&
    (!Number.isSafeInteger(value.time) ||
      value.time < 0 ||
      typeof value.actorId !== 'string' ||
      !value.actorId ||
      value.actorId.length > 120)
  )
    throw Error('Invalid assistant behavior metadata.');
  const reason = boundedText(value.reason, 300, 'причина версии').trim();
  if (reason.length < 3) throw Error('Invalid assistant behavior reason.');
  return { time: value.time, actorId: value.actorId, reason };
}
function normalizeBehavior(value) {
  if (value === undefined) return initialBehavior();
  keys(value, ['version', 'current', 'history']);
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !Array.isArray(value.history) ||
    value.history.length > 10
  )
    throw Error('Invalid assistant behavior history.');
  if (value.current !== null) keys(value.current, ['time', 'actorId', 'reason']);
  const seen = new Set();
  const history = value.history.map((entry) => {
    keys(entry, ['version', 'time', 'actorId', 'reason', 'rules']);
    if (
      !Number.isSafeInteger(entry.version) ||
      entry.version < 0 ||
      entry.version >= value.version ||
      seen.has(entry.version)
    )
      throw Error('Invalid assistant behavior revision.');
    seen.add(entry.version);
    return {
      version: entry.version,
      ...metadata(entry, true),
      rules: normalizeRules(entry.rules, { allowMissingExamples: true }),
    };
  });
  return {
    version: value.version,
    current: value.current === null ? null : metadata(value.current),
    history,
  };
}
function currentMetadata(behavior) {
  return (
    behavior.current || {
      time: null,
      actorId: null,
      reason: behavior.version === 0 ? 'Начальные правила' : 'Восстановленные правила',
    }
  );
}
function recordBehaviorChange(state, before, actorId, reason, time) {
  const after = rulesFromPolicy(state.policy);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  const behavior = normalizeBehavior(state.behavior);
  const entry = { version: behavior.version, ...currentMetadata(behavior), rules: before };
  state.behavior = {
    version: behavior.version + 1,
    current: { time, actorId, reason },
    history: [...behavior.history, entry].slice(-10),
  };
  return true;
}
function rulesAtVersion(state, version) {
  if (!Number.isSafeInteger(version) || version < 0)
    throw fail(400, 'Укажите номер версии поведения.');
  if (version === state.behavior.version) return rulesFromPolicy(state.policy);
  const entry = state.behavior.history.find((item) => item.version === version);
  if (!entry) throw fail(404, 'Версия поведения больше не хранится.');
  return normalizeRules(entry.rules);
}
function versionSummaries(state) {
  return [
    { version: state.behavior.version, ...currentMetadata(state.behavior), current: true },
    ...state.behavior.history
      .slice()
      .reverse()
      .map(({ version, time, actorId, reason }) => ({
        version,
        time,
        actorId,
        reason,
        current: false,
      })),
  ];
}
module.exports = {
  initialBehavior,
  normalizeBehavior,
  recordBehaviorChange,
  rulesAtVersion,
  versionSummaries,
};
