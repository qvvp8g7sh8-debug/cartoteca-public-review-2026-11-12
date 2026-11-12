const { loadCatalog } = require('./behavior-library.cjs');
const { normalizeIntent, validateCommandFields } = require('../interpretation/intent-schema.cjs');
const { intentEnvelope } = require('../interpretation/intent-contract.cjs');
const {
  currentIntentForCase: catalogExpected,
  excludedCaseIds,
} = require('./example-projection.cjs');
const { behaviorLimits } = require('./behavior-schema.cjs');
const { fold, documentProfile } = require('./example-features.cjs');
const { indexRows, scoreRows, packRows, tokenCounts } = require('./example-retrieval.cjs');
const { routeForCase, routeRows } = require('./example-routing.cjs');
// These author cases omit an explicit requested filter from their current intent.
// Keep them in the research library, but never teach the model to drop that filter.
const partialFilters = excludedCaseIds;
const permissions = {
  calendar: 'calendar',
  availability: 'calendar',
  clients: 'clients',
  clientCard: 'clients',
  prepareAppointment: 'prepareAppointment',
  moveAppointment: 'prepareAppointment',
  cancelAppointment: 'prepareAppointment',
  editAppointment: 'prepareAppointment',
};
function projection(value, expected) {
  try {
    return {
      text: value.text,
      referenceDate: value.referenceDate,
      referenceTime: value.referenceTime,
      expected: intentEnvelope(validateCommandFields(normalizeIntent(expected))),
    };
  } catch (error) {
    if (error.status === 502) return null;
    throw error;
  }
}
function sparseProfile(example) {
  // Full nullable wire objects must not invent retrieval features for absent fields.
  const profile = documentProfile({
    ...example,
    expected: validateCommandFields(normalizeIntent(example.expected)),
  });
  return { ...profile, counts: tokenCounts(profile.tokens) };
}
function indexedRows(rows) {
  return indexRows(rows, (row) => row.profile ?? sparseProfile(row.example));
}
function fixedRows(rows, context) {
  const examples = [],
    selected = [];
  let bytes = 2,
    wireBytes = 2;
  const maximumWire = Number.isFinite(context.maxWireBytes)
    ? Math.max(0, context.maxWireBytes)
    : Infinity;
  for (const row of rows) {
    const encoded = JSON.stringify(row.example),
      separator = examples.length ? 1 : 0;
    const size = Buffer.byteLength(encoded, 'utf8'),
      wire = Buffer.byteLength(JSON.stringify(encoded), 'utf8') - 2;
    if (
      examples.length >= behaviorLimits.maxEnabledExamples ||
      bytes + size + separator > behaviorLimits.maxEnabledExamplesBytes ||
      wireBytes + wire + separator > maximumWire
    )
      continue;
    examples.push(row.example);
    selected.push(row);
    bytes += size + separator;
    wireBytes += wire + separator;
  }
  return { examples, selected };
}
function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.example) return false;
    if (seen.has(row.identity)) return false;
    seen.add(row.identity);
    return true;
  });
}
function eligible(item) {
  if (!item.current || partialFilters.has(item.id)) return false;
  if (item.current.status === 'unsupported' && item.current.intent?.intent !== 'help') return false;
  if (!['supported', 'manual', 'needs_clarification', 'unsupported'].includes(item.current.status))
    return false;
  // This selector serves initial commands; active dialogue has a separate model contract.
  if (item.preconditions?.activeDialogue === true) return false;
  if (
    Array.isArray(item.preconditions) &&
    item.preconditions.some((value) =>
      /^(?:есть\s+)?активн(?:ый|ая|ое)\s+(?:серверный\s+)?диалог/iu.test(value),
    )
  )
    return false;
  return true;
}
function permitted(row, commands) {
  const key = permissions[row.example.expected.intent];
  return !key || commands?.[key] === true;
}
function normalizedExample(text) {
  return fold(text).replace(/\s+/gu, ' ').trim();
}
function identity(example, normalized) {
  return JSON.stringify([normalized, example.referenceDate, example.referenceTime]);
}
function customRows(policy) {
  return (policy.examples || [])
    .filter((item) => item.enabled)
    .map((item, order) => ({
      id: item.id,
      source: 'custom',
      category: item.expected.intent,
      order,
      example: projection(item, item.expected),
      normalizedText: normalizedExample(item.text),
      routing: routeForCase(
        { ...item, current: { status: 'supported', intent: item.expected } },
        item.expected,
      ),
    }))
    .filter((row) => row.example);
}
function metadata(mode, examples, selected, candidates = {}) {
  return {
    mode,
    branch: 'initial',
    version: 2,
    strategy: mode === 'automatic' ? 'capability-route-bm25-v2' : 'fixed-v1',
    count: examples.length,
    bytes: Buffer.byteLength(JSON.stringify(examples), 'utf8'),
    selected: selected.map(({ id, source, category }) => ({ id, source, category })),
    ...candidates,
  };
}
function createExampleSelector({ loadCatalog: readCatalog = loadCatalog } = {}) {
  let cached = null;
  return (text, policy, context = {}) => {
    const custom = customRows(policy).filter((row) => permitted(row, policy.commands));
    if (policy.exampleSelection !== 'automatic') {
      const packed = fixedRows(custom, context);
      return {
        examples: packed.examples,
        metadata: metadata('manual', packed.examples, packed.selected),
      };
    }
    const catalog = readCatalog();
    if (cached?.catalog !== catalog) {
      const rows = uniqueRows(
        catalog.cases.filter(eligible).map((item, order) => {
          const expected = catalogExpected(item);
          const example = projection(item, expected);
          const normalizedText = normalizedExample(item.text);
          return {
            id: item.id,
            source: 'catalog',
            category: item.category,
            order: behaviorLimits.maxCandidateExamples + order,
            example,
            normalizedText,
            profile: example && sparseProfile(example),
            identity: example && identity(example, normalizedText),
            routing: routeForCase(item, expected),
          };
        }),
      );
      cached = { catalog, rows, index: indexedRows(rows) };
    }
    // Approved custom examples override an exact built-in phrase in the same dated context.
    const customKeys = new Set(custom.map((row) => identity(row.example, row.normalizedText)));
    const unique = new Set();
    const combined = [
      ...custom,
      ...cached.rows.filter((row) => !customKeys.has(row.identity)),
    ].filter((row) => {
      const key = row.identity ?? identity(row.example, row.normalizedText);
      if (unique.has(key) || !permitted(row, policy.commands)) return false;
      unique.add(key);
      return true;
    });
    // The small immutable built-in index is reused when there are no additions or ACL filters.
    const routed = routeRows(combined, text);
    const index =
      !custom.length && routed.rows.length === cached.rows.length
        ? cached.index
        : indexedRows(routed.rows);
    const ranked = scoreRows(index, text, context);
    const packed = packRows(ranked, {
      maxCount: behaviorLimits.maxEnabledExamples,
      maxBytes: behaviorLimits.maxEnabledExamplesBytes,
      maxWireBytes: Number.isFinite(context.maxWireBytes)
        ? Math.max(0, context.maxWireBytes)
        : Infinity,
    });
    return {
      examples: structuredClone(packed.examples),
      metadata: metadata('automatic', packed.examples, packed.selected, {
        catalogCandidates: cached.rows.filter((row) => permitted(row, policy.commands)).length,
        customCandidates: custom.filter((row) => permitted(row, policy.commands)).length,
        routing: routed.metadata,
      }),
    };
  };
}
const selectExamples = createExampleSelector();
module.exports = { createExampleSelector, selectExamples, eligible };
