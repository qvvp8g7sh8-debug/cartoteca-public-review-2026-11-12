function createIntegrations(state, actions) {
  const calendars = [
    {
      id: 'apple',
      name: 'Apple Календарь',
      route: '/api/calendar/subscription',
    },
    {
      id: 'google',
      name: 'Google Календарь',
      route: '/api/calendar/subscription?provider=google',
    },
  ];
  function integrationsSettingsHtml() {
    if (!state.multiUser) return '';
    const available = ['owner', 'cosmetologist', 'salon_admin'].includes(actions.accountRole());
    return actions.settingsSectionHtml(
      'Интеграции',
      'integrations-settings',
      '<div class="integrations-grid">' +
        calendars
          .map(
            (calendar) =>
              `<article id="${calendar.id}-calendar-integration" class="integration-card" aria-label="${calendar.name}">` +
              (available
                ? '<p class="form-hint">Загружаем подключение…</p>'
                : actions.calendarIntegrationHeading(calendar) +
                  '<p class="integration-card-status">Подключение недоступно для этой роли</p>') +
              '</article>',
          )
          .join('') +
        '</div>',
    );
  }
  async function mountIntegrations() {
    if (!['owner', 'cosmetologist', 'salon_admin'].includes(actions.accountRole())) return;
    const account = state.account,
      identity = () =>
        JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]),
      mountedIdentity = identity();
    const mounted = calendars.flatMap((calendar) => {
      const selector = '#' + calendar.id + '-calendar-integration',
        root = actions.$(selector);
      if (!root) return [];
      const current = () =>
        root.isConnected &&
        state.account === account &&
        identity() === mountedIdentity &&
        actions.$(selector) === root;
      return [{ calendar, root, current, updateControls: () => {} }];
    });
    let busy = false;
    function updateControls() {
      for (const mountedCalendar of mounted)
        if (mountedCalendar.current()) mountedCalendar.updateControls();
    }
    await Promise.all(
      mounted.map(async (mountedCalendar) => {
        const { calendar, root, current } = mountedCalendar;
        let connected = false,
          generation = 0,
          helpOpener = null,
          savedSelection = null,
          selectionRevision = '';
        function draftSelection() {
          const mode = root.querySelector('[data-calendar-mode]:checked')?.value || 'all';
          return {
            mode,
            staffIds:
              mode === 'selected'
                ? [...root.querySelectorAll('[data-calendar-staff]:checked')]
                    .map((field) => field.value)
                    .sort()
                : [],
          };
        }
        const selectionKey = (selection) =>
          JSON.stringify([selection.mode, [...selection.staffIds].sort()]);
        const selectionDirty = () =>
          savedSelection && selectionKey(draftSelection()) !== selectionKey(savedSelection);
        mountedCalendar.updateControls = () => {
          const selection = root.querySelector('[data-calendar-selection]'),
            toggle = root.querySelector('[data-calendar-switch]');
          if (toggle) toggle.disabled = busy || Boolean(selectionDirty());
          if (!selection) return;
          const draft = draftSelection(),
            hasStaff = Boolean(selection.querySelector('[data-calendar-staff]')),
            invalid = draft.mode === 'selected' && !draft.staffIds.length,
            dirty = selectionDirty();
          for (const field of selection.querySelectorAll('input'))
            field.disabled = busy || (!hasStaff && field.value === 'selected');
          selection.querySelector('[data-calendar-staff-list]').hidden = draft.mode !== 'selected';
          selection.querySelector('[data-calendar-save]').disabled = busy || !dirty || invalid;
          selection.querySelector('[data-calendar-selection-hint]').textContent = !hasStaff
            ? 'В организации пока нет специалистов. Их расписание появится после добавления.'
            : invalid
              ? 'Выберите хотя бы одного специалиста.'
              : dirty
                ? 'Изменения вступят в силу после сохранения.'
                : '';
        };
        function render(result) {
          connected = Boolean(result.connected);
          savedSelection = result.selection
            ? {
                mode: result.selection.mode,
                staffIds: result.selection.staffIds || [],
              }
            : null;
          selectionRevision = result.selectionRevision || '';
          root.innerHTML = actions.calendarIntegrationHtml(calendar, result);
          updateControls();
        }
        function message(text) {
          const element = root.querySelector('[data-calendar-message]');
          if (current() && element) element.textContent = text;
        }
        async function load() {
          const operation = ++generation;
          try {
            const result = await actions.request(calendar.route);
            if (current() && operation === generation) render(result);
          } catch (error) {
            if (current() && operation === generation) {
              root.replaceChildren();
              root.insertAdjacentHTML('afterbegin', actions.calendarIntegrationHeading(calendar));
              const text = document.createElement('p'),
                retry = document.createElement('button');
              text.className = 'form-hint';
              text.setAttribute('role', 'status');
              text.textContent = error.message;
              retry.type = 'button';
              retry.className = 'secondary';
              retry.textContent = 'Повторить';
              retry.addEventListener('click', () => {
                if (current() && !busy && !state.busy) void load();
              });
              root.append(text, retry);
            }
          }
        }
        async function saveSelection(button) {
          if (!savedSelection || !selectionDirty() || button.disabled || busy || state.busy) return;
          const selection = draftSelection();
          if (selection.mode === 'selected' && !selection.staffIds.length) return;
          const operation = ++generation,
            restoreFocus = document.activeElement === button;
          busy = true;
          updateControls();
          try {
            const result = await actions.request(calendar.route, {
              method: 'PUT',
              body: JSON.stringify({
                selection,
                expectedSelectionRevision: selectionRevision,
              }),
            });
            if (current() && operation === generation) {
              render(result);
              message('Выбор специалистов сохранён.');
            }
          } catch (error) {
            if (current() && operation === generation) {
              await load();
              message(error.message);
            }
          } finally {
            busy = false;
            updateControls();
            const active = document.activeElement;
            if (
              restoreFocus &&
              current() &&
              (active === document.body || active === button || !active?.isConnected)
            ) {
              const next = root.querySelector(
                '[data-calendar-save]:not(:disabled), [data-calendar-mode]:checked',
              );
              next?.focus({ preventScroll: true });
            }
          }
        }
        function reserveGoogleWindow() {
          let popup = null;
          try {
            popup = window.open('about:blank', '_blank');
            if (popup) {
              popup.opener = null;
              const meta = popup.document.createElement('meta');
              meta.name = 'referrer';
              meta.content = 'no-referrer';
              popup.document.head.append(meta);
              popup.document.title = 'Подключение Google Календаря';
              popup.document.body.textContent = 'Открываем Google Календарь…';
            }
            return popup;
          } catch {
            try {
              popup?.close();
            } catch {}
            return null;
          }
        }
        function launch(result, popup) {
          try {
            const target = actions.calendarIntegrationTarget(calendar, result);
            if (!target) throw Error('Subscription unavailable');
            if (calendar.id === 'google') {
              if (!popup || popup.closed) throw Error('Calendar window unavailable');
              popup.location.href = target.url;
            } else if (!window.open(target.url, '_self')) {
              throw Error('Calendar did not open');
            }
            return true;
          } catch {
            message(
              'Подписка включена. Если календарь не открылся, нажмите «?» и повторите переход.',
            );
            return false;
          }
        }
        async function copy(button) {
          const input = root.querySelector('#google-calendar-subscription-url'),
            dialog = input?.closest('dialog');
          if (!input || !dialog?.open) return;
          const currentCopy = () =>
            current() &&
            dialog.open &&
            root.querySelector('#google-calendar-subscription-url') === input;
          button.disabled = true;
          try {
            if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
            await navigator.clipboard.writeText(input.value);
            if (currentCopy())
              message(
                'Ссылка скопирована. При ручном подключении вставьте её в «URL календаря» в Google и нажмите «Добавить календарь».',
              );
          } catch {
            if (currentCopy()) {
              root.querySelector('.integration-manual').open = true;
              input.focus({ preventScroll: true });
              input.select();
              message(
                'Не удалось скопировать автоматически. Ссылка выделена в справке — скопируйте её вручную.',
              );
            }
          } finally {
            if (currentCopy()) button.disabled = false;
          }
        }
        root.addEventListener('click', async (event) => {
          const help = event.target.closest('[data-settings-help]'),
            dialog = root.querySelector('dialog');
          if (help && dialog) {
            event.stopPropagation();
            if (!current()) return;
            helpOpener = help;
            dialog.querySelector('[data-calendar-help-text]').textContent = help.dataset.helpText;
            if (!dialog.open) dialog.showModal();
            return;
          }
          if (!current()) return;
          if (event.target.closest('[data-calendar-help-close]')) {
            dialog?.close();
            return;
          }
          const save = event.target.closest('[data-calendar-save]');
          if (save) {
            await saveSelection(save);
            return;
          }
          const button = event.target.closest('[data-calendar-copy]');
          if (button && !button.disabled && !busy && !state.busy) await copy(button);
        });
        root.addEventListener(
          'close',
          (event) => {
            if (event.target.tagName === 'DIALOG' && current() && helpOpener?.isConnected)
              helpOpener.focus({ preventScroll: true });
          },
          true,
        );
        root.addEventListener('change', async (event) => {
          if (event.target.closest('[data-calendar-selection]')) {
            if (current()) updateControls();
            return;
          }
          const toggle = event.target.closest('[data-calendar-switch]');
          if (!toggle) return;
          const requested = toggle.checked;
          const restoreFocus = document.activeElement === toggle;
          toggle.checked = connected;
          if (!current() || busy || state.busy || selectionDirty() || requested === connected)
            return;
          const operation = ++generation;
          busy = true;
          updateControls();
          // Reserve only Google's browser tab during the user's activation, before the POST.
          const popup = requested && calendar.id === 'google' ? reserveGoogleWindow() : null;
          let launched = false;
          try {
            const result = await actions.request(calendar.route, {
              method: requested ? 'POST' : 'DELETE',
              body: '{}',
            });
            if (current() && operation === generation) {
              render(result);
              if (requested && result.connected) launched = launch(result, popup);
            }
          } catch (error) {
            if (current() && operation === generation) {
              // Reconcile the provider; never duplicate an uncertain mutation or navigate on it.
              await load();
              message(error.message);
            }
          } finally {
            if (popup && !launched) {
              try {
                popup.close();
              } catch {}
            }
            busy = false;
            updateControls();
            const active = document.activeElement;
            if (
              restoreFocus &&
              current() &&
              (active === document.body || active === toggle || !active?.isConnected)
            )
              root.querySelector('[data-calendar-switch]')?.focus({ preventScroll: true });
          }
        });
        await load();
      }),
    );
  }
  return { integrationsSettingsHtml, mountIntegrations };
}
