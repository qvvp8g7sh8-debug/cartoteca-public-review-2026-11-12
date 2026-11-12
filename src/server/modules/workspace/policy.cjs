const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { roomBlocksOverlap, staffBlocksOverlap, hasOverlapProtection } = require('./overlap.cjs');
const defaults = (ownerId) => ({
  revision: 0,
  enabled: false,
  staffRules: [],
  mode: 'separate',
  roomLayout: 'single',
  rooms: ownerId
    ? [
        {
          id: 'main',
          name: 'Основной кабинет',
          active: true,
          preventOverlap: true,
          staffMode: 'single',
          staffIds: [ownerId],
        },
      ]
    : [],
});
function normalizeSettings(settings) {
  const rooms = settings.rooms.map((room) => ({
    ...room,
    staffMode: room.staffMode || (room.staffIds.length > 1 ? 'multiple' : 'single'),
    preventOverlap: roomBlocksOverlap(settings, room),
  }));
  return {
    ...defaults(),
    ...settings,
    roomLayout:
      settings.roomLayout || (rooms.filter((r) => r.active).length > 1 ? 'multiple' : 'single'),
    rooms,
  };
}
const availableRooms = (settings, staffId) =>
  settings.rooms.filter((r) => r.active && r.staffIds.includes(staffId));
