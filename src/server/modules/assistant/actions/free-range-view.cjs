const MAX_RANGES = 3;
const rangeLabel = (range) => 'с ' + range[0] + ' до ' + range[1];
function freeRangeView(
  info,
  { duration, question = 'На какое время?', emptyDay = true, offset = 0 } = {},
) {
  const ranges = info?.freeRanges || [];
  const start = Number.isSafeInteger(offset) && offset >= 0 && offset < ranges.length ? offset : 0;
  const shown = ranges.slice(start, start + MAX_RANGES);
  const hasMore = start + shown.length < ranges.length;
  const prefix = shown.length
    ? (emptyDay && info.empty && start === 0
        ? info.remainingOnly
          ? 'Оставшееся рабочее время свободно: '
          : 'Весь рабочий день свободен: '
        : 'Свободно ') +
      shown.map(rangeLabel).join(', ') +
      '.'
    : 'На эту дату нет свободного промежутка, в который помещается приём на ' + duration + ' мин.';
  return {
    step: 'time',
    phase: 'period',
    prompt:
      prefix +
      (hasMore ? ' Есть и другие промежутки.' : '') +
      (shown.length ? ' ' + question : ' Выберите другую дату или измените длительность.'),
    input: { type: 'text', field: 'time' },
    choices: shown.map((range) => ({
      kind: 'freeRange',
      value: {
        kind: 'range',
        from: range[0],
        to: range[1],
        fromInclusive: true,
        toInclusive: true,
      },
      label: rangeLabel(range),
    })),
    controls: [
      ...(hasMore ? [{ kind: 'moreRanges', label: 'Ещё промежутки' }] : []),
      { kind: 'otherDate', label: 'Другая дата' },
    ],
  };
}
module.exports = { freeRangeView, MAX_RANGES };
