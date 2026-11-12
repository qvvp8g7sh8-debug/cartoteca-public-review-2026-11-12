const { fail } = require('../../../../shared/errors.cjs');
const { detectRequestedOperation } = require('./requested-operation.cjs');
function assertIntentAction(raw, intent) {
  if (intent === 'help') return;
  const requested = detectRequestedOperation(raw);
  if (requested.negated) throw fail(400, 'Действие не выполняю. Назовите нужную команду.');
  if (requested.ambiguous) throw fail(400, 'Назовите одну задачу с записью или карточкой.');
  if (requested.intent && requested.intent !== intent)
    throw fail(502, 'Не удалось правильно разобрать действие. Повторите команду.');
}
function unconditionalNegativeAction(raw, proveName) {
  const requested = detectRequestedOperation(raw);
  const operation = requested.operation;
  if (!requested.negated || requested.ambiguous || !operation?.intent) return;
  const prefix = raw.slice(0, operation.start);
  if (
    !/^(?:пожалуйста[,\s]+)?(?:не\s+|(?:я\s+)?не\s+хочу\s+|не\s+(?:нужно|надо|следует)\s+)$/iu.test(
      prefix,
    )
  )
    return;
  if (
    /^(?:пожалуйста[,\s]+)?не\s+$/iu.test(prefix) &&
    /^[^\s,.!?;:]+(?:ть|ти|чь|ться|тись|чься)(?=$|[\s,.!?;:])/iu.test(
      raw.slice(operation.start, operation.end),
    )
  )
    return;
  // Accelerate only a fully bounded denial. Uncovered framing, conditions and
  // alternatives keep the late grounding path rather than broadening this rule.
  const tail = raw
    .slice(operation.end)
    .trim()
    .replace(/^(?:клиента|клиентки|пациента|пациентки)\s+/u, '');
  if (
    /(?:^|\s)(?:если|или|либо|а|но|и|когда|пока|чтобы|вместо|кроме|не)(?=$|[\s,.!?;:])/iu.test(tail)
  )
    return;
  const strictTail =
    /^(?:(?:[А-ЯЁ][а-яё]+(?:[-'’][А-ЯЁа-яё]+)?|сегодня|завтра|послезавтра|на|в|во|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d{1,2})(?:\s+|(?=[.!…]*$))){0,10}[.!…]*$/u;
  if (!strictTail.test(tail)) {
    if (typeof proveName !== 'function') return;
    const words = tail
      .replace(/,/gu, ' ')
      .replace(/[.!…]+$/u, '')
      .trim()
      .split(/\s+/u);
    const temporal =
      /^(?:(?:сегодня|завтра|послезавтра|на|в|во|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d{1,2})(?:\s+|$)){0,6}$/u;
    let proven = false;
    for (let count = 1; count <= Math.min(4, words.length); count++)
      if (proveName(words.slice(0, count).join(' ')) && temporal.test(words.slice(count).join(' ')))
        proven = true;
    if (!proven) return;
  }
  return requested.intent;
}
function assertEarlyNegativeAction(raw) {
  const intent = unconditionalNegativeAction(raw);
  if (intent) assertIntentAction(raw, intent);
}
module.exports = { assertIntentAction, assertEarlyNegativeAction, unconditionalNegativeAction };
