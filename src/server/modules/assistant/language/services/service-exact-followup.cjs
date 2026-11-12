const { readSteps } = require('./../../read-steps.cjs');
const { appointmentContext } = require('../../actions/availability-context.cjs');
const { resolveFieldAnswer } = require('../../dialogue/field-answer.cjs');
const { serviceMatches, serviceWords } = require('./service-matching.cjs');
const {
  servicePartialIdentityMatches,
  serviceDescriptionMatches,
} = require('./service-partial-search.cjs');
const { isAffirmativeAnswer } = require('../../dialogue/affirmative-answer.cjs');
const unsafe = /(?:^|[\s,;])(?:не|нет|или|либо|если|наверное|кроме|исключая)(?=$|[\s,;.!?])/iu;
const reserved =
  /^(?:отмена|отмени(?:ть)?(?:\s+подготовку(?:\s+записи)?)?|стоп|не надо|назад|вернись|шаг назад)$/iu;
function exactServiceAnswer(services, value) {
  const query = String(value || '').trim();
  if (!query || query.length > 160 || unsafe.test(query)) return { query, matches: [] };
  return resolveFieldAnswer('service', query, (text) => {
    const complete = services.filter(
      (service) =>
        serviceWords(service.name).length === serviceWords(text).length &&
        serviceMatches(service.name, text),
    );
    // Complete titles win. A shortened brand/code still requires every spoken
    // word to match tokens from this fresh catalog.
    // A complete nonnumeric description may omit an acronym, but no other word.
    // Missing product codes may remain ambiguous; conflicting codes never match.
    return {
      matches: complete.length
        ? complete
        : services.length <= 200
          ? services.filter(
              (service) =>
                servicePartialIdentityMatches(service.name, text) ||
                serviceDescriptionMatches(service.name, text),
            )
          : [],
    };
  });
}
const exactServiceFollowup = readSteps(function* exactServiceFollowup(c, entry, value) {
  if (
    !c ||
    entry?.step !== 'service' ||
    !entry.data?.staff ||
    typeof value !== 'string' ||
    value.length > 160 ||
    reserved.test(value.trim().replace(/[.!?…]+$/u, ''))
  )
    return null;
  if (isAffirmativeAnswer(value)) {
    const offered = [...(entry.options || [])].filter(
      ([, choice]) =>
        choice.kind === 'service' && choice.value !== null && choice.confirmService === true,
    );
    return offered.length === 1 ? { kind: 'choice', choice: offered[0][0] } : null;
  }
  if (entry.data.servicePicker?.categoryId) return null;
  const context = yield appointmentContext(c);
  const services = context.services.filter((service) => service.staffId === entry.data.staff.id);
  const exact = exactServiceAnswer(services, value);
  // Even duplicate complete names stay local, but only a unique fresh match can be selected.
  return exact.matches.length ? { kind: 'text', text: exact.query } : null;
});
module.exports = { exactServiceAnswer, exactServiceFollowup };
