const { cardNounPattern } = require('../interpretation/client-card-grammar.cjs');
const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
function dialogueControl(value, currentOperation = '') {
  if (typeof value !== 'string' || value.length > 160) return null;
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim()
    .replace(/^пожалуйста[, ]+/u, '')
    .replace(/[, ]+пожалуйста$/u, '')
    .trim();
  if (
    /^(?:повтори(?:те)?(?: (?:вопрос|еще раз))?|еще раз|не (?:расслышал[аи]?|услышал[аи]?)|что ты сказал[а]?)$/u.test(
      text,
    )
  )
    return 'question';
  if (
    /^(?:повтори(?:те)? (?:варианты|список)|(?:назови(?:те)?|перечисли(?:те)?) варианты(?: еще раз)?|какие (?:есть )?варианты)$/u.test(
      text,
    )
  )
    return 'choices';
  if (
    /^(?:что (?:уже )?выбрано|что мы (?:уже )?выбрали|на чем (?:мы )?остановились|напомни(?:те)? выбранные данные)$/u.test(
      text,
    )
  )
    return 'summary';
  if (/^(?:стоп|(?:я )?передумал[а]?|пока не надо|останови(?:те)? подготовку)$/u.test(text))
    return 'stop';
  const firstRefusal = /^(.*?)[,;]\s*(?:а\s+|(?:я )?передумал[а]?(?:$|\s))/u.exec(text);
  if (firstRefusal && dialogueControl(firstRefusal[1], currentOperation) === 'stop') return 'stop';
  const afterStop = /^стоп[, ]+(.+)$/u.exec(text);
  if (afterStop && dialogueControl(afterStop[1], currentOperation) === 'stop') return 'stop';
  const refusal = {
    create:
      /^(?:(?:я )?передумал[а]? (?:записывать|записываться)|не хочу (?:записывать|записываться)|не записывай(?:те)?)(?: запись)?$/u,
    move: /^(?:(?:я )?передумал[а]? переносить|не хочу переносить|не переноси(?:те)?)(?: запись)?$/u,
    cancel: /^(?:(?:я )?передумал[а]? отменять|не хочу отменять|не отменяй(?:те)?)(?: запись)?$/u,
    edit: /^(?:(?:я )?передумал[а]? менять|не хочу менять|не меняй(?:те)?)(?: запись)?$/u,
    open: new RegExp(
      '^(?:(?:я )?передумал[а]? открывать|не хочу открывать|не открывай(?:те)?)(?: ' +
        cardNounPattern +
        ')?$',
      'u',
    ),
  }[currentOperation];
  const refusalText = text.replace(/^нет[, ]+/u, '');
  if (refusal?.test(refusalText)) return 'stop';
  const action = {
    create: 'записывай',
    move: 'переноси',
    cancel: 'отменяй',
    edit: 'меняй',
    open: 'открывай',
  }[currentOperation];
  const infinitive = {
    create: 'записывать',
    move: 'переносить',
    cancel: 'отменять',
    edit: 'менять',
    open: 'открывать',
  }[currentOperation];
  const object =
    '(?:(?:(?:эту|ту|выбранную) )?(?:запись|' +
    cardNounPattern +
    ')|(?:(?:этот|тот|выбранный) )?при[её]м)';
  if (
    action &&
    new RegExp(
      '^(?:не ' +
        action +
        '(?:те)?(?: ' +
        object +
        ')?|не (?:надо|нужно) ' +
        infinitive +
        '(?: ' +
        object +
        ')?)$',
      'u',
    ).test(refusalText)
  )
    return 'stop';
  if (action && new RegExp('^' + object + ' оставь(?:те)?(?: как есть)?$', 'u').test(refusalText))
    return 'stop';
  if (
    action &&
    new RegExp(
      '^(?:(?:эту|ту|выбранную) (?:запись|' +
        cardNounPattern +
        ')|(?:этот|тот|выбранный) при[её]м) не ' +
        action +
        '(?:те)?$',
      'u',
    ).test(refusalText)
  )
    return 'stop';
  if (
    (currentOperation === 'open' || currentOperation === 'edit') &&
    new RegExp(
      '^(?:не открывай(?:те)? (?:эту )?(?:' +
        cardNounPattern +
        '|запись)|(?:эту )?(?:' +
        cardNounPattern +
        '|запись) не открывай(?:те)?)$',
      'u',
    ).test(refusalText)
  )
    return 'stop';
  return null;
}
const short = (value, limit) => {
  const text = String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…' : text;
};
function dateLabel(value, clock) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match && months[Number(match[2]) - 1]
    ? Number(match[3]) +
        ' ' +
        months[Number(match[2]) - 1] +
        (match[1] === clock?.date?.slice(0, 4) ? '' : ' ' + match[1] + ' года')
    : value;
}
function informationResponse(base, operation, clock, maxReplyChars = 600) {
  const limit = Math.max(100, Math.min(1000, Math.floor(Number(maxReplyChars) || 600)));
  const reply = structuredClone(base);
  delete reply.speechPermit;
  reply.action = null;
  if (!reply.dialogue) return reply;
  if (operation === 'choices' && ['cancelConfirmation', 'closedDay'].includes(base.dialogue.phase))
    operation = 'question';
  const question = short(
    base.dialogue.prompt,
    operation === 'question' ? limit : Math.min(180, Math.floor(limit / 2)),
  );
  let details = [];
  if (operation === 'choices') {
    const options = Array.isArray(base.dialogue.options) ? base.dialogue.options : [];
    const names = options.map((row) =>
      String(row.label || '')
        .replace(/\s*·\s*…\d{4}$/u, '')
        .trim(),
    );
    details = options
      .slice(0, 3)
      .map((row, index) => {
        const name = names[index],
          suffix = /·\s*…(\d{4})$/u.exec(String(row.label || ''));
        const duplicate = names.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.toLowerCase().replace(/ё/gu, 'е') === name.toLowerCase().replace(/ё/gu, 'е'),
        );
        return suffix && duplicate ? short(name, 65) + ', телефон ' + suffix[1] : short(name, 90);
      })
      .filter(Boolean);
    if (!details.length) details.push('Вариантов для выбора сейчас нет.');
    else if (options.length > 3) details.push('Остальные — на экране.');
  } else if (operation === 'summary') {
    const allowed = new Set(['client', 'staff', 'service', 'date', 'time', 'duration']);
    const seen = new Set();
    for (const field of (base.dialogue.fields || []).slice(0, 8)) {
      if (!allowed.has(field.key) || seen.has(field.key) || !field.value) continue;
      seen.add(field.key);
      const value = String(field.value).replace(/\s*·\s*…\d{4}$/u, '');
      details.push(
        short(field.label, 24) +
          ': ' +
          short(field.key === 'date' ? dateLabel(value, clock) : value, 85),
      );
    }
    if (!details.length) details.push('Данные пока не выбраны.');
  }
  const parts = [];
  for (const detail of details) {
    const candidate = [...parts, detail, question].filter(Boolean).join(' ');
    if (candidate.length > limit) break;
    parts.push(/[.!?…]$/u.test(detail) ? detail : detail + '.');
  }
  if (!parts.length && operation !== 'question' && details.length)
    parts.push(
      operation === 'choices' ? 'Варианты показаны на экране.' : 'Выбранные данные — на экране.',
    );
  const prompt = short([...parts, question].filter(Boolean).join(' '), limit);
  reply.text = prompt;
  reply.dialogue.prompt = prompt;
  reply.dialogue.information = true;
  return reply;
}
function draftOperation(entry) {
  return (
    entry.data.management?.operation ||
    {
      prepareAppointment: 'create',
      moveAppointment: 'move',
      cancelAppointment: 'cancel',
      editAppointment: 'edit',
      clientCard: 'open',
    }[entry.data.initialIntent?.intent] ||
    ''
  );
}
module.exports = { dialogueControl, informationResponse, draftOperation };
