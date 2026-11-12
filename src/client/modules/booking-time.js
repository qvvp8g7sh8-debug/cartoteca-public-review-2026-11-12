function createBookingTime(state, actions) {
  async function openBookingTime(host, record, patientId, live, accepted) {
    const esc = actions.esc,
      panel = document.createElement('div');
    panel.className = 'booking-time-editor';
    panel.innerHTML = [
      '<label class="field">Дата записи',
      `<input type="date" data-request-date value="${esc(record.date)}"></label>`,
      '<div class="booking-time-options"><div class="booking-time-heading"><span>Свободное время</span>',
      '<button type="button" class="secondary" data-request-time-refresh>Обновить время</button></div>',
      '<div class="booking-hour-picker" data-request-hour-picker hidden><span class="booking-picker-label">Час</span>',
      '<div class="booking-hour-grid" data-request-hours role="group" aria-label="Доступные часы"></div></div>',
      '<div class="booking-minute-picker" data-request-minute-picker hidden><span class="booking-picker-label" data-request-minute-label>Время начала</span>',
      '<div class="booking-time-grid" data-request-times role="group" aria-label="Свободное время начала"></div></div>',
      '<p data-request-time-message role="status" aria-live="polite"></p></div>',
      '<p class="muted">Выберите время, согласованное с клиентом. Подтверждение создаст запись в календаре.</p>',
      '<div class="booking-request-actions"><button type="button" class="primary" data-request-time-save disabled>Подтвердить запись</button><button type="button" class="secondary" data-request-time-close>Закрыть</button></div>',
    ].join('');
    host.querySelector('.booking-time-editor')?.remove();
    host.append(panel);
    let sequence = 0,
      busy = false,
      stale = false,
      pending = null,
      times = [],
      selected = '',
      loadedDate = '',
      loadingDate = '',
      hour = '';
    const current = () => live() && panel.isConnected;
    const date = panel.querySelector('[data-request-date]'),
      grid = panel.querySelector('[data-request-times]'),
      hours = panel.querySelector('[data-request-hours]'),
      hourPicker = panel.querySelector('[data-request-hour-picker]'),
      minutePicker = panel.querySelector('[data-request-minute-picker]'),
      minuteLabel = panel.querySelector('[data-request-minute-label]'),
      refresh = panel.querySelector('[data-request-time-refresh]'),
      save = panel.querySelector('[data-request-time-save]'),
      message = panel.querySelector('[data-request-time-message]');
    function renderTimes() {
      const availableHours = [...new Set(times.map((value) => value.slice(0, 2)))];
      hourPicker.hidden = !availableHours.length;
      minutePicker.hidden = !hour;
      hours.innerHTML = availableHours
        .map(
          (value) =>
            `<button type="button" class="secondary" data-request-hour="${esc(value)}" aria-pressed="${value === hour}" aria-label="Выбрать час ${esc(value)}" ${busy || pending || stale || loadingDate ? 'disabled' : ''}>${esc(value)} ч</button>`,
        )
        .join('');
      minuteLabel.textContent = hour
        ? 'Время начала · ' + hour + ':00–' + hour + ':59'
        : 'Время начала';
      grid.innerHTML = times
        .filter((value) => value.slice(0, 2) === hour)
        .map(
          (value) =>
            `<button type="button" class="secondary" data-request-time="${esc(value)}" aria-pressed="${value === selected}" ${busy || pending || stale || loadingDate ? 'disabled' : ''}>${esc(value)}</button>`,
        )
        .join('');
      save.disabled =
        busy ||
        Boolean(loadingDate) ||
        (!pending && (stale || !selected || loadedDate !== date.value));
    }
    async function load(force = false) {
      const requestedDate = date.value;
      if (busy || pending || stale || !current()) return;
      if (
        requestedDate &&
        (requestedDate === loadingDate || (!force && requestedDate === loadedDate))
      )
        return;
      const id = ++sequence;
      loadedDate = '';
      loadingDate = requestedDate;
      times = [];
      selected = '';
      hour = '';
      renderTimes();
      if (!requestedDate || !date.validity.valid) {
        loadingDate = '';
        grid.setAttribute('aria-busy', 'false');
        refresh.disabled = true;
        message.textContent = 'Выберите дату, чтобы увидеть свободное время.';
        return;
      }
      grid.setAttribute('aria-busy', 'true');
      refresh.disabled = true;
      message.textContent = 'Загрузка свободного времени…';
      try {
        const result = await actions.request('/api/online-booking/requests/time-options', {
          method: 'POST',
          body: JSON.stringify({ id: record.id, date: requestedDate }),
        });
        if (!current() || id !== sequence || date.value !== requestedDate) return;
        times = result.times;
        const preferred = selected.slice(0, 2) || record.time.slice(0, 2);
        hour = times.some((value) => value.slice(0, 2) === preferred)
          ? preferred
          : times[0]?.slice(0, 2) || '';
        loadedDate = requestedDate;
        refresh.textContent = 'Обновить время';
        message.textContent = times.length ? '' : 'В этот день нет подходящего свободного времени.';
      } catch (error) {
        if (current() && id === sequence && date.value === requestedDate) {
          refresh.textContent = 'Повторить загрузку';
          message.textContent = error.message;
        }
      } finally {
        if (current() && id === sequence) {
          loadingDate = '';
          grid.setAttribute('aria-busy', 'false');
          refresh.disabled = busy || stale || Boolean(pending) || !date.value;
          renderTimes();
        }
      }
    }
    const dateChanged = () => {
      // Safari may delay change until blur. Do not clear a selected time again
      // after the input event has already loaded this exact date.
      if (!pending) void load();
    };
    date.addEventListener('input', dateChanged);
    date.addEventListener('change', dateChanged);
    host.addEventListener('booking-request-stale', () => {
      if (!current()) return;
      stale = true;
      panel.querySelectorAll('button,input').forEach((el) => {
        if (!el.hasAttribute('data-request-time-close')) el.disabled = true;
      });
      // An unknown acceptance result may only replay its frozen command, not create a new one.
      save.disabled = busy || !pending;
    });
    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button || busy || !current()) return;
      if (button.hasAttribute('data-request-time-close')) {
        panel.remove();
        host.dispatchEvent(new window.CustomEvent('booking-time-closed', { bubbles: true }));
        return;
      }
      if (stale && !pending) return;
      if (button === refresh && !pending) {
        await load(true);
        return;
      }
      if (pending && button !== save) return;
      if (button.dataset.requestHour) {
        hour = button.dataset.requestHour;
        if (selected.slice(0, 2) !== hour) selected = '';
        renderTimes();
        return;
      }
      if (button.dataset.requestTime) {
        selected = button.dataset.requestTime;
        renderTimes();
        return;
      }
      if (!button.hasAttribute('data-request-time-save')) return;
      if (!pending && (!date.value || !selected || loadingDate || loadedDate !== date.value)) {
        message.textContent = 'Выберите дату и время.';
        return;
      }
      pending ||= {
        id: record.id,
        revision: record.revision,
        date: date.value,
        time: selected,
        ...(patientId ? { patientId } : {}),
      };
      busy = true;
      state.busy = true;
      panel.querySelectorAll('button,input').forEach((el) => {
        el.disabled = true;
      });
      message.textContent = 'Создание записи…';
      try {
        const result = await actions.request('/api/online-booking/requests/accept', {
          method: 'POST',
          body: JSON.stringify(pending),
        });
        if (current()) accepted(result);
      } catch (error) {
        if (current()) {
          message.textContent = error.message;
          if (error.status >= 400 && error.status < 500) pending = null;
        }
      } finally {
        busy = false;
        state.busy = false;
        if (current()) {
          panel.querySelectorAll('button,input').forEach((el) => {
            el.disabled = Boolean(
              (pending || stale) &&
              (el.tagName === 'INPUT' ||
                el.dataset.requestTime ||
                el.dataset.requestHour ||
                el === refresh),
            );
          });
          renderTimes();
        }
      }
    });
    await load();
  }
  return { openBookingTime };
}
