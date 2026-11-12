// Only explicit preservation clauses and acknowledgement of one's own mistake
// are removed from interpretation. Original entity source remains intact.
const labels = {
  клиент: 'client',
  клиента: 'client',
  клиентка: 'client',
  клиентку: 'client',
  пациент: 'client',
  пациента: 'client',
  пациентка: 'client',
  пациентку: 'client',
  сотрудник: 'staff',
  сотрудника: 'staff',
  специалист: 'staff',
  специалиста: 'staff',
  услуга: 'service',
  услугу: 'service',
  процедура: 'service',
  процедуру: 'service',
  дата: 'date',
  дату: 'date',
  день: 'date',
  время: 'time',
  длительность: 'duration',
  продолжительность: 'duration',
};
const label = '(?:' + Object.keys(labels).join('|') + ')';
const list = label + '(?:(?:\\s*,\\s*|\\s+и\\s+|\\s+)' + label + '){0,5}';
const same = '(?:тот|та|то|те|того|той|ту|тех|тому|тем|теми)\\s+же';
const preserve = new RegExp(
  '(?:^|[.,!?;])\\s*(' +
    list +
    ')\\s+(?:менять\\s+не\\s+(?:надо|нужно)|не\\s+меняй(?:те)?|' +
    same +
    '|остав(?:ь|им|ляем|ьте)\\s+(?:прежни(?:ми|м|ей)|как\\s+было|' +
    same +
    '))(?=$|[.,!?;])',
  'giu',
);
const preserveBefore = new RegExp(
  '(?:^|[.,!?;])\\s*(?:не\\s+меняй(?:те)?|остав(?:ь|ьте|им|ляем))\\s+(' +
    list +
    ')(?:\\s+(?:' +
    same +
    '|прежни(?:ми|м|ей)|как\\s+было))?(?=$|[.,!?;])',
  'giu',
);
function continuationSourceScope(raw) {
  const protectedFields = new Set();
  const keep = (whole, names) => {
    for (const name of names.toLowerCase().match(/[а-я]+/gu) || [])
      if (labels[name]) protectedFields.add(labels[name]);
    return ' '.repeat(whole.length);
  };
  let text = String(raw || '')
    .replace(preserve, keep)
    .replace(preserveBefore, keep);
  text = text.replace(
    /^\s*(?:нет[,\s]+)?(?:я\s+)?(?:ошибся|ошиблась|перепутал[а]?)(?:\s+с\s+(?:цифрами|названием|именем|фамилией|датой|временем))?[.!]\s*/iu,
    (whole) => ' '.repeat(whole.length),
  );
  // «Нет, клиент Ольга, дата завтра» is a labelled correction, not a denial
  // of the positive values. Inner negations and all original entity spans stay.
  const positiveLabel =
    /^\s*нет[,\s]+(?=(?:клиент(?:а)?|пациент(?:а)?|сотрудник(?:а)?|специалист(?:а)?|услуг[ау]|процедур[ау]|дат[ау]|день|время|длительность|продолжительность)\s+(?!не(?=$|[\s,])))/iu;
  text = text.replace(positiveLabel, (whole) => ' '.repeat(whole.length));
  return { text, protectedFields };
}
module.exports = { continuationSourceScope };
