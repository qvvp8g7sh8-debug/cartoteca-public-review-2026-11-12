const { fold, hints } = require('./example-features.cjs');
const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const { assessmentForCase } = require('./behavior-library-coverage.cjs');
const { appointmentSlotClause } = require('../language/time/appointment-slot-clause.cjs');

// These are retrieval facets, never authorization or executable commands. Entity
// names are deliberately absent: they must not select an unrelated refusal.
const facets = {
  negation: /(?:^|[\s,;])(?:не|ничего не|отмена)(?=$|[\s,.!?;])/u,
  condition: /если|при условии|в случае|что бы произошло/u,
  quotation: /[«"].*(?:запиш|найди|открой)|клиент написал/u,
  capability: /ты умеешь|что ты можешь/u,
  security:
    /игнориру|обойд|без провер|без прав|нет доступа|без доступа|всех организац|другой организац|глобальный администратор|patientid|javascript|fetch\(|"intent"|api\b/u,
  bulk: /все(?:х|м|ми)?\s+(?:мои|моих|клиент|запис|карточ|сотрудник)|массов|перечисли|выгрузи|одновременно/u,
  recurrence: /кажд(?:ый|ую|ое)|по пятниц|все мои пятниц/u,
  range: /с\s+\d.{0,35}\s+по\s+\d|семь дней|рабочую неделю|на выходные|с понедельника по пятницу/u,
  merge: /объедин|дубликат|две карточки/u,
  archive: /архив|восстанови/u,
  consent: /согласие/u,
  clientWrite:
    /созда[йть].{0,25}клиент|добавь клиента|переимен|измени телефон|сотри телефон|удали карточк|добавь.{0,40}заметк/u,
  cardRead:
    /скажи телефон|день рождения|прочитай заметк|сколько должна|последний раз|следующая запись/u,
  message: /отправь.{0,40}сообщен|потом напомни/u,
  context: /(?:^|\s)(?:ее|его)(?=$|[\s,.!?])|выбранн|прошлый раз|последнего клиента|теперь/u,
  ambiguity: /(?:^|\s)или(?:\s|$)|не помню|примерно|около|по телефону/u,
  duration: /минус|двое суток|длительность|продолжительность/u,
  promise:
    /гарантируй|придумай|считай.{0,30}подтвержден|вчера.{0,30}соглас|скажи,? что.{0,50}записан/u,
  schedulingDetails:
    /кто работает|сколько.{0,20}клиентов|следующий клиент|последний прием|кем занято|перерыв|кабинет|пересекаются/u,
};
const safetyFacets = new Set(['security', 'bulk', 'promise']);
function facetsOf(text) {
  const value = fold(text);
  return Object.entries(facets)
    .filter(([, pattern]) => pattern.test(value))
    .filter(
      ([id]) =>
        id !== 'bulk' ||
        !/^(?:покажи|открой)\s+(?:мне\s+)?все\s+(?:мои\s+)?(?:записи|приемы)\s+на\s+(?:сегодня|завтра|послезавтра|следующую неделю|эту неделю|неделю|месяц)[.!?]?$/u.test(
          value,
        ),
    )
    .map(([id]) => id);
}
function taskOf(text) {
  const request = detectRequestedOperation(text);
  const signals = facetsOf(text);
  const value = fold(text);
  const linkedSlot = appointmentSlotClause(value);
  const independentHeads = [
    ...value.matchAll(
      /(?:^|[;,.!?]|\s(?:и|а|затем|потом|после этого)\s)\s*(?:(?:затем|потом|после этого|пожалуйста|мне нужно|я хочу|я бы хотел|я бы хотела|можешь|можете)\s+)*(?:найди|отыщи|поищи|покажи|открой|подготовь|создай|запиши|перенеси|отмени|удали)(?=$|\s)/gu,
    ),
  ].filter((head) => !(linkedSlot && head.index >= linkedSlot.slotStart));
  const multiple =
    request.ambiguous || (!request.sameAppointmentSave && independentHeads.length > 1);
  if (request.negated && !signals.includes('negation')) signals.push('negation');
  if (multiple) signals.push('multiple_operations');
  const boundaryOnly =
    request.negated ||
    multiple ||
    signals.some((id) =>
      ['condition', 'quotation', 'capability', 'security', 'bulk', 'promise'].includes(id),
    );
  const ranked = [...hints(text)].filter(([id]) => id !== 'help').sort((a, b) => b[1] - a[1]);
  const intent = request.intent || (ranked[0]?.[1] >= 0.55 ? ranked[0][0] : null);
  return { intent, boundaryOnly: Boolean(boundaryOnly), facets: signals };
}
function routeForCase(item, expected) {
  const assessment = assessmentForCase(item);
  const route = taskOf(item.text);
  // A precisely reviewed projection can supersede a historical help expectation.
  // Archive/partial-filter exclusions are still enforced by the selector.
  const help = expected.intent === 'help';
  return {
    family: help ? 'boundary' : assessment.family === 'boundary' ? 'action' : assessment.family,
    selectionRole: assessment.selectionRole,
    capabilityId: expected.intent,
    task: route.intent,
    facets: route.facets,
  };
}
function routeRows(rows, text) {
  const route = taskOf(text),
    normalized = fold(text).replace(/\s+/gu, ' ').trim();
  const relevant = rows.filter((row) => {
    // The approved exact custom phrase retains its dated override semantics.
    if (
      row.source === 'custom' &&
      (row.normalizedText ?? fold(row.example.text).replace(/\s+/gu, ' ').trim()) === normalized
    )
      return true;
    const item = row.routing;
    if (!item || item.selectionRole === 'archive' || item.selectionRole === 'continuation')
      return false;
    if (item.family !== 'boundary')
      return !route.boundaryOnly && (!route.intent || row.example.expected.intent === route.intent);
    if ((row.normalizedText ?? fold(row.example.text).replace(/\s+/gu, ' ').trim()) === normalized)
      return true;
    const overlap = item.facets.filter((id) => route.facets.includes(id));
    if (!overlap.length) return false;
    if (route.boundaryOnly) return overlap.some((id) => route.facets.includes(id));
    if (overlap.some((id) => safetyFacets.has(id))) return true;
    return !route.intent || !item.task || item.task === route.intent;
  });
  return {
    rows: relevant.map((row) => ({ ...row, routeBoundary: row.routing?.family === 'boundary' })),
    metadata: {
      version: 2,
      task: route.intent,
      boundaryOnly: route.boundaryOnly,
      facets: route.facets,
      considered: rows.length,
      eligible: relevant.length,
      excluded: rows.length - relevant.length,
    },
  };
}
module.exports = { routeForCase, routeRows, taskOf };
