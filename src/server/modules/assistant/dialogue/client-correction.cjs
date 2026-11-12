// A correction identifies a fresh query, never a patient ID. The caller still
// resolves it through its current candidate scope and normal ambiguity checks.
function isClientCorrectionQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) return false;
  const query = value.trim();
  if (/^[+\d][\d ()-]{3,30}$/u.test(query)) return true;
  if (!/^[\p{L}][\p{L}'’\u2011-]*(?:\s+[\p{L}][\p{L}'’\u2011-]*){0,3}$/u.test(query)) return false;
  return !/(?:^|\s)(?:не|нет|да|или|либо|если|и|а|но|кроме|вместо|на|у|в|к|для|после|до|через|сегодня|завтра|послезавтра|вчера|утром|вечером|днем|ночью|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|поменяй|смени|измени|исправь|замени|запиши|запись|отмени|перенеси|создай|удали|открой|покажи|найди|посмотри|включи|выключи|добавь|выйди|сохрани|запусти|выполни|отправь|оплати|обнови|закрой|закончи|верни|расскажи|переключи|назад|вернись|шаг|подтверждаю|верно|клиент|клиента|услуга|услугу|дата|дату|время|сотрудника|специалиста)(?=$|\s)/iu.test(
    query,
  );
}
function clientCorrectionQuery(raw, { allowBareCorrection = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const text = raw
    .normalize('NFKC')
    .trim()
    .replace(/^пожалуйста[,\s]+/iu, '')
    .replace(/[.!?…]+$/u, '')
    .trim();
  const replacement = /^(?:нет[,\s]+)?не\s+(.+?)[,\s]+а\s+(.+)$/iu.exec(text);
  if (replacement)
    return isClientCorrectionQuery(replacement[1]) && isClientCorrectionQuery(replacement[2])
      ? { query: replacement[2].trim() }
      : null;
  if (/^(?:нет[,\s]+)?друг(?:ой|ого)\s+клиент(?:а)?$/iu.test(text)) return { query: '' };
  const named =
    /^(?:нет[,\s]+)?(?:клиента?\s+(?:поменяй|смени|измени|исправь|замени)(?:\s+на)?|(?:поменяй|смени|измени|исправь|замени)\s+клиента?(?:\s+на)?|клиент(?:а)?(?:\s+на)?)(?:\s+(.+))?$/iu.exec(
      text,
    );
  if (named) {
    const query = (named[1] || '').trim();
    if (/^(?:другой|другого|другая|другую|другое)$/iu.test(query)) return { query: '' };
    return !query || isClientCorrectionQuery(query) ? { query } : null;
  }
  const bare = allowBareCorrection ? /^нет[,\s]+(.+)$/iu.exec(text) : null;
  return bare && isClientCorrectionQuery(bare[1]) ? { query: bare[1].trim() } : null;
}
module.exports = { clientCorrectionQuery, isClientCorrectionQuery };
