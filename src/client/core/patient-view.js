function createPatientView(state, actions) {
  // A display page is never an editable patient or a SAVE baseline.
  let preview = null,
    pending = null,
    generation = 0,
    bound = false,
    opening = false,
    actionGeneration = 0;
  const scope = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const current = (owned) =>
    owned &&
    owned.account === state.account &&
    owned.scope === scope() &&
    owned.patientId === state.selectedId &&
    owned.localRevision === state.revision;
  function patientView() {
    if (actions.patient()) return null;
    if (!current(preview)) preview = null;
    return preview?.value || null;
  }
  function viewPatient() {
    return actions.patient() || patientView()?.patient;
  }
  function hydrateDisplay(value) {
    const history = value.history.entries,
      upcoming = value.upcoming.entries;
    value.patient = {
      ...value.patient,
      visits: history.filter((entry) => entry.kind === 'visit').map((entry) => entry.record),
      appointments: [
        ...history.filter((entry) => entry.kind === 'appointment').map((entry) => entry.record),
        ...upcoming,
      ],
    };
    return value;
  }
  async function ensurePatientView(id, { force = false } = {}) {
    if (!state.lazyReads || actions.patient()) return actions.ensurePatient(id);
    if (!force && current(preview) && preview.patientId === id) return preview.value.patient;
    if (!force && current(pending) && pending.patientId === id) return pending.task;
    const owned = {
      account: state.account,
      scope: scope(),
      patientId: id,
      localRevision: state.revision,
      generation: ++generation,
      task: null,
    };
    preview = null;
    owned.task = (async () => {
      const result = await actions.request(
        '/api/cabinet/patient?id=' + encodeURIComponent(id) + '&view=card',
      );
      if (!current(owned) || owned.generation !== generation) return;
      // Old prepared stores opt out explicitly. Never turn an ACL/network error
      // into another read, or place this partial DTO into the full-patient cache.
      if (result.viewUnsupported === true) return actions.ensurePatient(id);
      if (
        result.patient?.id !== id ||
        !Array.isArray(result.history?.entries) ||
        !Array.isArray(result.upcoming?.entries)
      )
        throw Error('Не удалось загрузить карточку. Повторите открытие.');
      preview = { ...owned, value: hydrateDisplay(result), pages: new Map() };
      return preview.value.patient;
    })();
    pending = owned;
    try {
      return await owned.task;
    } finally {
      if (pending === owned) pending = null;
    }
  }
  async function loadPatientViewPage(kind) {
    if (!['history', 'upcoming'].includes(kind)) return;
    const value = patientView(),
      owned = preview,
      cursor = value?.[kind]?.nextCursor;
    if (!cursor) return value;
    if (owned.pages.has(kind)) return owned.pages.get(kind);
    const task = (async () => {
      try {
        const page = await actions.request(
          '/api/cabinet/patient/' +
            kind +
            '?id=' +
            encodeURIComponent(owned.patientId) +
            '&cursor=' +
            encodeURIComponent(cursor),
        );
        if (!current(owned) || preview !== owned || actions.patient()) return;
        if (page.revision !== value.revision || !Array.isArray(page.entries))
          throw Object.assign(Error('Карточка изменилась. История обновлена.'), { status: 409 });
        value[kind] = {
          ...value[kind],
          ...page,
          entries: [...value[kind].entries, ...page.entries],
        };
        return hydrateDisplay(value);
      } catch (error) {
        if (!current(owned) || preview !== owned) return;
        if (error.status === 409) {
          await ensurePatientView(owned.patientId, { force: true });
          if (current(preview)) actions.renderDetail();
        }
        throw error;
      }
    })();
    owned.pages.set(kind, task);
    try {
      return await task;
    } finally {
      if (owned.pages.get(kind) === task) owned.pages.delete(kind);
    }
  }
  function bindPatientViewEvents() {
    if (bound) return;
    bound = true;
    window.addEventListener('pagehide', () => actionGeneration++);
    document.addEventListener(
      'click',
      async (event) => {
        const button = event.target.closest(
          '#detail button,#detail input,#detail select,#detail textarea',
        );
        if (!button || !patientView()) return;
        if (
          button.matches(
            '#back,#more-visits,#more-patient-appointments,[data-tab="visits"],[data-tab="profile"],[data-photo],[data-card-appointment]',
          )
        )
          return;
        // Whole-card editing/printing/connection actions keep their original handlers.
        // Appointment inspection owns its separate point read and never enrolls
        // this paged display as a complete patient. Other actions continue
        // after a full authoritative read. Capture precedes every module listener.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (opening || state.busy) return;
        const owned = preview,
          actionId = ++actionGeneration,
          previousBusy = button.getAttribute('aria-busy'),
          status = document.createElement('span');
        opening = true;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = 'Загружаем карточку…';
        button.after(status);
        try {
          const patient = await actions.ensurePatient(owned.patientId);
          if (
            !patient ||
            actionId !== actionGeneration ||
            owned.account !== state.account ||
            owned.scope !== scope() ||
            owned.patientId !== state.selectedId ||
            state.currentView !== 'card' ||
            state.busy ||
            !button.isConnected
          )
            return;
          button.disabled = false;
          button.click();
        } catch (error) {
          if (
            actionId === actionGeneration &&
            owned.account === state.account &&
            owned.scope === scope() &&
            owned.patientId === state.selectedId &&
            state.currentView === 'card'
          )
            actions.toast(error.message);
        } finally {
          opening = false;
          status.remove();
          if (previousBusy === null) button.removeAttribute('aria-busy');
          else button.setAttribute('aria-busy', previousBusy);
          if (button.isConnected) button.disabled = false;
        }
      },
      true,
    );
  }
  async function readPatientTelegramStatus(id) {
    const url = '/api/telegram/patient?patientId=' + encodeURIComponent(id),
      value = patientView(),
      owned = preview;
    if (!value || value.patient.id !== id) return actions.request(url);
    const ids = [...new Set(value.upcoming.entries.map((entry) => entry.id))],
      results = [];
    try {
      for (let offset = 0; offset < Math.max(1, ids.length); offset += 50) {
        const result = await actions.request(
          url +
            '&view=card&revision=' +
            encodeURIComponent(value.revision) +
            '&appointmentIds=' +
            encodeURIComponent(JSON.stringify(ids.slice(offset, offset + 50))),
        );
        if (!current(owned) || preview !== owned || actions.patient()) return null;
        if (result.viewUnsupported === true) {
          await actions.ensurePatient(id);
          if (owned.account !== state.account || owned.scope !== scope() || id !== state.selectedId)
            return null;
          return actions.request(url);
        }
        if (result.revision !== value.revision)
          throw Object.assign(Error('Карточка изменилась. Данные обновлены.'), { status: 409 });
        results.push(result);
      }
      return {
        ...results[0],
        appointments: results.flatMap((result) => result.appointments),
        confirmations: results.flatMap((result) => result.confirmations),
      };
    } catch (error) {
      if (error.status === 409 && current(owned) && preview === owned) {
        await ensurePatientView(id, { force: true });
        if (current(preview)) actions.renderDetail();
      }
      throw error;
    }
  }
  return {
    patientView,
    viewPatient,
    ensurePatientView,
    loadPatientViewPage,
    bindPatientViewEvents,
    readPatientTelegramStatus,
  };
}
