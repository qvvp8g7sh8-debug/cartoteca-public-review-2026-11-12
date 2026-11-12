const { fail } = require('../../../../shared/errors.cjs');
const { promptBudget } = require('../interpretation/prompt-budget.cjs');
// Save-time compatibility check only. Legacy encrypted policy remains readable;
// each real composition is independently checked with its exact current context.
function behaviorPromptBudget(state, rules = state.policy) {
  if (state.providers?.llm?.provider !== 'codex')
    return { provider: state.providers?.llm?.provider, limit: null };
  const next = {
    ...state,
    policy: { ...state.policy, ...rules, examples: [], exampleSelection: 'manual' },
  };
  const text = '漢'.repeat(state.policy.limits.maxTextChars);
  const context = {
    step: 'service',
    role: 'owner',
    clock: { date: '2099-01-05', hour: 9, minute: 0 },
    selected: {
      clientQuery: '漢'.repeat(160),
      staffQuery: '漢'.repeat(160),
      serviceQuery: '漢'.repeat(160),
      date: '2099-01-05',
      time: '12:00',
      duration: 60,
    },
    missingFields: ['service'],
    options: Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      kind: 'slot',
      date: '2099-01-05',
      time: '12:00',
      endTime: '13:00',
    })),
    dateClarification: {
      day: 29,
      proposedDate: '2099-01-29',
      confirmedMonth: null,
      stage: 'monthConfirmation',
    },
  };
  try {
    const { modelPayload } = require('../interpretation/intents.cjs');
    const { continuationPayload } = require('../dialogue/continuation/continuation-prompt.cjs');
    const initial = promptBudget(next, modelPayload(text, next, 'Europe/Moscow').payload.messages);
    const continuation = promptBudget(
      next,
      continuationPayload(text, next, context, 'Europe/Moscow').payload.messages,
    );
    return {
      provider: 'codex',
      limit: initial.limit,
      reservedTextChars: text.length,
      initial,
      continuation,
    };
  } catch (error) {
    if (error.status !== 413) throw error;
    throw fail(
      400,
      'Настройки не помещаются в запрос Codex при разрешённой длине реплики. Сократите инструкции/словарь или лимит текста. ' +
        error.message,
    );
  }
}
module.exports = { behaviorPromptBudget };
