function requestText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim();
}
function nearestSlotMode(value) {
  const text = requestText(value);
  if (!text || text.length > 4000 || /(?:^|[\s,;])(?:не|нет|или|либо)(?=$|[\s,;])/u.test(text))
    return null;
  if (
    /(?:^|[\s,;])(?:как можно (?:по)?раньше|первое свободное(?: время| окно)?|самое раннее(?: свободное)?(?: время| окно)?)(?=$|[\s,.!?;])/u.test(
      text,
    )
  )
    return 'earliest';
  return /(?:^|[\s,;])ближайш(?:ее|ие|ий|ую|ие)\s+(?:свободн(?:ое|ые|ый)\s+)?(?:время|окно|окна|окошко)(?=$|[\s,.!?;])/u.test(
    text,
  )
    ? 'nearest'
    : null;
}
function isSlotRequest(value) {
  const text = requestText(value);
  if (
    /^(?:(?:подбери|найди|предложи|покажи)(?:\s+мне)?\s+)?ближайш(?:ее|ие)\s+(?:свободн(?:ое|ые)\s+)?(?:время|окно|окна|окошко)$/u.test(
      text,
    )
  )
    return true;
  if (
    /^(?:(?:подбери|найди|предложи|покажи)(?:\s+мне)?\s+)?(?:как можно (?:по)?раньше|первое свободное(?: время| окно)?|самое раннее(?: свободное)?(?: время| окно)?)$/u.test(
      text,
    )
  )
    return true;
  return /^(?:(?:подбери|найди|предложи|покажи)(?:\s+(?:мне|ближайшее|ближайшие|свободное|свободные|подходящее|подходящие))*(?:\s+(?:время|окна|окно|окошко))?|(?:в\s+)?(?:любое|ближайшее|свободное)\s+(?:время|окно)|когда\s+(?:есть\s+)?свободное\s+время)$/u.test(
    text,
  );
}
module.exports = { isSlotRequest, nearestSlotMode };
