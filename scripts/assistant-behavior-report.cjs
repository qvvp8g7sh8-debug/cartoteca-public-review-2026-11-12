// Local metadata workflow only. Input comes from stdin; output may be saved by the caller.
// node scripts/assistant-behavior-report.cjs [--human] < synthetic-report.json
const {
  createIncident,
  advanceIncident,
} = require('../src/server/modules/assistant/behavior/behavior-incident.cjs');
const {
  gapDefinitions,
} = require('../src/server/modules/assistant/behavior/behavior-diagnostics-schema.cjs');
const MAX_INPUT_BYTES = 32768;
const stages = {
  reported: 'сообщение зарегистрировано',
  reproduced: 'сценарий воспроизведён',
  diagnosed: 'причина зафиксирована',
  patched: 'исправление подготовлено',
  verified: 'проверки зафиксированы',
};
const layers = {
  server: 'серверная функция',
  context: 'сохранение контекста',
  examples: 'подбор и содержание примеров',
  recognition: 'распознавание речи',
  contract: 'контракт ответа модели',
  data: 'входные данные или справочники',
  provider: 'доступность провайдера',
  limits: 'лимиты',
  audio: 'аудиосеанс',
  transport: 'передача запроса',
  none: 'исправление не определено',
};
function humanReport(record) {
  const cause = record.rootCause ? gapDefinitions[record.rootCause.code] : null;
  const possible = record.gaps.map((code) => gapDefinitions[code][2]);
  const missing = [];
  if (!record.repro) missing.push('синтетическое воспроизведение');
  if (!record.rootCause) missing.push('причина с меткой свидетельства');
  if (!record.patch) missing.push('исправление с меткой версии кода');
  if (!record.verification) missing.push('исходная, соседняя и защитная проверки на этой версии');
  return (
    [
      'Стадия: ' + stages[record.status] + '.',
      cause
        ? 'Подтверждённое в карточке разбора: ' + cause[2] + '.'
        : 'Подтверждённая причина пока не установлена.',
      cause
        ? 'Предположения отделены от зафиксированной причины.'
        : possible.length
          ? 'Признаки для проверки: ' + possible.join('; ') + '. Это ещё не установленная причина.'
          : 'Для предположения о причине данных недостаточно.',
      'Слой исправления: ' + (cause ? layers[cause[1]] : 'пока не выбран') + '.',
      missing.length
        ? 'Не хватает: ' + missing.join('; ') + '.'
        : 'Обязательные метки и три группы проверок приложены.',
      'Инструмент проверяет метаданные; сам тесты не запускает и записи клиентов не меняет.',
    ].join('\n') + '\n'
  );
}
function reportFromInput(text, args = []) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--human') ||
    Buffer.byteLength(text) > MAX_INPUT_BYTES
  )
    throw Error('invalid');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid');
  const names = Object.keys(value);
  let record;
  if (names.length === 1 && names[0] === 'create') record = createIncident(value.create);
  else if (names.length === 2 && names.includes('record') && names.includes('command'))
    record = advanceIncident(value.record, value.command);
  else throw Error('invalid');
  return args[0] === '--human' ? humanReport(record) : JSON.stringify(record) + '\n';
}
async function readInput(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw Error('invalid');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
if (require.main === module) {
  (async () => {
    try {
      process.stdout.write(reportFromInput(await readInput(process.stdin), process.argv.slice(2)));
    } catch {
      process.stderr.write(
        'Не удалось принять диагностический случай. Проверьте JSON, допустимые поля, размер до32КБ и последовательность этапов.\n',
      );
      process.exitCode = 2;
    }
  })();
}
module.exports = { MAX_INPUT_BYTES, reportFromInput };
