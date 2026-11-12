const { createHash } = require('node:crypto');
const { startsAt } = require('../../../shared/time-zone-instant.cjs');
const day = 86400000;
const dayFormats = new Map();
const stamp = (value) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
const date = (value) => new Date(value).toISOString().slice(0, 10);
function calendarText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
function fold(line) {
  const result = [];
  let part = '';
  for (const char of line) {
    if (Buffer.byteLength(part + char) > 75) {
      result.push(part);
      part = ' ';
    }
    part += char;
  }
  result.push(part);
  return result.join('\r\n');
}
function feedWindow(now, zone) {
  let format = dayFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (dayFormats.size >= 64) dayFormats.delete(dayFormats.keys().next().value);
    dayFormats.set(zone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const today = Date.parse(parts.year + '-' + parts.month + '-' + parts.day + 'T00:00:00Z');
  return { from: date(today - 7 * day), to: date(today + 30 * day) };
}
function calendarFeed({ current, storage, platform, now = Date.now(), zone, period }) {
  zone ||= platform.organizationTimeZone(current.organizationId);
  period ||= feedWindow(now, zone);
  const events = new Map();
  const admin = current.role === 'salon_admin';
  const specialists = admin ? current.specialists : [{ id: current.accountId }];
  const staff = new Map(specialists.map((specialist) => [specialist.id, specialist.displayName]));
  const summary = (title, staffId) => (admin ? title + ' — ' + staff.get(staffId) : title);
  // 7 past + today + 30 future days fit the existing 45-day indexed reader.
  for (const specialist of specialists) {
    const snapshot = storage.calendarSnapshot(period.from, period.to, {
      staffId: specialist.id,
      projection: 'subscription',
    });
    for (const event of snapshot.appointments)
      if (event.staffId === specialist.id && !['cancelled', 'no_show'].includes(event.status))
        events.set('appointment:' + event.id, {
          event,
          title: summary(
            typeof event.patientName === 'string' && event.patientName.trim()
              ? event.patientName.trim() + ' — приём'
              : 'Приём',
            event.staffId,
          ),
        });
  }
  const personal = platform.personalEvents.view(
    admin ? current : { ...current, role: 'cosmetologist' },
    period.from,
    period.to,
    { projection: 'occupancy' },
  );
  for (const event of personal.personalEvents)
    if (staff.has(event.staffId))
      events.set('personal:' + event.id, {
        event,
        title: summary('Личная занятость', event.staffId),
      });
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cartoteca//Staff Calendar//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Картотека',
    'REFRESH-INTERVAL;VALUE=DURATION:PT10M',
    'X-PUBLISHED-TTL:PT10M',
  ];
  for (const [key, { event, title }] of [...events].sort(([a], [b]) => a.localeCompare(b))) {
    const start = startsAt(event, zone);
    const duration = Number(event.duration || 60);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || !(duration > 0)) continue;
    const uid = createHash('sha256')
      .update(JSON.stringify([current.organizationId, key]))
      .digest('hex');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}@cartoteca`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(start + duration * 60000)}`,
      `SUMMARY:${calendarText(title)}`,
      `DESCRIPTION:Длительность: ${duration} мин.`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'CLASS:PRIVATE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
module.exports = { calendarFeed, feedWindow, calendarText, fold };
