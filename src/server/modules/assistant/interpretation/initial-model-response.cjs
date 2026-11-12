const { parseModelIntent } = require('./intents.cjs');
const nullableTemporalFields = new Set(['date', 'endDate', 'time', 'endTime', 'duration']);
// Provider wire compatibility only: a blank temporal value means unknown, never
// an inferred date, time, length, identity or permission. The core parser stays strict.
function parseInitialModelResponse(text) {
  return parseModelIntent(text, (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, field] of Object.entries(value)) {
        // Preserve the previous JSON round trip's handling of numeric overflow.
        if (
          (typeof field === 'number' && !Number.isFinite(field)) ||
          (nullableTemporalFields.has(key) && typeof field === 'string' && !field.trim())
        )
          value[key] = null;
      }
    return value;
  });
}
module.exports = { parseInitialModelResponse };
