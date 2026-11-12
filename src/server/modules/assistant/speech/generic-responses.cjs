const GENERIC_QUESTIONS = Object.freeze([
  'На какую дату?',
  'На какой день записать?',
  'Во сколько записать?',
  'Какую услугу?',
  'На какую дату подготовить запись?',
  'На какое время подготовить запись?',
  'На какую дату перенести?',
  'На какую дату запись?',
  'Во сколько запись?',
  'Как зовут клиента?',
  'Сколько минут длится приём?',
  'Что нужно сделать?',
  'День не открыт. Записать?',
  'Уточните полное имя или телефон клиента.',
  'Клиент не найден. Уточните имя или телефон.',
  'Не услышал ответ. Повторите.',
  'Повторите дату коротко, например «завтра».',
  'Назовите услугу коротко.',
  'Скажите «да» или «нет», либо назовите полное имя.',
  'Повторите ответ коротко или продолжите текстом.',
]);

// Keys are selected only by the authoritative service-picker branch.
const READY_QUESTIONS = Object.freeze({
  'service.ask': Object.freeze({ prompt: 'Выберите услугу.', spoken: 'Какую услугу?' }),
  'service.category': Object.freeze({
    prompt: 'Выберите категорию или услугу.',
    spoken: 'Выберите категорию или услугу.',
  }),
  'service.exact': Object.freeze({
    prompt: 'Назовите точное название услуги.',
    spoken: 'Назовите точное название услуги.',
  }),
});
function genericSpeechQuestion(reply) {
  const dialogue = reply?.dialogue;
  if (
    !dialogue ||
    dialogue.information === true ||
    dialogue.manualInputRequired === true ||
    dialogue.step !== 'service' ||
    dialogue.phase !== 'serviceChoice' ||
    dialogue.input?.type !== 'text' ||
    dialogue.input.field !== 'service' ||
    !Object.hasOwn(READY_QUESTIONS, dialogue.speechQuestion)
  )
    return null;
  const question = READY_QUESTIONS[dialogue.speechQuestion];
  if (
    dialogue.prompt !== question.prompt ||
    (reply.text && (typeof reply.text !== 'string' || reply.text.trim() !== question.prompt))
  )
    return null;
  return question.spoken;
}
function cacheableGenericSpeech(text) {
  return (
    GENERIC_QUESTIONS.includes(text) ||
    Object.values(READY_QUESTIONS).some((question) => question.spoken === text)
  );
}
module.exports = { GENERIC_QUESTIONS, genericSpeechQuestion, cacheableGenericSpeech };
