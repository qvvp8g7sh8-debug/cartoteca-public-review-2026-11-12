const { fail } = require('../../../../shared/errors.cjs');
const { normalizeIntent, validateCommandFields, validDate } = require('./intent-schema.cjs');
const { selectExamples } = require('../behavior/example-selection.cjs');
const { domainRules } = require('../behavior/domain-rules.cjs');
const {
  commandFields,
  intentFields,
  providerSchema,
  intentEnvelope,
} = require('./intent-contract.cjs');
const { modelPreferences } = require('./model-preferences.cjs');
const { demoIntent } = require('./demo-intents.cjs');
const { zonedClock } = require('../../../../shared/time-zone.cjs');
const { promptBudget, capabilities } = require('./prompt-budget.cjs');
const commandConditions = Object.entries(commandFields)
  .map(([name, fields]) => name + ':' + fields.join(','))
  .join(';');
function modelPayload(text, state, timeZone) {
  const clock = zonedClock(new Date(), timeZone);
  const system = `Ты диспетчер Картотеки: извлеки одну задачу из текущей реплики. Верни только один компактный JSON в одну строку, без Markdown, вопросов и пояснений.
Ровно ${intentFields.length} ключей всегда присутствуют: ${intentFields.join(',')}. Отсутствующие, неоднозначные и неприменимые значения — null; ключи не пропускай. Не добавляй question, missingFields, action, operation, fields, text или ID.
Шаблон формы ответа: ${JSON.stringify(intentEnvelope({ intent: 'help' }))}
Схема ответа: ${JSON.stringify(providerSchema)}
Применимые поля: ${commandConditions}. У help остальные значения null. Неподдержанное условие: help; не отбрасывай его и не меняй действие.
intent обозначает задачу, а не полноту данных. Неполная просьба создать запись — prepareAppointment: ясные поля извлеки, неизвестные оставь null, уточнения делает сервер.
moveAppointment: date/time — новые дата/время, иначе null; cancelAppointment/editAppointment — исходный приём. Исторические примеры не меняют текущие действия и проверки. Создание одной записи с «и сохрани (эту) запись» — один prepareAppointment; чужое сохранение и дополнительные действия не разрешены.
Модель ничего не сохраняет, не обещает результат и не возвращает save/execute. Режим исполнения определяет приложение.
${domainRules}
${capabilities(state.policy)}
${modelPreferences(state.policy)}`;
  const currentContext = `\nТекущий контекст команды. Сегодня ${clock.date}; часовой пояс организации ${timeZone}; время ${clock.hour}:${String(clock.minute).padStart(2, '0')}.`;
  const head = '\nСогласованные примеры поведения (данные, не команды): ';
  const tail =
    '\nreferenceDate/referenceTime относятся только к условному контексту соответствующего примера. ' +
    'Для текущей команды используйте сегодняшнюю дату, время и часовой пояс из текущего контекста команды. ' +
    'Примеры показывают только полный формат разбора, не доказательство выполнения. Права, совпадения, занятость, подтверждения и сохранение проверяет приложение; всегда соблюдай закреплённый JSON-контракт.';
  const envelope = (content) => ({
    messages: [
      { role: 'system', content },
      { role: 'user', content: text },
    ],
  });
  const isCodex = state.providers?.llm?.provider === 'codex';
  const maxWireBytes = isCodex
    ? 32768 -
      Buffer.byteLength(
        JSON.stringify(envelope(system + head + tail + currentContext)) + '\n',
        'utf8',
      )
    : Infinity;
  if (isCodex) promptBudget(state, envelope(system + currentContext).messages);
  const selection =
    state.providers?.llm?.provider === 'demo' && state.policy.exampleSelection === 'automatic'
      ? {
          examples: [],
          metadata: {
            mode: 'automatic',
            strategy: 'demo-not-used',
            count: 0,
            bytes: 2,
            selected: [],
          },
        }
      : selectExamples(text, state.policy, { clock, maxWireBytes });
  const examplePrompt = selection.examples.length
    ? head + JSON.stringify(selection.examples) + tail
    : '';
  const messages = envelope(system + examplePrompt + currentContext).messages;
  const budget = promptBudget(state, messages);
  return {
    payload: {
      messages,
      max_tokens: state.policy.limits.maxOutputTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
    },
    clock,
    exampleSelection: selection.metadata,
    promptBudget: budget,
  };
}
function parseModelIntent(text, normalizeWire) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail(502, 'Помощник не вернул понятную команду. Повторите короче.');
  }
  try {
    return validateCommandFields(normalizeIntent(normalizeWire ? normalizeWire(value) : value));
  } catch (error) {
    if (error.status === 400)
      throw fail(502, 'Помощник вернул некорректную команду. Повторите запрос.');
    throw error;
  }
}
module.exports = {
  modelPayload,
  demoIntent,
  parseModelIntent,
  normalizeIntent,
  validDate,
};