function roomFor(settings, appointment) {
  if (appointment.roomId) return settings.rooms.find((r) => r.id === appointment.roomId) || null;
  const rooms = availableRooms(settings, appointment.staffId);
  return rooms.length === 1 ? rooms[0] : null;
}
const allAppointments = (state) => state.patients.flatMap((p) => p.appointments || []);
function assertSchedule(settings, state, activeStaff, zone, now = Date.now(), legacyOwnerId = '') {
  if (!hasOverlapProtection(settings)) return;
  const entries = allAppointments(state)
    .filter((a) => isActiveAppointment(a))
    .map((a) => ({ a: a.staffId ? a : { ...a, staffId: legacyOwnerId }, start: startsAt(a, zone) }))
    .filter((e) => e.start + (Number(e.a.duration) || 60) * 60000 > now)
    .sort((a, b) => a.start - b.start);
  const staffEnds = new Map(),
    roomEnds = new Map();
  for (const { a, start } of entries) {
    const room = roomFor(settings, a),
      label = `${a.date}, ${a.time}`;
    if (!a.staffId || !activeStaff.has(a.staffId))
      throw fail(409, 'Для будущих записей назначьте действующего специалиста.');
    if (!room || !room.active || !room.staffIds.includes(a.staffId))
      throw fail(
        409,
        'Выберите доступный кабинет для всех будущих записей. Если вариантов несколько, сначала сохраните кабинеты без включения ограничений и уточните записи.',
      );
    if (staffBlocksOverlap(settings, a.staffId) && (staffEnds.get(a.staffId) || 0) > start)
      throw fail(409, `Специалист уже занят в это время (${label}). Укажите другую дату и время.`);
    if (roomBlocksOverlap(settings, room) && (roomEnds.get(room.id) || 0) > start)
      throw fail(
        409,
        `Кабинет занят в это время (${label}). Укажите другую дату и время или другой кабинет.`,
      );
    const end = start + (Number(a.duration) || 60) * 60000;
    staffEnds.set(a.staffId, end);
    roomEnds.set(room.id, end);
  }
}
function validateSettings(values, members, prior, state) {
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some(
      (k) => !['revision', 'enabled', 'mode', 'roomLayout', 'rooms', 'staffRules'].includes(k),
    )
  )
    throw fail(400, 'Некорректные настройки кабинетов.');
  if (!Number.isSafeInteger(values.revision) || values.revision !== prior.revision)
    throw fail(409, 'Настройки изменились. Обновите их перед сохранением.');
  if (
    typeof values.enabled !== 'boolean' ||
    !['separate', 'shared'].includes(values.mode) ||
    !Array.isArray(values.rooms) ||
    values.rooms.length > 50
  )
    throw fail(400, 'Выберите режим и не более 50 кабинетов.');
  const modern = values.roomLayout !== undefined;
  if (modern && !['single', 'multiple'].includes(values.roomLayout))
    throw fail(400, 'Выберите один или несколько кабинетов.');
  const membersById = new Map(members.map((m) => [m.accountId, m])),
    ids = new Set(),
    names = new Set();
  const staffRules = values.staffRules === undefined ? prior.staffRules || [] : values.staffRules;
  if (!Array.isArray(staffRules) || staffRules.length > members.length)
    throw fail(400, 'Проверьте правила записи к сотрудникам.');
  const ruleIds = new Set();
  const validatedStaffRules = staffRules.map((rule) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      Object.keys(rule).some((key) => !['staffId', 'preventOverlap'].includes(key)) ||
      typeof rule.staffId !== 'string' ||
      !membersById.has(rule.staffId) ||
      ruleIds.has(rule.staffId) ||
      typeof rule.preventOverlap !== 'boolean'
    )
      throw fail(400, 'Правило можно задать только сотруднику этой организации, без повторов.');
    ruleIds.add(rule.staffId);
    return { staffId: rule.staffId, preventOverlap: rule.preventOverlap };
  });
  const rooms = values.rooms.map((r) => {
    if (
      !r ||
      typeof r !== 'object' ||
      Array.isArray(r) ||
      Object.keys(r).some(
        (k) => !['id', 'name', 'active', 'staffIds', 'staffMode', 'preventOverlap'].includes(k),
      ) ||
      (r.preventOverlap !== undefined && typeof r.preventOverlap !== 'boolean') ||
      typeof r.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(r.id) ||
      ids.has(r.id) ||
      typeof r.name !== 'string' ||
      !r.name.trim() ||
      r.name.length > 100 ||
      typeof r.active !== 'boolean' ||
      !Array.isArray(r.staffIds) ||
      r.staffIds.length > 100
    )
      throw fail(400, 'Проверьте названия и параметры кабинетов.');
    ids.add(r.id);
    const name = r.name.trim(),
      normalized = name.toLocaleLowerCase('ru');
    if (names.has(normalized)) throw fail(400, 'Названия кабинетов должны отличаться.');
    names.add(normalized);
    const staffIds = [...new Set(r.staffIds)];
    if (staffIds.some((id) => typeof id !== 'string' || !membersById.has(id)))
      throw fail(400, 'Кабинету можно назначить только сотрудников этой организации.');
    const staffMode = r.staffMode || (staffIds.length > 1 ? 'multiple' : 'single');
    if (!['single', 'multiple'].includes(staffMode) || (modern && !r.staffMode))
      throw fail(400, 'Выберите, один или несколько сотрудников принимают в каждом кабинете.');
    if (
      (staffMode === 'single' && staffIds.length > 1) ||
      (!modern && r.active && values.mode === 'separate' && staffIds.length > 1)
    )
      throw fail(
        400,
        'Для нескольких сотрудников выберите «Несколько сотрудников» в настройках кабинета.',
      );
    if (r.active && !staffIds.length)
      throw fail(400, 'Назначьте специалиста каждому действующему кабинету.');
    const previous = prior.rooms.find((room) => room.id === r.id);
    const preventOverlap =
      r.preventOverlap ?? (previous ? roomBlocksOverlap(prior, previous) : true);
    return { id: r.id, name, active: r.active, staffMode, staffIds, preventOverlap };
  });
  if (modern && !rooms.some((r) => r.active))
    throw fail(400, 'Нужно оставить хотя бы один действующий кабинет.');
  if (modern && values.roomLayout === 'single' && rooms.filter((r) => r.active).length !== 1)
    throw fail(
      400,
      'В режиме «Один кабинет» оставьте один действующий кабинет. Остальные можно отключить, сохранив историю.',
    );
  for (const a of allAppointments(state))
    if (a.roomId && !ids.has(a.roomId))
      throw fail(
        409,
        'Кабинет используется в записях. Оставьте его в списке и снимите отметку «Действует».',
      );
  if (values.enabled && !rooms.some((r) => r.active))
    throw fail(400, 'Добавьте хотя бы один действующий кабинет.');
  return {
    revision: prior.revision + 1,
    enabled: values.enabled,
    staffRules: validatedStaffRules,
    mode: modern
      ? rooms.some((r) => r.staffMode === 'multiple')
        ? 'shared'
        : 'separate'
      : values.mode,
    roomLayout: modern
      ? values.roomLayout
      : rooms.filter((r) => r.active).length > 1
        ? 'multiple'
        : 'single',
    rooms,
  };
}
function busyIntervals(settings, state, current, from, to) {
  if (current.role !== 'cosmetologist') return [];
  const rooms = new Set(
      availableRooms(settings, current.accountId)
        .filter((r) => roomBlocksOverlap(settings, r))
        .map((r) => r.id),
    ),
    byRoom = new Map();
  const lower = Date.parse(from + 'T00:00:00Z'),
    upper = Date.parse(to + 'T00:00:00Z') + 86400000;
  for (const a of allAppointments(state)) {
    if (!isActiveAppointment(a) || a.staffId === current.accountId) continue;
    const room = roomFor(settings, a);
    if (!room || !rooms.has(room.id)) continue;
    const start = Date.parse(a.date + 'T' + a.time + ':00Z'),
      end = start + (Number(a.duration) || 60) * 60000;
    if (end <= lower || start >= upper) continue;
    if (!byRoom.has(room.id)) byRoom.set(room.id, []);
    byRoom.get(room.id).push([Math.max(start, lower), Math.min(end, upper)]);
  }
  const result = [];
  for (const [roomId, intervals] of byRoom) {
    const merged = [];
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    for (const [start, end] of merged)
      for (let cursor = start; cursor < end;) {
        const day = new Date(cursor).toISOString().slice(0, 10),
          until = Math.min(end, Date.parse(day + 'T00:00:00Z') + 86400000);
        result.push({
          roomId,
          date: day,
          time: new Date(cursor).toISOString().slice(11, 16),
          duration: (until - cursor) / 60000,
        });
        cursor = until;
      }
  }
  return result.sort((a, b) =>
    (a.date + a.time + a.roomId).localeCompare(b.date + b.time + b.roomId),
  );
}
module.exports = {
  defaults,
  normalizeSettings,
  availableRooms,
  roomFor,
  allAppointments,
  assertSchedule,
  validateSettings,
  busyIntervals,
};
