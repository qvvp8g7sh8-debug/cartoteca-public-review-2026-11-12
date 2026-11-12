const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { patientFullName } = require('../../../shared/patient-names.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { editable } = require('../cabinet/changes.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { saveMutation } = require('../cabinet/mutations.cjs');
const { bookingPreview } = require('./preview.cjs');
const { requestView } = require('./request-input.cjs');
const { matchingContacts } = require('./contacts.cjs');
const { validDate } = require('../../../shared/work-schedule.cjs');
const { chooseAcceptanceTime, acceptanceRecord } = require('./request-time.cjs');

const markerKey = (id) => 'booking-accepted:' + id;
const snapshots = (state, ids) =>
  ids.map((id) => {
    const s = state.services.find((s) => s.id === id);
    if (!s) throw fail(409, 'Услуга больше недоступна.');
    return {
      id,
      name: s.name,
      category: s.category || 'other',
      duration: duration(s.duration ?? 60),
      price: s.price,
    };
  });
function reconcileAcceptance(platform, org, record, storage, now) {
  if (!record.acceptance || !storage.get(markerKey(record.id))) return record;
  if (record.status === 'accepted') return record;
  return platform.bookingRequests.finish(org, record.id, record.revision, 'accepted', now);
}
function destination(actor, record, storage, selected) {
  if (record.acceptance) {
    if (selected && selected !== record.acceptance.patientId)
      throw fail(409, 'Принятие заявки уже начато для другой карточки.');
    return record.acceptance.patientId;
  }
  // Read lightweight summaries, not all visit histories. Never reveal foreign
  // cards to an employee, or silently merge an ambiguous telephone match.
  const matches = matchingContacts(storage, record.phone, actor.organizationId);
  if (selected) {
    if (!matches.some((p) => p.id === selected))
      throw fail(409, 'Выберите карточку с совпадающим номером телефона.');
    if (!storage.indexes.summaries(actor, [selected]).length)
      throw fail(403, 'Обратитесь к администратору для выбора карточки клиента.');
    return selected;
  }
  if (matches.length > 1)
    throw fail(409, 'Найдено несколько карточек с этим номером. Выберите нужную карточку.');
  if (!matches.length) return record.patientId;
  if (!storage.indexes.summaries(actor, [matches[0].id]).length)
    throw fail(403, 'Обратитесь к администратору для выбора карточки клиента.');
  return matches[0].id;
}
function assertAvailable(platform, token, storage, record, now) {
  const selection = record.acceptance?.selection;
  if (!selection && record.proposal && record.proposal.state !== 'agreed')
    throw fail(409, 'Сначала дождитесь согласия клиента на предложенное время.');
  if (
    (selection || record.proposal) &&
    (selection?.timeZone || record.proposal.timeZone) !==
      platform.organizationTimeZone(platform.onlineBooking.actor(token).organizationId)
  )
    throw fail(409, 'Часовой пояс изменился. Согласуйте время заново с клиентом.');
  const preview = bookingPreview(
    platform,
    token,
    storage,
    { date: record.date, serviceIds: record.serviceIds, staffId: record.staffId },
    now,
    { excludeRequestId: record.id, mode: 'any', atTime: record.time, roomId: record.roomId },
  );
  if (
    preview.duration !== record.duration ||
    !preview.slots.some((s) => s.time === record.time && s.roomId === record.roomId)
  )
    throw fail(409, 'Время, услуги или кабинет изменились. Согласуйте новую запись с клиентом.');
}
function acceptanceInput(values) {
  if (
    !values ||
    Object.keys(values).some((k) => !['id', 'revision', 'patientId', 'date', 'time'].includes(k)) ||
    typeof values.id !== 'string' ||
    !values.id ||
    values.id.length > 120 ||
    !Number.isSafeInteger(values.revision) ||
    values.revision < 0 ||
    ((values.date !== undefined || values.time !== undefined) &&
      (!validDate(values.date) ||
        typeof values.time !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5][05]$/.test(values.time))) ||
    (values.patientId !== undefined &&
      (typeof values.patientId !== 'string' || !values.patientId || values.patientId.length > 120))
  )
    throw fail(400, 'Некорректное принятие заявки.');
  return values;
}
async function acceptRequest(context, values, now = Date.now()) {
  acceptanceInput(values);
  const { platform, token, current } = context,
    org = current.organizationId,
    storage = context.tenantStore(org);
  let replay;
  const prepared = compoundMutation(platform, storage, org, 'booking', () =>
    storage.transaction(() => {
      context.assertCurrent();
      const actor = platform.onlineBooking.actor(token);
      if (actor.organizationId !== org) throw fail(403, 'Кабинет изменился.');
      let record = platform.bookingRequests.get(org, values.id, now);
      if (!record) throw fail(404, 'Заявка не найдена.');
      platform.onlineBooking.assertRequestPermission(token, record.staffId);
      record = reconcileAcceptance(platform, org, record, storage, now);
      if (record.status === 'accepted') {
        replay = requestView(record);
        return null;
      }
      if (record.revision !== values.revision) throw fail(409, 'Заявка уже изменена.');
      if (!['pending', 'requested', 'expired'].includes(record.status))
        throw fail(409, 'Заявка уже обработана.');
      const selection = chooseAcceptanceTime(platform, token, storage, record, values, now);
      const selectedRecord = selection
        ? acceptanceRecord({ ...record, acceptance: { ...record.acceptance, selection } })
        : record;
      assertAvailable(platform, token, storage, selectedRecord, now);
      const patientId = destination(actor, record, storage, values.patientId);
      return acceptanceRecord(
        platform.bookingRequests.prepareAcceptance(
          org,
          record.id,
          record.revision,
          patientId,
          now,
          selection,
        ),
      );
    }, 'DEFERRED'),
  );
  if (replay) return replay;
  const patientId = prepared.acceptance.patientId;
  try {
    let serviceItems;
    const body = storage.transaction(() => {
      const state = storage.readSelected([patientId], prepared.serviceIds),
        visible = editable(cabinetForUser(current, state)),
        before = visible.patients[0] || null;
      if (state.patients.length && !before) throw fail(403, 'Нет доступа к карточке клиента.');
      if (!before && !prepared.acceptance.newPatient)
        throw fail(409, 'Выбранная карточка удалена. Необходимо отклонить заявку и создать новую.');
      const after = before
        ? structuredClone(before)
        : {
            id: patientId,
            firstName: prepared.firstName,
            lastName: prepared.lastName,
            middleName: prepared.middleName,
            phone: prepared.phone,
            createdBy: current.accountId,
            visits: [],
            appointments: [],
          };
      if (!before) after.name = patientFullName(after);
      serviceItems = snapshots(state, prepared.serviceIds);
      if (
        JSON.stringify(serviceItems.map((s) => [s.id, s.name, s.duration, s.price])) !==
        JSON.stringify(prepared.services.map((s) => [s.id, s.name, duration(s.duration), s.price]))
      )
        throw fail(
          409,
          'Название, длительность или стоимость услуги изменились. Согласуйте новую заявку с клиентом.',
        );
      after.appointments.push({
        id: prepared.appointmentId,
        date: prepared.date,
        time: prepared.time,
        duration: prepared.duration,
        staffId: prepared.staffId,
        roomId: prepared.roomId,
        status: 'scheduled',
        serviceItems,
        service: serviceItems.map((s) => s.name).join(', '),
        notes: prepared.comment || '',
      });
      return {
        revision: state.revision,
        patients: [{ id: patientId, before, after }],
        services: [],
      };
    }, 'DEFERRED');
    // The operation marker stores only true (no client data) and survives edits or
    // deletion. A platform rollback can never recreate the accepted appointment.
    const trustedCommit = {
      acceptance: { id: prepared.id, appointmentId: prepared.appointmentId },
      assert() {
        const latest = platform.bookingRequests.get(org, prepared.id, now);
        platform.onlineBooking.assertRequestPermission(token, prepared.staffId);
        if (
          !latest ||
          latest.revision !== prepared.revision ||
          latest.acceptance?.patientId !== patientId ||
          !['pending', 'requested', 'expired'].includes(latest.status) ||
          storage.get(markerKey(prepared.id))
        )
          throw fail(409, 'Заявка уже обработана. Обновите список.');
        assertAvailable(platform, token, storage, acceptanceRecord(latest), now);
        if (
          JSON.stringify(
            snapshots(storage.readSelected([], prepared.serviceIds), prepared.serviceIds),
          ) !== JSON.stringify(serviceItems)
        )
          throw fail(409, 'Услуги изменены. Обновите заявку перед принятием.');
        // Recheck phone matches after asynchronous preparation: two requests must
        // not concurrently create two cards for the same new contact.
        if (
          destination(
            platform.onlineBooking.actor(token),
            { ...latest, acceptance: undefined },
            storage,
            values.patientId,
          ) !== patientId
        )
          throw fail(409, 'Карточка клиента уже создана. Обновите заявку.');
      },
      written() {
        storage.set(markerKey(prepared.id), true);
      },
      committed() {
        platform.bookingRequests.finish(org, prepared.id, prepared.revision, 'accepted', now);
      },
    };
    // Internal acceptance does not share a caller-supplied clinical mutation ID.
    await saveMutation({ ...context, req: undefined }, body, { partial: true, trustedCommit });
    return requestView(platform.bookingRequests.get(org, prepared.id, now));
  } catch (error) {
    // A failed validation must not pin a request to a now-invalid card. Only
    // cancel an uncommitted intent; commit checks the intent again under lock.
    compoundMutation(platform, storage, org, 'booking', () => {
      if (!storage.get(markerKey(prepared.id)))
        platform.bookingRequests.cancelAcceptance(org, prepared.id, patientId);
    });
    throw error;
  }
}
module.exports = { acceptRequest, reconcileAcceptance };
