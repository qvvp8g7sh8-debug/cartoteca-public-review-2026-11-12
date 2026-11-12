const { fail } = require('../../../../shared/errors.cjs');
const { intentNames } = require('../interpretation/intent-contract.cjs');
const { unsupportedBranches, roles } = require('../interpretation/capability-registry.cjs');
const fieldNames = Object.freeze([
  'client',
  'service',
  'staff',
  'date',
  'time',
  'duration',
  'room',
]);
const phaseNames = Object.freeze([
  'initial',
  'clientChoice',
  'serviceChoice',
  'staffChoice',
  'appointmentChoice',
  'client',
  'service',
  'staff',
  'date',
  'time',
  'period',
  'slots',
  'closedDay',
  'cancelConfirmation',
  'ready',
  'execution',
  'unknown',
]);
const gapDefinitions = Object.freeze({
  function_absent: ['function', 'server', 'Функция не реализована в голосовом помощнике'],
  manual_interface_step: ['function', 'server', 'Следующий шаг доступен в штатном интерфейсе'],
  input_missing: ['data', 'data', 'Нужно уточнить данные команды'],
  directory_unavailable: ['data', 'data', 'Нет доступных данных клиентов'],
  catalog_unavailable: ['data', 'data', 'Нет доступного каталога услуг'],
  schedule_unavailable: ['data', 'data', 'Нет доступных данных графика'],
  context_lost: ['context', 'context', 'Потеряны ранее выбранные данные'],
  example_selection: ['examples', 'examples', 'Не подобраны подходящие примеры'],
  recognition_mismatch: ['recognition', 'recognition', 'Ошибка распознавания речи'],
  model_contract: ['model_contract', 'contract', 'Ответ модели нарушает контракт'],
  entity_unresolved: ['resolution', 'server', 'Не определён клиент, услуга или приём'],
  business_constraint: ['policy', 'none', 'Сработала проверка прав, графика или занятости'],
  provider_unavailable: ['provider', 'provider', 'Провайдер недоступен'],
  limit_exceeded: ['limits', 'limits', 'Достигнут лимит обращений'],
  audio_capture: ['audio', 'audio', 'Ошибка захвата звука'],
  audio_playback: ['audio', 'audio', 'Браузер не воспроизвёл ответ'],
  transport_interrupted: ['transport', 'transport', 'Запрос прерван'],
  example_contract_stale: ['examples', 'examples', 'Пример не соответствует текущему контракту'],
  execution_mode_unknown: ['unknown', 'none', 'Нужно уточнить режим выполнения'],
  diagnostic_invalid: ['unknown', 'none', 'Нужно проверить диагностические данные'],
  evidence_missing: ['unknown', 'none', 'Недостаточно данных для вывода'],
});
const invalid = () => {
  throw fail(400, 'Некорректные диагностические данные.');
};
function object(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid();
}
function one(value, allowed, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) invalid();
  return value;
}
function fields(values = []) {
  if (
    !Array.isArray(values) ||
    values.length > fieldNames.length ||
    values.some((value) => !fieldNames.includes(value)) ||
    new Set(values).size !== values.length
  )
    invalid();
  return [...values].sort();
}
function normalizeDiagnosticSignal(value) {
  object(value, [
    'capabilityId',
    'unsupportedBranch',
    'phase',
    'role',
    'fields',
    'counts',
    'data',
    'checks',
    'stamps',
  ]);
  const result = {
    capabilityId: one(value.capabilityId, [...intentNames, null], null),
    unsupportedBranch: one(value.unsupportedBranch, [...unsupportedBranches, null], null),
    phase: one(value.phase, phaseNames, 'unknown'),
    role: one(value.role, [...roles, 'unknown'], 'unknown'),
  };
  if (result.unsupportedBranch && ![null, 'help'].includes(result.capabilityId)) invalid();
  object(value.fields || {}, ['before', 'after', 'cleared', 'missing']);
  result.fields = {
    before: value.fields?.before == null ? null : fields(value.fields.before),
    after: value.fields?.after == null ? null : fields(value.fields.after),
    cleared: fields(value.fields?.cleared),
    missing: fields(value.fields?.missing),
  };
  result.counts = {};
  object(value.counts || {}, [
    'clientCandidates',
    'serviceCandidates',
    'staffCandidates',
    'appointmentCandidates',
    'selectedExamples',
  ]);
  for (const [key, count] of Object.entries(value.counts || {})) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) invalid();
    result.counts[key] = count;
  }
  object(value.data || {}, ['directory', 'catalog', 'schedule']);
  result.data = Object.fromEntries(
    ['directory', 'catalog', 'schedule'].map((key) => [
      key,
      one(value.data?.[key], ['unknown', 'available', 'empty', 'unavailable'], 'unknown'),
    ]),
  );
  const checkValues = {
    recognition: ['not_observed', 'not_used', 'matched', 'mismatch', 'empty'],
    modelContract: ['not_observed', 'not_used', 'valid', 'invalid'],
    exampleSelection: ['not_observed', 'not_used', 'relevant', 'irrelevant', 'empty'],
    constraint: ['not_observed', 'clear', 'busy', 'outside_hours', 'past', 'forbidden', 'disabled'],
    provider: ['not_observed', 'ready', 'unavailable'],
    limit: ['not_observed', 'within', 'exceeded'],
    audio: ['not_observed', 'ready', 'capture_failed', 'playback_blocked'],
    transport: ['not_observed', 'completed', 'interrupted'],
  };
  object(value.checks || {}, Object.keys(checkValues));
  result.checks = Object.fromEntries(
    Object.entries(checkValues).map(([key, allowed]) => [
      key,
      one(value.checks?.[key], allowed, 'not_observed'),
    ]),
  );
  object(value.stamps || {}, ['sourceHash', 'policyRevision', 'dialogueVersion']);
  result.stamps = {};
  for (const [key, stamp] of Object.entries(value.stamps || {})) {
    if (
      key === 'sourceHash'
        ? typeof stamp !== 'string' || !/^[a-f0-9]{64}$/u.test(stamp)
        : !Number.isSafeInteger(stamp) || stamp < 0 || stamp > 1000000000
    )
      invalid();
    result.stamps[key] = stamp;
  }
  return result;
}
function gap(code) {
  const definition = gapDefinitions[code];
  if (!definition) invalid();
  return { kind: definition[0], code, label: definition[2] };
}
function diagnoseSignal(value) {
  const signal = normalizeDiagnosticSignal(value),
    codes = [];
  if (signal.unsupportedBranch) codes.push('function_absent');
  if (signal.fields.missing.length) codes.push('input_missing');
  for (const key of ['directory', 'catalog', 'schedule'])
    if (['empty', 'unavailable'].includes(signal.data[key]))
      codes.push(key === 'directory' ? 'directory_unavailable' : key + '_unavailable');
  // Compare server-selected field presence, not the fields returned by one model reply.
  if (
    signal.fields.before &&
    signal.fields.after &&
    signal.fields.before.some(
      (field) => !signal.fields.after.includes(field) && !signal.fields.cleared.includes(field),
    )
  )
    codes.push('context_lost');
  if (['mismatch', 'empty'].includes(signal.checks.recognition)) codes.push('recognition_mismatch');
  if (signal.checks.modelContract === 'invalid') codes.push('model_contract');
  if (['irrelevant', 'empty'].includes(signal.checks.exampleSelection))
    codes.push('example_selection');
  if (
    ['clientCandidates', 'serviceCandidates', 'appointmentCandidates'].some(
      (key) => signal.counts[key] === 0,
    )
  )
    codes.push('entity_unresolved');
  if (['busy', 'outside_hours', 'past', 'forbidden', 'disabled'].includes(signal.checks.constraint))
    codes.push('business_constraint');
  if (signal.checks.provider === 'unavailable') codes.push('provider_unavailable');
  if (signal.checks.limit === 'exceeded') codes.push('limit_exceeded');
  if (signal.checks.audio === 'capture_failed') codes.push('audio_capture');
  if (signal.checks.audio === 'playback_blocked') codes.push('audio_playback');
  if (signal.checks.transport === 'interrupted') codes.push('transport_interrupted');
  const defect = codes.some((code) =>
    [
      'context_lost',
      'model_contract',
      'recognition_mismatch',
      'audio_capture',
      'audio_playback',
    ].includes(code),
  );
  const disposition = defect
    ? 'defect'
    : codes.length === 1 && codes[0] === 'input_missing'
      ? 'expected_clarification'
      : codes.length &&
          codes.every((code) => ['business_constraint', 'function_absent'].includes(code))
        ? 'expected_boundary'
        : 'review_required';
  return { signal, gaps: codes.map(gap), disposition };
}
module.exports = {
  fieldNames,
  phaseNames,
  gapDefinitions,
  normalizeDiagnosticSignal,
  diagnoseSignal,
  gap,
};
