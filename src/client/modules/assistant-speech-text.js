function createAssistantSpeechText() {
  const months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];
  function date(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return null;
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!year || !days[month - 1] || !day || day > days[month - 1]) return null;
    return day + ' ' + months[month - 1] + ' ' + year + ' года';
  }
  function noun(value, one, few, many) {
    return value % 100 >= 11 && value % 100 <= 14
      ? many
      : value % 10 === 1
        ? one
        : value % 10 >= 2 && value % 10 <= 4
          ? few
          : many;
  }
  function time(value, range = false) {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    if (!match) return null;
    const hour = Number(match[1]),
      minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    const hours = range ? noun(hour, 'часа', 'часов', 'часов') : noun(hour, 'час', 'часа', 'часов');
    const minutes = range
      ? noun(minute, 'минуты', 'минут', 'минут')
      : noun(minute, 'минута', 'минуты', 'минут');
    return hour + ' ' + hours + (minute ? ' ' + minute + ' ' + minutes : '');
  }
  function client(value) {
    const match = /^(.+) · …(\d{4})$/u.exec(value);
    return match ? match[1] + ', телефон оканчивается на ' + match[2] : value;
  }
  function assistantSpokenOption(value, step) {
    const label = String(value || '');
    if (step === 'client') return client(label);
    if (step === 'service') {
      const match = /^(.+) · (\d{1,4}) мин$/u.exec(label),
        duration = match ? Number(match[2]) : 0;
      if (duration >= 5 && duration <= 1440 && duration % 5 === 0)
        return match[1] + ', ' + duration + ' ' + noun(duration, 'минута', 'минуты', 'минут');
      return label;
    }
    if (!['time', 'availability'].includes(step)) return label;
    const slot = /^(\d{4}-\d{2}-\d{2}) · (\d{2}:\d{2})–(\d{2}:\d{2}) · (.+)$/u.exec(label);
    if (!slot) return label;
    const day = date(slot[1]),
      from = time(slot[2], true),
      to = time(slot[3], true);
    if (day && from && to && step === 'time') return 'в ' + time(slot[2]);
    return day && from && to
      ? day + ', с ' + from + ' до ' + to + ', специалист ' + slot[4]
      : label;
  }
  function assistantSpokenField(field) {
    const value = String(field?.value || '').trim();
    return field?.key === 'date'
      ? date(value) || value
      : field?.key === 'time'
        ? time(value) || value
        : field?.key === 'client'
          ? client(value)
          : value;
  }
  return { assistantSpokenOption, assistantSpokenField };
}
