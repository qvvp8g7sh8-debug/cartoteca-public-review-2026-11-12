function createBookingRequests(state, actions) {
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  let active = null;
  function bookingRequestsVisible() {
    return Boolean(active?.live());
  }
  async function refreshBookingRequests(summary) {
    if (!bookingRequestsVisible()) return;
    return active.refresh(summary);
  }
  async function openBookingRequestTarget(id) {
    if (typeof id !== 'string' || !id || id.length > 120 || !active?.live()) return false;
    return active.target(id);
  }
  function mountBookingRequests(settings = null) {
    const root = actions.$('#booking-requests-panel');
    if (!root) return;
    const key = scope();
    const candidates = new Map();
    const proposalLinks = new Map();
    let items = [],
      cursor = null,
      busy = false,
      loaded = false,
      sequence = 0,
      loading = null,
      version = null;
    const live = () => root.isConnected && key === scope() && state.currentView === 'services';
    const content = root.querySelector('[data-booking-request-content]');
    const message = root.querySelector('[data-booking-request-message]');
    function render() {
      if (!live()) return;
      actions.reconcileBookingRequests(
        content,
        actions.bookingRequestsHtml(items, settings, candidates, proposalLinks, cursor),
      );
      actions.expireBookingRequestEditors(root, items);
    }
    function processed(record, action) {
      if (!live()) return;
      items = items.filter((r) => r.id !== record.id);
      candidates.delete(record.id);
      proposalLinks.delete(record.id);
      version = null;
      [...content.querySelectorAll('[data-booking-request-row]')]
        .find((row) => row.dataset.bookingRequestRow === record.id)
        ?.remove();
      if (action === 'accept') {
        actions.invalidateCalendarRead();
        actions.invalidateDirectory();
      }
      render();
      message.textContent =
        action === 'accept'
          ? 'Заявка принята. Запись добавлена в календарь.'
          : 'Заявка отклонена и удалена из списка.';
      void actions.refreshBookingInbox({ force: true });
    }
    function load(more = false, background = false, summary = null) {
      if (loading) return loading;
      if (busy || state.busy || !live()) return Promise.resolve();
      const task = performLoad(more, background, summary).finally(() => {
        if (loading === task) loading = null;
      });
      loading = task;
      return task;
    }
    async function performLoad(more, background, summary) {
      const id = ++sequence;
      root.setAttribute('aria-busy', 'true');
      if (!background) message.textContent = 'Загрузка…';
      try {
        if (!settings || (summary && summary.settingsRevision !== settings.revision)) {
          const result = await actions.readBackground('/api/online-booking/settings');
          if (!live() || id !== sequence) return;
          settings = result;
        }
        const page = await actions.readBookingRequestWindow(items, more, cursor, live);
        if (!live() || id !== sequence) return;
        items = page.items;
        cursor = page.cursor;
        version = page.version;
        loaded = true;
        render();
        if (!background) message.textContent = '';
      } catch (error) {
        if (live() && !background) message.textContent = error.message;
        throw error;
      } finally {
        if (live() && id === sequence) root.setAttribute('aria-busy', 'false');
      }
    }
    const manualLoad = (more = false) => load(more).catch(() => {});
    active = {
      live,
      async target(id) {
        await load();
        if (!live() || busy || state.busy) return false;
        const result = await actions.request(
          '/api/online-booking/requests/item?' + new URLSearchParams({ id }),
        );
        if (!live() || busy || state.busy || result.item?.id !== id) return false;
        items = [result.item, ...items.filter((item) => item.id !== id)];
        render();
        const row = [...content.querySelectorAll('[data-booking-request-row]')].find(
          (item) => item.dataset.bookingRequestRow === id,
        );
        if (row) {
          row.tabIndex = -1;
          row.scrollIntoView?.({ block: 'center' });
          row.focus({ preventScroll: true });
        }
        return Boolean(row);
      },
      async refresh(summary) {
        if (!live()) return;
        if (loading) await loading;
        if (!live() || busy || state.busy) return;
        if (
          !loaded ||
          version !== summary.version ||
          settings.revision !== summary.settingsRevision
        )
          await load(false, true, summary);
        else render();
      },
    };
    root.addEventListener('booking-time-closed', render);
    root.addEventListener('toggle', () => {
      if (root.open && !loaded) void manualLoad();
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button || !root.contains(button) || busy || state.busy || !live()) return;
      if (button.matches('[data-booking-request-more]')) return void manualLoad(true);
      const action = button.dataset.bookingRequestAction;
      if (!['accept', 'reject', 'choose'].includes(action)) return;
      if (loading || button.closest('[data-booking-request-stale]')) return;
      const record = items.find((r) => r.id === button.dataset.requestId);
      if (!record) return;
      if (action === 'reject' && !window.confirm('Отклонить заявку? Резерв времени будет снят.'))
        return;
      busy = true;
      state.busy = true;
      root.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
      message.textContent = 'Сохранение…';
      try {
        let patientId;
        if (action === 'accept' || action === 'choose') {
          const select = [...root.querySelectorAll('[data-booking-contact]')].find(
            (s) => s.dataset.bookingContact === record.id,
          );
          if (select) {
            if (!select.value) throw Error('Выберите карточку клиента из совпадений.');
            patientId = select.value;
          } else {
            const contacts = await actions.request(
              '/api/online-booking/requests/contacts?id=' + encodeURIComponent(record.id),
            );
            if (!live()) return;
            if (contacts.needsAdministrator)
              throw Error('Для выбора карточки клиента необходимо участие администратора.');
            if (contacts.items.length > 1) {
              candidates.set(record.id, contacts.items);
              render();
              message.textContent =
                'Найдено несколько карточек с этим номером. Выберите нужную и повторите принятие.';
              return;
            }
          }
        }
        if (action === 'choose') {
          message.textContent = '';
          void actions.openBookingTime(
            button.closest('article'),
            record,
            patientId,
            live,
            (result) => processed(result, 'accept'),
          );
          return;
        }
        const updated = await actions.request('/api/online-booking/requests/' + action, {
          method: 'POST',
          body: JSON.stringify({
            id: record.id,
            revision: record.revision,
            ...(action === 'accept' ? { date: record.date, time: record.time } : {}),
            ...(patientId ? { patientId } : {}),
          }),
        });
        if (!live()) return;
        processed(updated, action);
      } catch (error) {
        // Never report success on an unknown result: refresh/retry is safe using
        // the server's durable acceptance marker and the same request ID.
        if (live()) message.textContent = error.message;
      } finally {
        busy = false;
        state.busy = false;
        if (live())
          root.querySelectorAll('button').forEach((b) => {
            if (!b.closest('.booking-time-editor') && !b.closest('[data-booking-request-stale]'))
              b.disabled = false;
          });
      }
    });
    if (root.tagName !== 'DETAILS') void manualLoad();
    actions.renderBookingInbox();
    void actions.refreshBookingInbox({ force: true });
  }
  return {
    mountBookingRequests,
    bookingRequestsVisible,
    refreshBookingRequests,
    openBookingRequestTarget,
  };
}
