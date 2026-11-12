const { patientNameParts } = require('../../../../shared/patient-names.cjs');
const { normalizeName } = require('../language/names/name-forms.cjs');
const { matchesName, nameTokens } = require('../language/names/name-matching.cjs');

function surnameOnlyMatches(candidates, surname = '') {
  const parts = candidates.map(patientNameParts);
  const knownSurnames = new Set(
    parts.filter((row) => row.first && row.last).map((row) => normalizeName(row.last)),
  );
  return candidates.filter((_, index) => {
    const row = parts[index];
    // A legacy one-word name can be a given name. Use the surname role only
    // when a named client in these same options supplies that exact surname.
    const last = row.structured
      ? !row.first && !row.middle && row.last
      : nameTokens(row.full).length === 1 && knownSurnames.has(normalizeName(row.full)) && row.full;
    return last && (!surname || matchesName({ lastName: last }, surname));
  });
}

function surnameOnlyPrompt(candidates) {
  if (candidates.length < 2) return '';
  const count = surnameOnlyMatches(candidates).length;
  if (count > 1)
    return 'У нескольких клиентов указана только фамилия. Назовите номер варианта или выберите карточку на экране.';
  return count === 1
    ? 'Назовите имя или номер варианта. Для карточки без имени скажите «без имени».'
    : '';
}

function parseSurnameOnlyAnswer(text) {
  const match =
    /^(?:(?:карточк[ау]\s+)?без имени|только фамилия)(?:(?:\s*[:-]\s*|\s+)([\p{L}][\p{L}'-]{1,47}))?$/u.exec(
      text,
    );
  return match ? match[1] || '' : null;
}

module.exports = { parseSurnameOnlyAnswer, surnameOnlyMatches, surnameOnlyPrompt };
