const { fail } = require('../../../../shared/errors.cjs');
const { object, keys, boundedText } = require('../interpretation/intent-schema.cjs');
const { normalizedLimits } = require('./member-limits.cjs');
const {
  normalizeExamples,
  normalizeExampleSelection,
  rulesFromPolicy,
} = require('../behavior/behavior-schema.cjs');
const { initialBehavior, normalizeBehavior } = require('../behavior/behavior-history.cjs');
const { behaviorPromptBudget } = require('../behavior/behavior-prompt-budget.cjs');
const {
  providerAllowed,
  providerSettings,
} = require('../providers/local-speech/local-speech-settings.cjs');
const providerModels = Object.freeze({
  stt: 'openai/gpt-4o-mini-transcribe',
  llm: 'deepseek/deepseek-flash',
  tts: 'openai/gpt-4o-mini-tts',
});
const limits = Object.freeze({
  monthlyBudgetRub: 100,
  dailyRequests: 50,
  maxTextChars: 2000,
  maxAudioSeconds: 30,
  maxReplyChars: 600,
  maxOutputTokens: 500,
  requestTimeoutMs: 20000,
});
function initialState() {
  return {
    schema: 1,
    revision: 0,
    policy: {
      mode: 'off',
      commands: { calendar: true, clients: true, prepareAppointment: true },
      limits: { ...limits },
      instructions: '',
      dictionary: '',
      exampleSelection: 'manual',
      examples: [],
    },
    behavior: initialBehavior(),
    providers: Object.fromEntries(
      Object.entries(providerModels).map(([kind, model]) => [
        kind,
        { provider: 'demo', model, ...(kind === 'tts' ? { voice: 'alloy' } : {}) },
      ]),
    ),
    rates: {
      llmInput: 41,
      llmOutput: 162,
      sttInput: 405,
      sttOutput: 675,
      ttsInput: 81,
      ttsOutput: 1620,
    },
    credentials: {},
    grants: [],
    usage: {},
    reservations: {},
    daily: {},
    operations: [],
    audit: [],
    history: [],
  };
}
function patchSettings(state, values) {
  if (values.policy !== undefined) {
    keys(values.policy, [
      'mode',
      'commands',
      'limits',
      'instructions',
      'dictionary',
      'examples',
      'exampleSelection',
    ]);
    const next = values.policy;
    if (next.mode !== undefined) {
      if (!['off', 'selected'].includes(next.mode))
        throw fail(400, 'Выберите закрытый режим доступа.');
      state.policy.mode = next.mode;
    }
    if (next.commands !== undefined) {
      keys(next.commands, ['calendar', 'clients', 'prepareAppointment']);
      for (const [key, value] of Object.entries(next.commands)) {
        if (typeof value !== 'boolean') throw fail(400, 'Разрешение должно быть переключателем.');
        state.policy.commands[key] = value;
      }
    }
    if (next.limits !== undefined) {
      Object.assign(state.policy.limits, normalizedLimits(next.limits));
    }
    for (const key of ['instructions', 'dictionary'])
      if (next[key] !== undefined) state.policy[key] = boundedText(next[key], 4000, key);
    if (next.exampleSelection !== undefined)
      state.policy.exampleSelection = normalizeExampleSelection(next.exampleSelection);
    if (next.examples !== undefined)
      state.policy.examples = normalizeExamples(next.examples, {
        exampleSelection: state.policy.exampleSelection,
      });
    Object.assign(state.policy, rulesFromPolicy(state.policy));
  }
  if (values.providers !== undefined) {
    keys(values.providers, ['stt', 'llm', 'tts']);
    for (const [kind, options] of Object.entries(values.providers)) {
      keys(options, kind === 'tts' ? ['provider', 'model', 'voice'] : ['provider', 'model']);
      state.providers[kind] = providerSettings(
        kind,
        options,
        state.providers[kind],
        providerModels,
      );
    }
  }
  if (values.rates !== undefined) {
    keys(values.rates, Object.keys(state.rates));
    for (const [key, value] of Object.entries(values.rates)) {
      if (!Number.isFinite(value) || value <= 0 || value > 1000000)
        throw fail(400, 'Укажите положительную цену за миллион токенов.');
      state.rates[key] = value;
    }
  }
  if (values.timewebApiKey !== undefined) {
    if (values.timewebApiKey === null) delete state.credentials.timeweb;
    else {
      const key = boundedText(values.timewebApiKey, 512, 'ключ').trim();
      if (key.length < 12 || /\s/.test(key)) throw fail(400, 'Некорректный ключ провайдера.');
      state.credentials.timeweb = key;
    }
  }
  behaviorPromptBudget(state);
}
function validateState(state) {
  if (
    !object(state) ||
    state.schema !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.grants) ||
    state.grants.length > 500 ||
    !Array.isArray(state.audit) ||
    !Array.isArray(state.operations) ||
    !Array.isArray(state.history) ||
    !object(state.credentials) ||
    !object(state.usage) ||
    !object(state.reservations) ||
    !object(state.daily) ||
    state.audit.length > 100 ||
    state.operations.length > 100 ||
    state.history.length > 10 ||
    Object.keys(state.reservations).length > 500 ||
    Object.keys(state.daily).length > 1000 ||
    Object.keys(state.usage).length > 24
  )
    throw Error('Invalid encrypted assistant state.');
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
  if (
    state.grants.some(
      (g) =>
        !object(g) ||
        !id(g.organizationId) ||
        !id(g.accountId) ||
        typeof g.membershipId !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(g.membershipId),
    )
  )
    throw Error('Invalid assistant membership grant.');
  for (const grant of state.grants)
    if (grant.limits !== undefined) normalizedLimits(grant.limits, true);
  keys(state.credentials, ['timeweb']);
  if (
    state.credentials.timeweb !== undefined &&
    (typeof state.credentials.timeweb !== 'string' ||
      state.credentials.timeweb.length < 12 ||
      state.credentials.timeweb.length > 512 ||
      /\s/.test(state.credentials.timeweb))
  )
    throw Error('Invalid encrypted assistant credential.');
  for (const [month, usage] of Object.entries(state.usage))
    if (
      !/^\d{4}-\d{2}$/.test(month) ||
      !object(usage) ||
      !Number.isFinite(usage.spentRub) ||
      usage.spentRub < 0 ||
      !Number.isSafeInteger(usage.calls) ||
      usage.calls < 0 ||
      !Number.isSafeInteger(usage.uncertainCalls) ||
      usage.uncertainCalls < 0
    )
      throw Error('Invalid assistant usage.');
  for (const reservation of Object.values(state.reservations))
    if (
      !object(reservation) ||
      !Number.isFinite(reservation.amount) ||
      reservation.amount < 0 ||
      !Number.isSafeInteger(reservation.createdAt) ||
      !/^\d{4}-\d{2}$/.test(reservation.month) ||
      !['stt', 'llm', 'tts'].includes(reservation.kind)
    )
      throw Error('Invalid assistant reservation.');
  for (const value of Object.values(state.daily))
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid assistant request count.');
  if (
    !object(state.policy) ||
    !object(state.policy.commands) ||
    !object(state.policy.limits) ||
    !object(state.providers) ||
    !object(state.rates)
  )
    throw Error('Missing assistant settings.');
  const reference = initialState();
  if (
    !['off', 'selected'].includes(state.policy.mode) ||
    ['instructions', 'dictionary'].some((key) => typeof state.policy[key] !== 'string') ||
    Object.keys(reference.policy.commands).some(
      (key) => typeof state.policy.commands[key] !== 'boolean',
    ) ||
    Object.keys(reference.policy.limits).some((key) => state.policy.limits[key] === undefined) ||
    Object.keys(reference.providers).some(
      (key) =>
        !object(state.providers[key]) ||
        !providerAllowed(key, state.providers[key].provider) ||
        typeof state.providers[key].model !== 'string' ||
        (key === 'tts' && typeof state.providers[key].voice !== 'string'),
    ) ||
    Object.keys(reference.rates).some((key) => state.rates[key] === undefined)
  )
    throw Error('Incomplete assistant settings.');
  patchSettings(reference, {
    policy: state.policy,
    providers: state.providers,
    rates: state.rates,
  });
  for (const entry of state.history) {
    if (
      !object(entry) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      !Number.isSafeInteger(entry.time) ||
      !object(entry.policy) ||
      !object(entry.providers) ||
      !object(entry.rates)
    )
      throw Error('Invalid assistant policy history.');
    patchSettings(initialState(), entry);
  }
  Object.assign(state.policy, rulesFromPolicy(state.policy));
  for (const entry of state.history) Object.assign(entry.policy, rulesFromPolicy(entry.policy));
  state.behavior = normalizeBehavior(state.behavior);
  return state;
}
module.exports = { initialState, patchSettings, validateState, keys, boundedText };
