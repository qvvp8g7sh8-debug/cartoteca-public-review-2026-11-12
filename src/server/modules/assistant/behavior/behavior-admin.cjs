const { fail } = require('../../../../shared/errors.cjs');
const { createBehaviorLibrary } = require('./behavior-library.cjs');
const { keys, validateCommandFields } = require('../interpretation/intent-schema.cjs');
const {
  behaviorLimits,
  normalizeRules,
  rulesFromPolicy,
  applyRules,
} = require('./behavior-schema.cjs');
const { rulesAtVersion, versionSummaries } = require('./behavior-history.cjs');
const { compareRules, reviewHash, requireReview } = require('./behavior-review.cjs');
const { behaviorPromptBudget } = require('./behavior-prompt-budget.cjs');
function normalizeDraftRules(value) {
  const rules = normalizeRules(value);
  for (const [index, example] of rules.examples.entries()) {
    if (!example.enabled) continue;
    try {
      validateCommandFields(example.expected);
    } catch (error) {
      if (error.status !== 502) throw error;
      throw fail(
        400,
        'Пример №' +
          (index + 1) +
          ': ожидаемый результат содержит неподдерживаемые условия. Исправьте его или выключите пример.',
      );
    }
  }
  return rules;
}
function createBehaviorAdministration(store, policy, command) {
  function read(actorId) {
    policy.assertAdmin(actorId);
    return store.adminSnapshot ? store.adminSnapshot() : store.read();
  }
  function view(actorId) {
    const state = read(actorId);
    return {
      revision: state.revision,
      version: state.behavior.version,
      rules: rulesFromPolicy(state.policy),
      versions: versionSummaries(state),
      limits: { ...behaviorLimits },
      llmProvider: { ...state.providers.llm },
      exampleScopes: {
        initial: { version: 2, maxCount: 12 },
        continuation: { version: 2, maxCount: 6, adaptation: 'validated-prepare-fields' },
      },
    };
  }
  function compare(actorId, fromVersion, toVersion) {
    const state = read(actorId),
      before = rulesAtVersion(state, fromVersion),
      after = rulesAtVersion(state, toVersion);
    return {
      revision: state.revision,
      fromVersion,
      toVersion,
      before,
      after,
      changes: compareRules(before, after),
    };
  }
  function preview(actorId, body) {
    const state = read(actorId);
    keys(body, ['expectedRevision', 'rules', 'sourceVersion']);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
      throw fail(400, 'Укажите текущую версию настроек.');
    if (body.expectedRevision !== state.revision)
      throw fail(409, 'Настройки уже изменились. Обновите раздел.');
    const restoring = body.sourceVersion !== undefined;
    if (restoring === (body.rules !== undefined))
      throw fail(400, 'Передайте правила или одну версию для восстановления.');
    const rules = restoring
      ? rulesAtVersion(state, body.sourceVersion)
      : normalizeDraftRules(body.rules);
    const sourceVersion = restoring ? body.sourceVersion : null;
    const promptBudget = behaviorPromptBudget(state, rules);
    return {
      revision: state.revision,
      version: state.behavior.version,
      sourceVersion,
      rules,
      changes: compareRules(rulesFromPolicy(state.policy), rules),
      reviewHash: reviewHash(actorId, state.revision, rules, sourceVersion),
      promptBudget,
    };
  }
  function approve(actorId, body) {
    policy.assertAdmin(actorId);
    keys(body, ['expectedRevision', 'requestId', 'reason', 'rules', 'reviewHash', 'confirmed']);
    if (body.confirmed !== true) throw fail(400, 'Подтвердите применение просмотренных правил.');
    command(actorId, body, 'assistant_behavior_approved', (state) => {
      const rules = normalizeDraftRules(body.rules);
      behaviorPromptBudget(state, rules);
      requireReview(actorId, state, rules, null, body.reviewHash);
      applyRules(state, rules);
    });
    return view(actorId);
  }
  function restore(actorId, body) {
    policy.assertAdmin(actorId);
    keys(body, [
      'expectedRevision',
      'requestId',
      'reason',
      'sourceVersion',
      'reviewHash',
      'confirmed',
    ]);
    if (body.confirmed !== true)
      throw fail(400, 'Подтвердите восстановление просмотренной версии.');
    command(actorId, body, 'assistant_behavior_restored', (state) => {
      const rules = rulesAtVersion(state, body.sourceVersion);
      behaviorPromptBudget(state, rules);
      requireReview(actorId, state, rules, body.sourceVersion, body.reviewHash);
      applyRules(state, rules);
    });
    return view(actorId);
  }
  return { view, compare, preview, approve, restore, library: createBehaviorLibrary(policy) };
}
module.exports = { createBehaviorAdministration };
