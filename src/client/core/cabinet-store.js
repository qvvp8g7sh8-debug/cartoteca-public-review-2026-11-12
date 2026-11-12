function createCabinetStore(state, actions) {
  let baseline = null,
    rollbackState = null,
    partialWrites = false,
    appointmentWrites = false,
    idempotentWrites = false,
    saving = false,
    uncertain = null;
  const accountKey = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const pendingKey = (account) => 'cartoteca-cabinet-operation:' + account;
  function pendingOperation(account) {
    try {
      const raw = globalThis.sessionStorage?.getItem(pendingKey(account));
      if (!raw) return null;
      if (raw.length > 512) throw Error();
      const value = JSON.parse(raw);
      if (
        !value ||
        Object.keys(value).some((key) => !['operationId', 'expires'].includes(key)) ||
        typeof value.operationId !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(value.operationId) ||
        !Number.isSafeInteger(value.expires)
      )
        throw Error();
      return { ...value, account, restored: true, stage: 'check' };
    } catch {
      // A damaged local marker cannot authorize another write or a replay.
      return { account, restored: true, stage: 'review' };
    }
  }
  function rememberOperation(operation) {
    if (!operation.operationId) return;
    try {
      globalThis.sessionStorage?.setItem(
        pendingKey(operation.account),
        JSON.stringify({ operationId: operation.operationId, expires: Date.now() + 86400000 }),
      );
    } catch {
      throw new Error('Не удалось подготовить проверку сохранения. Обновите страницу.');
    }
  }
  function forgetOperation(operation) {
    try {
      if (pendingOperation(operation.account)?.operationId === operation.operationId)
        globalThis.sessionStorage?.removeItem(pendingKey(operation.account));
    } catch {
      // A retained ID is read-only recovery on the next load, never a new write.
    }
  }
  function finishOperation(operation) {
    forgetOperation(operation);
    if (uncertain === operation) uncertain = null;
  }
  function cabinetSaveStatus() {
    return uncertain?.account === accountKey() ? uncertain.stage : null;
  }
  function snapshot() {
    return structuredClone({ patients: state.data, services: state.services });
  }
  function rememberCabinet(cabinet) {
    partialWrites = Boolean(cabinet.partialWrites);
    appointmentWrites = Boolean(cabinet.appointmentWrites);
    idempotentWrites = Boolean(cabinet.idempotentWrites);
    baseline = structuredClone({ patients: cabinet.patients, services: cabinet.services });
    rollbackState = snapshot();
    if (uncertain?.account !== accountKey()) uncertain = pendingOperation(accountKey());
  }
  function rememberLoadedPatient(patient) {
    if (!baseline) return;
    baseline.patients = merge(baseline.patients, [structuredClone(patient)], []);
    rollbackState = snapshot();
  }
  function rollback() {
    if (rollbackState) {
      state.data = structuredClone(rollbackState.patients);
      state.services = structuredClone(rollbackState.services);
    }
  }
  function editableRecord(record) {
    if (!record) return null;
    const copy = structuredClone(record);
    for (const appointment of copy.appointments || [])
      for (const field of [
        'bookingSource',
        'telegramConfirmedAt',
        'manualConfirmedAt',
        'manualConfirmedBy',
        'confirmationKey',
        'notificationConfirmedAt',
        'notificationConfirmedChannel',
        'deliveryReady',
        'deliveryPreference',
        'deliveryRevision',
        'deliveryChannel',
        'deliveryChannels',
        'deliveryStatuses',
        'deliveryStatus',
      ])
        delete appointment[field];
    return copy;
  }
  function diff(before, after) {
    const old = new Map(before.map((value) => [value.id, editableRecord(value)]));
    const next = new Map(after.map((value) => [value.id, editableRecord(value)]));
    return [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
      const prior = old.get(id) || null,
        updated = next.get(id) || null;
      return JSON.stringify(prior) === JSON.stringify(updated)
        ? []
        : [{ id, before: prior, after: updated }];
    });
  }
  function merge(records, changed, removed) {
    const map = new Map(records.map((value) => [value.id, value]));
    for (const id of removed || []) map.delete(id);
    for (const record of changed || []) map.set(record.id, record);
    return [...map.values()];
  }
  function appointmentCommand(body) {
    if (!appointmentWrites || body.services.length || body.patients.length !== 1) return null;
    const { id, before, after } = body.patients[0];
    if (!before || !after) return null;
    const { appointments: oldAppointments = [], ...oldProfile } = before;
    const { appointments: nextAppointments = [], ...nextProfile } = after;
    // Mixed changes (including completing a visit) keep the atomic card command.
    if (JSON.stringify(oldProfile) !== JSON.stringify(nextProfile)) return null;
    const changes = diff(oldAppointments, nextAppointments);
    if (!changes.length || changes.length > 200) return null;
    return { revision: body.revision, patientId: id, changes };
  }
  async function save({ scheduleAcknowledgement = '' } = {}) {
    if (saving) throw new Error('Предыдущее изменение ещё сохраняется. Дождитесь завершения.');
    if (cabinetSaveStatus()) throw new Error('Сначала проверьте результат предыдущего сохранения.');
    saving = true;
    try {
      const draft = snapshot();
      const body =
        partialWrites && baseline
          ? {
              revision: state.revision,
              patients: diff(baseline.patients, draft.patients),
              services: diff(baseline.services, draft.services),
            }
          : { ...draft, revision: state.revision };
      if (partialWrites && !body.patients.length && !body.services.length) return;
      const useChanges =
        partialWrites &&
        Boolean(baseline) &&
        body.patients.length <= 200 &&
        body.services.length <= 200;
      if (state.lazyReads && !useChanges)
        throw new Error(
          'Слишком много изменений за один раз. Сохраняйте не более 200 карточек или услуг.',
        );
      const operationId = idempotentWrites
        ? typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : Date.now().toString(36) +
            '-' +
            Math.random().toString(36).slice(2) +
            '-' +
            Math.random().toString(36).slice(2)
        : null;
      const command = useChanges ? appointmentCommand(body) : null;
      const operation = {
        operationId,
        draft,
        useChanges,
        url: command
          ? '/api/cabinet/appointments'
          : useChanges
            ? '/api/cabinet/changes'
            : '/api/cabinet',
        changes: command ? body : null,
        appointmentCommand: Boolean(command),
        options: {
          ...(scheduleAcknowledgement || operationId || (command && state.lazyReads)
            ? {
                headers: {
                  ...(scheduleAcknowledgement
                    ? { 'X-Cartoteca-Schedule-Ack': scheduleAcknowledgement }
                    : {}),
                  ...(operationId ? { 'X-Cartoteca-Operation': operationId } : {}),
                  ...(command && state.lazyReads
                    ? { 'X-Cartoteca-Appointment-Response': 'delta-v1' }
                    : {}),
                },
              }
            : {}),
          method: command ? 'POST' : useChanges ? 'PATCH' : 'PUT',
          body: JSON.stringify(
            command || (useChanges ? body : { ...draft, revision: state.revision }),
          ),
        },
        before: structuredClone(baseline),
        account: accountKey(),
        stage: 'check',
      };
      await sendOperation(operation);
    } finally {
      saving = false;
    }
  }
  async function sendOperation(operation) {
    let result;
    try {
      rememberOperation(operation);
      result = await actions.request(operation.url, operation.options);
    } catch (error) {
      // A browser may retry a disconnected PATCH internally: its first commit
      // then appears as 409. Reconcile that case like a lost acknowledgement.
      if ((error.outcomeUnknown || error.status === 409) && operation.account === accountKey()) {
        uncertain = operation;
        actions.openSaveRecovery?.();
      } else if (
        operation.account === accountKey() &&
        !error.outcomeUnknown &&
        error.status !== 409
      )
        forgetOperation(operation);
      throw error;
    }
    if (operation.account !== accountKey())
      throw new Error('Аккаунт изменился. Откройте картотеку заново.');
    applySavedCabinet(operation, result);
    finishOperation(operation);
  }
  function assertAppointmentEdit(edit) {
    if (edit.account !== accountKey())
      throw new Error('Аккаунт изменился. Откройте запись заново.');
    const found = state.data
      .find((p) => p.id === edit.patientId)
      ?.appointments.find((a) => a.id === edit.before.id);
    const canonical = (value) =>
      value && typeof value === 'object'
        ? Array.isArray(value)
          ? value.map(canonical)
          : Object.fromEntries(
              Object.keys(value)
                .sort()
                .filter((k) => value[k] !== undefined)
                .map((k) => [k, canonical(value[k])]),
            )
        : value;
    const clean = (value) => editableRecord({ appointments: value ? [value] : [] });
    if (JSON.stringify(canonical(clean(found))) !== JSON.stringify(canonical(clean(edit.before))))
      throw new Error('Эта запись уже изменена. Откройте её заново перед переносом.');
  }
  async function saveAppointmentChange(edit, after, { scheduleAcknowledgement = '' } = {}) {
    if (saving) throw new Error('Предыдущее изменение ещё сохраняется. Дождитесь завершения.');
    if (cabinetSaveStatus()) throw new Error('Сначала проверьте результат предыдущего сохранения.');
    if (
      !appointmentWrites ||
      !idempotentWrites ||
      !state.lazyReads ||
      edit.account !== accountKey()
    )
      throw new Error('Аккаунт изменился. Откройте запись заново.');
    saving = true;
    try {
      const before = editableRecord({ appointments: [edit.before] }).appointments[0];
      const cleanAfter = editableRecord({ appointments: [after] }).appointments[0];
      const body = {
        revision: edit.revision,
        patientId: edit.patientId,
        changes: [{ id: before.id, before, after: cleanAfter }],
      };
      const operationId =
        globalThis.crypto?.randomUUID?.() ||
        Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2) +
          '-' +
          Math.random().toString(36).slice(2);
      await sendOperation({
        operationId,
        useChanges: true,
        appointmentCommand: true,
        pointCommand: true,
        draft: { patients: [], services: [] },
        before: null,
        changes: { patients: [{ id: edit.patientId }], services: [] },
        url: '/api/cabinet/appointments',
        account: accountKey(),
        stage: 'check',
        options: {
          method: 'POST',
          headers: {
            'X-Cartoteca-Operation': operationId,
            'X-Cartoteca-Appointment-Response': 'point-v1',
            ...(scheduleAcknowledgement
              ? { 'X-Cartoteca-Schedule-Ack': scheduleAcknowledgement }
              : {}),
          },
          body: JSON.stringify(body),
        },
      });
    } finally {
      saving = false;
    }
  }
  function applyPointSaved(operation, result) {
    const command = JSON.parse(operation.options.body),
      ids = new Set(command.changes.map((c) => c.id)),
      patientIds = [command.patientId];
    state.revision = result.revision;
    state.calendarRecords = [
      ...(state.calendarRecords || []).filter((a) => !ids.has(a.id)),
      ...(result.patients || []).flatMap((p) =>
        p.appointments
          .filter((a) => ids.has(a.id))
          .map((a) => ({
            ...a,
            patientId: p.id,
            patientName: actions.patientNameParts(p).lastFirst || 'Имя не указано',
          })),
      ),
    ];
    if (state.lazyReads) state.directory = merge(state.directory || [], result.summaries, []);
    actions.invalidatePatientRead(patientIds);
    if (baseline) baseline.patients = baseline.patients.filter((p) => !patientIds.includes(p.id));
    if (rollbackState)
      rollbackState.patients = rollbackState.patients.filter((p) => !patientIds.includes(p.id));
    actions.invalidateCalendarRead();
    if (state.pagedReads) actions.invalidateDirectory();
  }
  function applySavedCabinet(operation, result) {
    if (operation.pointCommand) return applyPointSaved(operation, result);
    const { draft, useChanges, appointmentCommand } = operation;
    const delta = appointmentCommand && state.lazyReads && result.appointmentOnly === true;
    state.revision = result.revision;
    state.data = useChanges
      ? merge(draft.patients, result.patients, result.removedPatientIds)
      : result.patients || draft.patients;
    state.services = useChanges
      ? merge(draft.services, result.services, result.removedServiceIds)
      : result.services || draft.services;
    if (state.lazyReads) {
      state.directory = merge(state.directory, result.summaries, result.removedPatientIds);
      const updated = new Set([
        ...(result.patients || []).map((p) => p.id),
        ...(result.removedPatientIds || []),
      ]);
      state.calendarRecords = [
        ...state.calendarRecords.filter((a) => !updated.has(a.patientId)),
        ...(result.patients || []).flatMap((p) =>
          p.appointments.map((a) => ({
            ...a,
            patientId: p.id,
            patientName: actions.patientNameParts(p).lastFirst || 'Имя не указано',
          })),
        ),
      ];
      actions.invalidateCalendarRead();
      if (state.pagedReads) actions.invalidateDirectory();
    }
    if (delta) actions.invalidatePatientRead(result.patients.map((p) => p.id));
    baseline = snapshot();
    rollbackState = snapshot();
  }
  // A retry uses the original immutable payload, never new patient/visit IDs.
  // Existing conditional PATCH/global PUT revision protection makes a late first
  // commit race with that retry a conflict, not a second clinical operation.
  async function recoverCabinetSave({ retry = false, acceptCurrent = false } = {}) {
    if (saving) throw new Error('Дождитесь окончания проверки.');
    if (!cabinetSaveStatus()) return { status: 'none' };
    const operation = uncertain;
    const current = () => uncertain === operation && operation.account === accountKey();
    saving = true;
    try {
      let knownCommitted = Boolean(operation.committed);
      if (operation.operationId && !acceptCurrent) {
        try {
          const receipt = await actions.request(
            '/api/cabinet/operation?id=' +
              encodeURIComponent(operation.operationId) +
              '&statusOnly=1',
          );
          if (!current()) return { status: 'none' };
          if (receipt.status === 'committed') {
            knownCommitted = true;
            operation.committed = true;
            if (operation.restored) {
              // A late commit may follow initialize's first read. Reload fresh
              // data after confirming this ID; no clinical draft is persisted.
              finishOperation(operation);
              return { status: 'saved', reload: true };
            }
            const replay = receipt.result
              ? receipt
              : await actions.request(
                  '/api/cabinet/operation?id=' + encodeURIComponent(operation.operationId),
                );
            if (!current()) return { status: 'none' };
            if (replay.status === 'committed' && replay.result) {
              applySavedCabinet(operation, replay.result);
              finishOperation(operation);
              return { status: 'saved' };
            }
          }
        } catch (error) {
          if (error.status !== 409) throw error;
          // A real later change requires the existing comparison/review path.
        }
      }
      if (!current()) return { status: 'none' };
      if (operation.restored) {
        if (acceptCurrent) {
          finishOperation(operation);
          return { status: 'review', reload: true };
        }
        operation.stage = 'review';
        return { status: 'review' };
      }
      if (!knownCommitted && retry && operation.stage === 'retry') {
        try {
          const result = await actions.request(operation.url, operation.options);
          if (!current()) return { status: 'none' };
          applySavedCabinet(operation, result);
          finishOperation(operation);
          return { status: 'saved' };
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      if (!current()) return { status: 'none' };
      const payload = operation.changes || JSON.parse(operation.options.body),
        command = operation.appointmentCommand ? JSON.parse(operation.options.body) : null,
        patients = [],
        services = [];
      let revision = 0;
      if (operation.useChanges) {
        for (const change of payload.patients) {
          try {
            const result = await actions.request(
              '/api/cabinet/patient?id=' + encodeURIComponent(change.id),
            );
            patients.push(...result.patients);
            revision = Math.max(revision, result.revision);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
          if (!current()) return { status: 'none' };
        }
        if (payload.services.length) {
          const result = await actions.request('/api/cabinet/bootstrap?paged=1&limit=20');
          services.push(
            ...result.services.filter((s) => payload.services.some((c) => c.id === s.id)),
          );
          revision = Math.max(revision, result.revision);
        }
      } else {
        const result = await actions.request('/api/cabinet');
        patients.push(...result.patients);
        services.push(...result.services);
        revision = result.revision;
      }
      if (!current()) return { status: 'none' };
      const canonical = (value) =>
        value && typeof value === 'object'
          ? Array.isArray(value)
            ? value.map(canonical)
            : Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .filter((key) => value[key] !== undefined)
                  .map((key) => [key, canonical(value[key])]),
              )
          : value;
      const equal = (a, b) =>
        JSON.stringify(canonical(editableRecord(a))) ===
        JSON.stringify(canonical(editableRecord(b)));
      const matches = (version) => {
        if (command) {
          const patient = patients.find((row) => row.id === command.patientId);
          // A missing/inaccessible card is not proof that any appointment command
          // committed. Compare only requested records, matching the server rebase.
          if (!patient) return false;
          const appointments = new Map(patient.appointments.map((row) => [row.id, row]));
          return command.changes.every((change) =>
            equal(
              { appointments: appointments.has(change.id) ? [appointments.get(change.id)] : [] },
              { appointments: change[version] === null ? [] : [change[version]] },
            ),
          );
        }
        return ['patients', 'services'].every((collection) => {
          const found = new Map(
            (collection === 'patients' ? patients : services).map((record) => [record.id, record]),
          );
          if (operation.useChanges)
            return payload[collection].every((change) =>
              equal(found.get(change.id) || null, change[version]),
            );
          const expected =
            version === 'after'
              ? operation.draft[collection]
              : operation.before?.[collection] || [];
          return (
            found.size === expected.length &&
            expected.every((record) => equal(found.get(record.id) || null, record))
          );
        });
      };
      const result = {
        revision,
        patients,
        services,
        removedPatientIds: operation.useChanges
          ? payload.patients.filter((c) => !patients.some((p) => p.id === c.id)).map((c) => c.id)
          : [],
        removedServiceIds: operation.useChanges
          ? payload.services.filter((c) => !services.some((s) => s.id === c.id)).map((c) => c.id)
          : [],
      };
      if (matches('after')) {
        applySavedCabinet(operation, result);
        finishOperation(operation);
        return { status: 'saved' };
      }
      if (!knownCommitted && matches('before')) {
        operation.stage = 'retry';
        return { status: 'retry' };
      }
      // Image normalization or another writer can prevent an exact match. Do not
      // infer success; let the user explicitly load and review authoritative data.
      if (acceptCurrent) {
        applySavedCabinet(operation, result);
        finishOperation(operation);
        return { status: 'review' };
      }
      operation.stage = 'review';
      return { status: 'review' };
    } finally {
      saving = false;
    }
  }
  return {
    snapshot,
    rememberCabinet,
    rememberLoadedPatient,
    rollback,
    save,
    saveAppointmentChange,
    assertAppointmentEdit,
    cabinetSaveStatus,
    recoverCabinetSave,
  };
}
