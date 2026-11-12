const { readCabinetSnapshot } = require('../../../../infrastructure/cabinet-read-snapshot.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { parseClientPhoneAnswer } = require('./client-phone-answer.cjs');
const {
  SUGGESTION_LIMITS,
  nameSuggestionPlan,
  rankNameSuggestions,
} = require('./name-suggestions.cjs');
const { directoryPage } = require('../../../cabinet/directory.cjs');
const { correlatedClientMatches } = require('./name-correlated-directory.cjs');
const { LIMITS, matchesName, searchPlan, patientQuery } = require('./name-matching.cjs');
const { clientComponentPlan, rankClientComponents } = require('./client-name-components.cjs');
const { readSteps } = require('../../read-steps.cjs');
function scopedReads(operation) {
  const run = readSteps(operation);
  return function (c, ...args) {
    const read = () => run(c, ...args);
    return c.assistantReads?.snapshot ? c.assistantReads.snapshot(read) : read();
  };
}
function directory(c, query, limit) {
  if (c.assistantReads) return c.assistantReads.directory(query, limit);
  const url = new URL('http://assistant.invalid/');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  return directoryPage(
    c.tenantStore(c.current.organizationId),
    c.current,
    url,
    undefined,
    c.platform.organizationTimeZone(c.current.organizationId),
  );
}
function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}
function phoneQuery(value) {
  return parseClientPhoneAnswer(value)?.kind === 'full';
}
function matchesPhone(patient, query) {
  const actual = phoneDigits(patient.phone),
    wanted = phoneDigits(query);
  if (actual === wanted) return true;
  return (
    /^[78]\d{10}$/u.test(actual) &&
    /^[78]\d{10}$/u.test(wanted) &&
    actual.slice(1) === wanted.slice(1) &&
    !/^\s*\+8/u.test(patient.phone || '') &&
    !/^\s*\+8/u.test(query)
  );
}
const resolveClient = scopedReads(function* (c, query) {
  const phone = phoneQuery(query);
  if (!phone) {
    const correlated = yield correlatedClientMatches(c, query);
    if (correlated) return correlated;
  }
  const plan = phone ? { queries: [phoneDigits(query)], overflow: false } : searchPlan(query);
  if (!plan.queries.length) return { matches: [], overflow: plan.overflow };
  const candidates = new Map(),
    matches = new Map();
  for (const variant of plan.queries) {
    const page = yield directory(c, variant, LIMITS.perQuery);
    if (page.matched > LIMITS.perQuery) return { matches: [...matches.values()], overflow: true };
    for (const patient of page.directory) {
      candidates.set(patient.id, patient);
      if (candidates.size > LIMITS.candidates)
        return { matches: [...matches.values()], overflow: true };
      if (phone ? matchesPhone(patient, query) : matchesName(patient, query))
        matches.set(patient.id, patient);
    }
  }
  return { matches: [...matches.values()], overflow: false };
});
function clientSearchQuery(result, fallback) {
  if (result.overflow || result.matches.length > 1) return '';
  if (result.matches.length !== 1) return fallback;
  const name = patientQuery(result.matches[0]);
  return name.length > 160 ? '' : name || fallback;
}

function suggestionIdentity(current) {
  return JSON.stringify([
    current?.organizationId,
    current?.accountId,
    current?.role,
    current?.sessionId,
  ]);
}
function assertSuggestionScope(c, expected = '') {
  c.assertCurrent();
  const current = c.current;
  if (
    !current?.organizationId ||
    !current.accountId ||
    current.globalAdmin ||
    !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
  )
    throw fail(403, 'Нет доступа к поиску клиентов этой организации.');
  if (expected && suggestionIdentity(current) !== expected)
    throw fail(409, 'Доступ к поиску клиентов изменился. Повторите запрос.');
  return current;
}
const suggestClientMatches = scopedReads(function* (c, query) {
  const current = assertSuggestionScope(c),
    identity = suggestionIdentity(current),
    plan = nameSuggestionPlan(query);
  if (!plan.queries.length) return { matches: [], overflow: false, approximate: true };
  const candidates = new Map();
  let overflow = false;
  for (const anchor of plan.queries) {
    assertSuggestionScope(c, identity);
    const page = yield directory(c, anchor, SUGGESTION_LIMITS.perQuery);
    if (page.matched > SUGGESTION_LIMITS.perQuery) {
      overflow = true;
      continue;
    }
    for (const patient of page.directory) {
      if (!candidates.has(patient.id) && candidates.size >= SUGGESTION_LIMITS.candidates) {
        overflow = true;
        break;
      }
      candidates.set(patient.id, patient);
    }
    if (candidates.size >= SUGGESTION_LIMITS.candidates && overflow) break;
  }
  assertSuggestionScope(c, identity);
  const ranked = rankNameSuggestions([...candidates.values()], plan);
  return {
    matches: ranked.slice(0, SUGGESTION_LIMITS.results),
    overflow: overflow || ranked.length > SUGGESTION_LIMITS.results,
    approximate: true,
  };
});
const suggestClientComponents = scopedReads(function* (c, query) {
  const current = assertSuggestionScope(c),
    identity = suggestionIdentity(current),
    plan = clientComponentPlan(query);
  const empty = { matches: [], overflow: plan.overflow, approximate: true };
  if (!plan.queries.length) return empty;
  const candidates = new Map();
  for (const anchor of plan.queries) {
    assertSuggestionScope(c, identity);
    const page = yield directory(c, anchor, SUGGESTION_LIMITS.perQuery);
    if (page.matched > SUGGESTION_LIMITS.perQuery) return { ...empty, overflow: true };
    for (const patient of page.directory) {
      candidates.set(patient.id, patient);
      if (candidates.size > SUGGESTION_LIMITS.candidates) return { ...empty, overflow: true };
    }
  }
  assertSuggestionScope(c, identity);
  return rankClientComponents([...candidates.values()], plan);
});
const currentSuggestedClients = readSteps(function* (c, ids) {
  const current = assertSuggestionScope(c),
    identity = suggestionIdentity(current);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 12 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 128)
  )
    return [];
  if (c.assistantReads) {
    const patients = yield c.assistantReads.summaries(ids);
    assertSuggestionScope(c, identity);
    return patients;
  }
  const wanted = new Set(ids),
    storage = c.tenantStore(current.organizationId);
  return readCabinetSnapshot(storage, () => {
    assertSuggestionScope(c, identity);
    const rows = storage.indexes.summaryRows(current, ids);
    assertSuggestionScope(c, identity);
    const patients = rows.flatMap((row) => {
      if (!wanted.has(row.patient_id)) return [];
      const patient = storage.decode(row.value);
      return patient?.id === row.patient_id ? [patient] : [];
    });
    assertSuggestionScope(c, identity);
    return patients;
  });
});
const currentSuggestedClient = readSteps(function* (c, id) {
  return (yield currentSuggestedClients(c, [id]))[0] || null;
});
module.exports = {
  resolveClient,
  clientSearchQuery,
  suggestClientMatches,
  suggestClientComponents,
  currentSuggestedClient,
  currentSuggestedClients,
};
