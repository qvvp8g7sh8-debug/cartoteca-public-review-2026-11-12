const {
  clientCorrectionQuery,
  isClientCorrectionQuery,
} = require('../../dialogue/client-correction.cjs');
const { temporalCorrectionScope } = require('../../language/time/temporal-correction-scope.cjs');
const { wholeManagementTemporalProof } = require('./appointment-management-temporal.cjs');
const { matchesName } = require('../../language/names/name-matching.cjs');
const { temporalWordsOnly } = require('../../language/time/temporal-words.cjs');
const { managementCorrectionRemainder } = require('./appointment-management-replacement.cjs');
const role =
  /(?:^|[\s,;])(?:клиента?\s+(?:поменяй|смени|измени)(?:\s+на)?|(?:поменяй|смени|измени)\s+клиента?(?:\s+на)?|клиент(?:а)?)\s+/iu;
const trim = (value) =>
  value
    .trim()
    .replace(/^[,;\s]+|[,;\s.!?…]+$/gu, '')
    .trim();
// Resolve the entire role/temporal composition before its tail can be applied
// to the old patient. Queries remain literal; no identity is inferred here.
function managementClientCorrection(raw, clock, contextDate, selectedClient) {
  const remainder = managementCorrectionRemainder(raw);
  if (remainder !== null) raw = 'Нет, ' + remainder;
  const scope = temporalCorrectionScope(
    String(raw || '')
      .trim()
      .replace(/^нет[,\s]+/iu, ''),
  );
  const anchored = !scope || Boolean(selectedClient && matchesName(selectedClient, scope.rejected));
  const direct = clientCorrectionQuery(raw);
  if (direct || !clock) return anchored ? direct : null;
  let source = String(raw || '')
    .trim()
    .replace(/^(?:нет|пожалуйста)[,\s]+/iu, '');
  if (source.length > 160) return null;
  const replacement = temporalCorrectionScope(source);
  let rejected;
  if (replacement && !replacement.before.trim()) {
    if (!anchored) return null;
    rejected = replacement.rejected;
    source = replacement.after;
  }
  const match = role.exec(source);
  const head = match ? trim(source.slice(0, match.index)) : '';
  let tail = match ? source.slice(match.index + match[0].length) : rejected ? source : '';
  const tailReplacement = match && temporalCorrectionScope(tail);
  if (tailReplacement && !tailReplacement.before.trim()) {
    if (!selectedClient || !matchesName(selectedClient, tailReplacement.rejected)) return null;
    rejected = tailReplacement.rejected;
    tail = tailReplacement.after;
  }
  if (!tail || (head && !wholeManagementTemporalProof(head, clock, contextDate))) return null;
  const words = trim(tail).split(/\s+/u),
    matches = new Map();
  for (let split = 1; split <= Math.min(words.length, 6); split++) {
    const candidate = trim(words.slice(0, split).join(' '));
    const client = clientCorrectionQuery('Клиент ' + candidate);
    if (!client?.query) continue;
    if (rejected && !clientCorrectionQuery('Не ' + rejected + ', а ' + candidate)) continue;
    const rest = trim(words.slice(split).join(' '));
    const temporal = [head, rest].filter(Boolean).join(' ');
    if (!temporal) continue;
    const constraints = wholeManagementTemporalProof(temporal, clock, contextDate);
    if (!constraints) continue;
    matches.set(JSON.stringify([client.query, constraints]), { query: client.query, constraints });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
function explicitClientCorrection(raw, clock, contextDate) {
  const remainder = managementCorrectionRemainder(raw);
  if (remainder !== null) raw = 'Нет, ' + remainder;
  const text = String(raw || '')
    .trim()
    .replace(/^(?:нет|пожалуйста)[,\s]+/iu, '');
  const match = role.exec(text);
  return Boolean(
    match &&
    (!text.slice(0, match.index).trim() ||
      wholeManagementTemporalProof(trim(text.slice(0, match.index)), clock, contextDate)),
  );
}
function bareManagementClientCorrection(raw, clock, contextDate) {
  const remainder = managementCorrectionRemainder(raw);
  if (remainder === null) return null;
  const words = trim(remainder).split(/\s+/u),
    matches = new Map();
  // A bare correction is only a candidate role. The caller must distinguish a
  // currently available patient from an existing source service before using it.
  for (let start = 0; start < words.length; start++)
    for (let size = 1; size <= 4 && start + size <= words.length; size++) {
      const query = trim(words.slice(start, start + size).join(' '));
      if (!isClientCorrectionQuery(query)) continue;
      if ((/\p{L}/u.test(query) && temporalWordsOnly(query)) || /^(?:пред)?последн/iu.test(query))
        continue;
      const temporal = [words.slice(0, start).join(' '), words.slice(start + size).join(' ')]
        .map(trim)
        .filter(Boolean)
        .join(' ');
      const constraints = temporal
        ? wholeManagementTemporalProof(temporal, clock, contextDate)
        : {};
      if (!constraints) continue;
      matches.set(JSON.stringify([query, constraints]), { query, constraints });
    }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
module.exports = {
  managementClientCorrection,
  explicitClientCorrection,
  bareManagementClientCorrection,
};
