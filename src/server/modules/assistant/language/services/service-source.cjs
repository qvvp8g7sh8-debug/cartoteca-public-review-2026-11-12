const { normalizeClockSeparators } = require('../time/temporal.cjs');
// Source proof concerns what was affirmatively requested; it never selects a catalog ID.
function serviceSourceAllowed(request, value) {
  if (
    typeof request !== 'string' ||
    typeof value !== 'string' ||
    !value ||
    request.length > 4096 ||
    value.length > 160
  )
    return false;
  let at = request.indexOf(value),
    count = 0,
    positive = false;
  while (at >= 0) {
    if (++count > 8) return false;
    const prefix = request
      .slice(Math.max(0, at - 120), at)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/gu, 'е');
    const suffix = request
      .slice(at + value.length, at + value.length + 40)
      .normalize('NFKC')
      .toLowerCase();
    const rejected =
      /(?:^|[\s,;(])(?:не(?:\s+(?:хочу|нужно|надо|требуется))?|без|кроме|исключая|или|либо)(?:\s+(?:на|услугу|процедуру))*\s*$/u.test(
        prefix,
      ) || /^\s*(?:или|либо)(?=$|[\s,.!?;])/u.test(suffix);
    if (!rejected) positive = true;
    at = request.indexOf(value, at + value.length);
  }
  return positive;
}
// Adjacent identifiers belong to the same raw service span, never to a model invention.
function expandServiceSource(request, value) {
  if (
    typeof request !== 'string' ||
    typeof value !== 'string' ||
    !value ||
    request.length > 4096 ||
    value.length > 160
  )
    return '';
  const temporalUnit =
    /^(?:числ(?:о|а|у|ом|е)|январ[ьяею]|феврал[ьяею]|март[аеу]?|апрел[ьяею]|ма[йяею]|июн[ьяею]|июл[ьяею]|август[аеу]?|сентябр[ьяею]|октябр[ьяею]|ноябр[ьяею]|декабр[ьяею]|минут(?:а|ы|у|ой)?|мин|час(?:а|ов)?|ч|секунд(?:а|ы|у)?|сек|день|дня|дней|дни|недел(?:я|ю|и|ь)|месяц(?:а|ев)?|год(?:а|у|ов)?|лет|утр(?:о|а|ом)|вечер(?:а|ом)?|ноч(?:ь|и|ью))(?=$|[\s,.!?;])/iu;
  function temporalToken(token) {
    if (
      /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(token) ||
      /^\d{4}-\d{1,2}-\d{1,2}$/u.test(token) ||
      /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/u.test(token)
    )
      return true;
    const unit = /^\d+(.+)$/u.exec(token);
    return Boolean(unit && temporalUnit.test(unit[1]));
  }
  function contextualDashClock(token, at) {
    const match = /^((?:в|на|ко?)?)([01]?\d|2[0-3])[-–—]([0-5]\d)$/iu.exec(token);
    if (!match) return false;
    const before = request.slice(Math.max(0, at - 80), at);
    const after = request.slice(at + token.length, at + token.length + 80);
    const canonical = match[1] + match[2] + ':' + match[3];
    // Reuse the same context proof as the time parser; bare date-like tokens and
    // procedure identifiers must not be silently stripped from a service.
    return (
      normalizeClockSeparators(before + token + after) ===
      normalizeClockSeparators(before + canonical + after)
    );
  }
  const inside = /[\p{L}\p{N}'’ʼ\p{Pd}]/u;
  function adjacent(start, end, before) {
    const slice = before
      ? request.slice(Math.max(0, start - 96), start)
      : request.slice(end, end + 96);
    const match = before
      ? /([^\s;!?()]{1,64})[ \t]+$/u.exec(slice)
      : /^[ \t]+([^\s;!?()]{1,64})/u.exec(slice);
    if (!match) return null;
    const original = match[1],
      token = original.replace(/[.,…]+$/u, '');
    if (!token) return null;
    const at = before ? start - match[0].length : end + match[0].length - original.length;
    const tail = request.slice(at + token.length).trimStart();
    if (
      (before && inside.test(request[at - 1] || '')) ||
      (!before && /[^\s;!?()]/u.test(request[at + original.length] || ''))
    )
      return { reject: true };
    const glued = /^(?:на|в|к|до|после|с)(\d.*)$/iu.exec(token);
    if (
      temporalToken(token) ||
      (glued && temporalToken(glued[1])) ||
      contextualDashClock(token, at)
    )
      return null;
    if (glued && /^\d+$/u.test(glued[1]) && temporalUnit.test(tail)) return null;
    if (!/[0-9]/u.test(token)) return null;
    if (/^[+−-]?\d+(?:[.,]\d+)?$/u.test(token) && temporalUnit.test(tail)) return null;
    const code = /[A-Za-z]/u.test(token) && /^[A-Za-z0-9]+(?:[-−+.,/][A-Za-z0-9]+)*$/u.test(token);
    const numeric = /^[+−-]?\d{1,6}(?:[.,]\d{1,6})?(?:[%‰°])?$/u.test(token);
    if (!code && (!numeric || /^\d+$/u.test(token))) return { reject: true };
    return { start: at, end: at + token.length };
  }
  const candidates = new Map();
  let at = request.indexOf(value),
    occurrences = 0;
  while (at >= 0) {
    if (++occurrences > 8) return '';
    let start = at,
      end = at + value.length,
      rejected = false;
    if (inside.test(request[start - 1] || '') || inside.test(request[end] || '')) {
      at = request.indexOf(value, at + value.length);
      continue;
    }
    for (const before of [true, false]) {
      for (let count = 0; count < 3; count++) {
        const part = adjacent(start, end, before);
        if (!part) break;
        if (part.reject || count === 2) {
          rejected = true;
          break;
        }
        if (before) start = part.start;
        else end = part.end;
      }
      if (rejected) break;
    }
    const expanded = request.slice(start, end);
    if (!rejected && expanded.length <= 160 && serviceSourceAllowed(request, expanded))
      candidates.set(expanded, expanded);
    at = request.indexOf(value, at + value.length);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : '';
}
module.exports = { serviceSourceAllowed, expandServiceSource };
