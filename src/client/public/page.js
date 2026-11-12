function createPublicBookingPage(root, createView, request = publicBookingRequest) {
  const view = createView(root),
    params = new URLSearchParams(location.search),
    flow = createPublicBookingFlow(root);
  bindPublicBookingPhone(root);
  const link = /^\/b\/([a-z0-9]{8})$/.exec(location.pathname)?.[1];
  let org = link ? '' : params.get('organization'),
    info,
    selected = [],
    staffId = '',
    staffRules = null,
    date = '',
    time = '',
    kind = 'reserve',
    availability = { slots: [], requestedTimes: [] },
    loadedMonth = '',
    loadingMonth = '',
    sequence = 0,
    pending = null,
    pendingUnknown = false,
    pendingRenewed = false,
    pendingStopped = false,
    pendingPostStarted = false,
    pendingNeedsProof = false,
    pendingPhoneBlocked = false,
    cooldownUntil = 0,
    cooldownTimer = null,
    currentRead = null,
    pausedRead = '',
    busy = false,
    completed = false;
  const endpoint = (name) =>
    '/api/public-booking/' + name + '?organization=' + encodeURIComponent(org || '');
  const payload = () => ({ date, serviceIds: [...selected], staffId });
  function pauseSubmission(error) {
    const supplied = Number(error.retryAfterSeconds),
      seconds =
        Number.isFinite(supplied) && supplied > 0
          ? Math.min(3600, Math.max(1, Math.ceil(supplied)))
          : 60;
    cooldownUntil = Date.now() + seconds * 1000;
    if (!pendingUnknown) pendingNeedsProof = true;
    clearTimeout(cooldownTimer);
    view.lock(true, true, { retryAfterSeconds: seconds });
    view.status(
      (pendingUnknown
        ? 'Подтверждение не получено. '
        : !pendingPostStarted
          ? 'Заявка не отправлена. '
          : '') +
        `Данные сохранены. ${error.message} Повторная отправка доступна через ${seconds} сек.`,
    );
    cooldownTimer = setTimeout(() => {
      cooldownUntil = 0;
      cooldownTimer = null;
      if (!pending || completed) return;
      view.lock(true, true);
      view.status(
        pendingUnknown
          ? 'Подтверждение не получено. Данные сохранены. Повторите отправку, чтобы уточнить результат.'
          : 'Данные сохранены. Можно повторить отправку.',
      );
    }, seconds * 1000);
  }
  function applyRules(value) {
    const member = info?.members.find((item) => item.id === staffId);
    staffRules =
      value === null || !member
        ? null
        : value || {
            mode: info.mode || 'any',
            bookingMode: info.bookingMode || 'approval',
            minimumLeadMinutes: info.minimumLeadMinutes,
            reservationMinutes: info.reservationMinutes,
            ...member.rules,
          };
    if (member && value) member.rules = value;
    view.rules(staffRules);
  }
  function cancelRead() {
    currentRead?.controller.abort();
    currentRead = null;
  }
  function readSelection(kind, url, options = {}) {
    const key = url + '\n' + (options.body || '');
    if (currentRead?.key === key) return currentRead.promise;
    cancelRead();
    const task = { kind, key, controller: new AbortController(), promise: null };
    currentRead = task;
    task.promise = Promise.resolve()
      .then(() => {
        task.controller.signal.throwIfAborted();
        return request(url, { ...options, signal: task.controller.signal });
      })
      .finally(() => {
        if (currentRead === task) currentRead = null;
      });
    return task.promise;
  }
  function resetTime() {
    time = '';
    kind = 'reserve';
    availability = { slots: [], requestedTimes: [] };
    view.times(availability);
    view.$('#booking-time-area').hidden = true;
    flow.sync(selected, staffId, time);
  }
  async function loadDates() {
    const id = ++sequence,
      month = view.$('#booking-month').value;
    loadingMonth = month;
    loadedMonth = '';
    date = '';
    resetTime();
    applyRules();
    view.dates([], '');
    if (!staffId || !selected.length || !/^\d{4}-\d{2}$/.test(month)) {
      cancelRead();
      loadingMonth = '';
      return;
    }
    view.status('Загрузка рабочих дней…');
    try {
      const result = await readSelection(
        'dates',
        endpoint('dates') +
          '&month=' +
          encodeURIComponent(month) +
          '&staffId=' +
          encodeURIComponent(staffId),
      );
      if (id !== sequence || completed) return;
      loadedMonth = month;
      view.dates(result.dates, '');
      view.status('');
    } catch (error) {
      if (id === sequence) view.status(error.message);
    } finally {
      if (id === sequence) loadingMonth = '';
    }
  }
  async function loadTimes(selectedDate, scrollToTimes = false) {
    const id = ++sequence;
    date = selectedDate;
    resetTime();
    const area = view.$('#booking-time-area'),
      refresh = view.$('#booking-times-refresh');
    area.hidden = false;
    view.$('#booking-selected-date').textContent = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      weekday: 'long',
      timeZone: 'UTC',
    }).format(new Date(date + 'T12:00:00Z'));
    area.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    view.$('#booking-times').textContent = 'Загрузка свободного времени…';
    root
      .querySelectorAll('[data-booking-date]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bookingDate === date)));
    view.status('Проверяем доступное время…');
    try {
      const result = await readSelection('times', endpoint('availability'), {
        method: 'POST',
        body: JSON.stringify(payload()),
      });
      if (id !== sequence || completed) return;
      availability = result;
      const unavailableStaff =
        Array.isArray(result.members) && !result.members.some((member) => member.id === staffId);
      if (unavailableStaff) {
        applyRules(null);
        availability = { slots: [], requestedTimes: [] };
      } else applyRules(result.rules);
      if (staffRules?.bookingMode === 'classic') availability.requestedTimes = [];
      view.times(availability);
      refresh.textContent = 'Обновить время';
      view.status(
        unavailableStaff
          ? 'Онлайн-запись к этому специалисту сейчас недоступна. Выберите другого специалиста.'
          : '',
      );
      if (scrollToTimes) {
        window.requestAnimationFrame(() => {
          if (id !== sequence || completed || flow.closed() || area.hidden) return;
          if (!area.getClientRects().length) return;
          const heading = view.$('#booking-time-heading'),
            bounds = heading.getBoundingClientRect(),
            firstTime = view.$('#booking-times').firstElementChild?.getBoundingClientRect(),
            viewportHeight = window.visualViewport?.height || window.innerHeight;
          if (
            bounds.top >= 0 &&
            bounds.bottom <= viewportHeight &&
            firstTime &&
            firstTime.top >= 0 &&
            firstTime.bottom <= viewportHeight
          )
            return;
          area.scrollIntoView?.({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : 'smooth',
          });
        });
      }
    } catch (error) {
      if (id === sequence && !completed) {
        view.$('#booking-times').textContent = 'Не удалось загрузить время. Повторите загрузку.';
        refresh.textContent = 'Повторить загрузку';
        view.status(error.message);
      }
    } finally {
      if (id === sequence && !completed) {
        area.setAttribute('aria-busy', 'false');
        refresh.disabled = false;
      }
    }
  }
  function selectTime(value, mode) {
    time = value;
    kind = mode;
    view.times(availability, time, kind);
    flow.sync(selected, staffId, time);
    if (!time) return;
    const member = info.members.find((m) => m.id === staffId);
    const services = info.services.filter((s) => selected.includes(s.id)),
      names = services.map((s) => s.name).join(', '),
      duration = services.reduce((sum, s) => sum + Number(s.duration), 0),
      start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
      end = start + duration,
      endLabel =
        String(end <= 1440 ? Math.floor(end / 60) : Math.floor((end % 1440) / 60)).padStart(
          2,
          '0',
        ) +
        ':' +
        String(end % 60).padStart(2, '0') +
        (end > 1440 ? ' следующего дня' : ''),
      amount =
        info.showPrices !== false && services.every((s) => s.price != null)
          ? '\nИтого: ' +
            services.reduce((sum, s) => sum + Number(s.price), 0).toLocaleString('ru-RU') +
            ' ₽'
          : '';
    view.$('#booking-summary').textContent =
      `${date.split('-').reverse().join('.')} · ${time}–${endLabel} (${duration} мин)\n${member?.name || ''}\n${names}${amount}`;
    view.status(
      mode === 'other-time'
        ? 'Запрос другого времени не резервирует время. Организация свяжется с вами для согласования.'
        : staffRules?.bookingMode === 'classic'
          ? 'После успешной отправки выбранное время будет закреплено за вами. Подтверждение появится на сайте.'
          : `После отправки заявки время резервируется на ${staffRules?.reservationMinutes ?? info.reservationMinutes} мин. Запись станет окончательной после принятия организацией.`,
    );
  }
  async function chooseServices() {
    const members = info.members.filter(
      (m) =>
        selected.length &&
        selected.every((id) => info.services.find((s) => s.id === id)?.staffIds.includes(m.id)),
    );
    if (selected.length && !members.some((m) => m.id === staffId))
      staffId = members.length === 1 ? members[0].id : '';
    view.staff(info.members, staffId);
    applyRules();
    flow.sync(selected, staffId, time);
    view.catalog(info, selected, view.$('#booking-service-search').value, staffId);
    if (selected.length && !members.length)
      view.status('Нет специалиста, который оказывает все выбранные услуги. Измените выбор.');
    await loadDates();
  }
  function monthChanged() {
    const month = view.$('#booking-month').value;
    // iOS can emit change only on blur, after input has already loaded this month.
    if (month !== loadedMonth && month !== loadingMonth) void loadDates();
  }
  root.addEventListener('input', (event) => {
    if (!info || busy || pending || completed || flow.closed()) return;
    if (event.target.id === 'booking-service-search' && info && !busy && !pending && !completed)
      view.catalog(info, selected, event.target.value, staffId);
    if (event.target.id === 'booking-month') monthChanged();
  });
  root.addEventListener('change', async (event) => {
    if (!info || busy || pending || completed || flow.closed()) return;
    const target = event.target;
    if (target.matches('[data-booking-service]')) {
      const id = target.dataset.bookingService;
      if (
        target.checked &&
        !info.members.some((member) =>
          [...selected, id].every((serviceId) =>
            info.services.find((service) => service.id === serviceId)?.staffIds.includes(member.id),
          ),
        )
      ) {
        target.checked = false;
        view.status('Для смены сотрудника сначала снимите выбор услуг другого сотрудника.');
        return;
      }
      if (target.checked && selected.length >= 10) {
        target.checked = false;
        view.status('Выберите не более 10 услуг.');
        return;
      }
      selected = target.checked ? [...selected, id] : selected.filter((s) => s !== id);
      await chooseServices();
    } else if (target.id === 'booking-staff') {
      staffId = info.members.some((member) => member.id === target.value) ? target.value : '';
      selected = selected.filter(
        (id) =>
          !staffId ||
          info.services.find((service) => service.id === id)?.staffIds.includes(staffId),
      );
      await chooseServices();
    } else if (target.id === 'booking-month') monthChanged();
  });
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (
      button.hasAttribute('data-booking-close') ||
      button.hasAttribute('data-booking-result-close')
    ) {
      flow.close();
      return;
    }
    if (button.hasAttribute('data-booking-change-phone')) {
      if (!pendingPhoneBlocked || busy || completed || flow.closed()) return;
      view.phonePending(false);
      pendingPhoneBlocked = false;
      pending = null;
      pendingUnknown = false;
      pendingRenewed = false;
      pendingStopped = false;
      pendingPostStarted = false;
      pendingNeedsProof = false;
      view.lock(false);
      flow.show(3);
      const phone = view.$('#booking-contact-form').elements.phone;
      phone.focus();
      phone.select();
      return;
    }
    if (button.hasAttribute('data-booking-retry') && !busy && !pending && !completed) {
      button.disabled = true;
      await initialize();
      return;
    }
    if (!info || busy || pending || completed || flow.closed()) return;
    if (button.dataset.bookingBack || button.dataset.bookingNext) {
      const next = Number(button.dataset.bookingBack || button.dataset.bookingNext);
      if ((next === 2 && (!selected.length || !staffId)) || (next === 3 && !time)) return;
      flow.show(next, true);
      return;
    }
    if (button.dataset.bookingEdit) {
      flow.show(button.dataset.bookingEdit === 'services' ? 1 : 2, true);
      view.status('');
      return;
    }
    if (button.dataset.bookingDate) await loadTimes(button.dataset.bookingDate, true);
    else if (button.id === 'booking-times-refresh' && date) await loadTimes(date);
    else if (button.dataset.bookingTime) selectTime(button.dataset.bookingTime, 'reserve');
    else if (button.dataset.bookingRequestedTime) {
      if (staffRules?.bookingMode !== 'classic')
        selectTime(button.dataset.bookingRequestedTime, 'other-time');
    } else if (button.id === 'booking-other-time') {
      if (staffRules?.bookingMode !== 'classic')
        selectTime('', kind === 'other-time' ? 'reserve' : 'other-time');
    } else if (button.dataset.bookingPeriod) {
      view.timePeriod(button.dataset.bookingPeriod);
      view.times(availability, time, kind);
      view.$(`[data-booking-period="${button.dataset.bookingPeriod}"]`)?.focus();
    } else if (button.id === 'booking-times-more') {
      view.moreTimes();
      view.times(availability, time, kind);
    } else if (button.dataset.bookingMonthShift) {
      const input = view.$('#booking-month');
      const [year, month] = input.value.split('-').map(Number);
      const next = new Date(
        Date.UTC(year, month - 1 + Number(button.dataset.bookingMonthShift), 1),
      );
      input.value = next.toISOString().slice(0, 7);
      await loadDates();
    }
  });
  root.addEventListener('submit', async (event) => {
    if (event.target.id !== 'booking-contact-form') return;
    event.preventDefault();
    if (Date.now() < cooldownUntil) return;
    if (busy || completed || pendingStopped || pendingPhoneBlocked || !info || flow.closed())
      return;
    if (!pending) {
      if (!time || !staffId || !selected.length || !staffRules) {
        view.status('Выберите услуги, специалиста и время.');
        return;
      }
      const fields = new FormData(event.target);
      if (fields.get('consent') !== 'on') {
        view.status('Дайте согласие на обработку персональных данных.');
        return;
      }
      pending = {
        key: info.challenge,
        bookingMode: staffRules.bookingMode,
        ...payload(),
        time,
        kind,
        firstName: fields.get('firstName'),
        lastName: fields.get('lastName'),
        middleName: fields.get('middleName'),
        phone: fields.get('phone'),
        comment: fields.get('comment'),
        consent: fields.get('consent') === 'on',
        privacyConsentVersion: info.privacyConsentVersion,
      };
      pendingUnknown = false;
      pendingRenewed = false;
      pendingPostStarted = false;
      pendingNeedsProof = false;
    }
    busy = true;
    sequence++;
    cancelRead();
    view.lock(true);
    view.status(pending.bookingMode === 'classic' ? 'Создаём запись…' : 'Отправляем заявку…');
    try {
      if (!pendingPostStarted || pendingUnknown || pendingNeedsProof) {
        let fresh;
        try {
          fresh = await request(link ? '/api/public-booking/info?link=' + link : endpoint('info'));
        } catch (error) {
          if (error.status === 429) throw error;
          if (!pendingUnknown) throw error;
          view.lock(true, true);
          view.status('Подтверждение не получено. Данные сохранены.');
          return;
        }
        if (!fresh.challenge || fresh.health?.available === false) {
          if (pendingUnknown) {
            view.lock(true, true);
            view.status('Подтверждение не получено. Данные сохранены.');
            return;
          }
          pendingStopped = true;
          view.lock(true);
          view.status(
            'Заявка не отправлена: онлайн-запись сейчас недоступна. Свяжитесь с организацией.',
          );
          return;
        }
        // This explicit submit prepares proof for the current connection. Even
        // after unknown delivery, the business snapshot and original key stay frozen.
        pending.challenge = fresh.challenge;
        pendingNeedsProof = false;
      }
      pendingPostStarted = true;
      const result = await request(endpoint('requests'), {
        method: 'POST',
        body: JSON.stringify(pending),
      });
      completed = true;
      view.success(info, result, pending);
      view.exitAvailable(flow.canExit());
      pending = null;
    } catch (error) {
      if (error.status === 429) {
        pauseSubmission(error);
        return;
      }
      if (!pendingPostStarted) {
        view.lock(true, true);
        view.status(
          'Заявка не отправлена. Данные сохранены. Не удалось подготовить отправку: ' +
            error.message,
        );
        return;
      }
      if (error.status === 400 && error.code === 'BOOKING_CHALLENGE_REJECTED' && !pendingUnknown) {
        if (pendingRenewed) {
          pendingStopped = true;
          view.lock(true);
          view.status(
            'Не удалось подтвердить форму после обновления. Откройте ссылку записи заново.',
          );
          return;
        }
        pendingRenewed = true;
        try {
          const fresh = await request(
            link ? '/api/public-booking/info?link=' + link : endpoint('info'),
          );
          if (!fresh.challenge || fresh.health?.available === false) {
            view.status('Онлайн-запись сейчас недоступна. Свяжитесь с организацией.');
            return;
          }
          // Only an explicit pre-commit rejection permits renewal. Keep the
          // draft/key frozen and require another user action to send it.
          pending.challenge = fresh.challenge;
          view.lock(true, true);
          view.status('Форма обновлена. Данные сохранены. Повторите отправку.');
        } catch (refreshError) {
          if (refreshError.status === 429) {
            pauseSubmission(refreshError);
            return;
          }
          view.lock(true, true);
          view.status(refreshError.message);
        }
        return;
      }
      if (error.status === 409 && error.code === 'BOOKING_PHONE_PENDING' && !pendingUnknown) {
        pendingPhoneBlocked = true;
        view.lock(false);
        view.status('');
        view.phonePending(true);
        return;
      }
      // Unknown delivery keeps the exact payload/key frozen. Never create a
      // second request automatically after a timeout or ambiguous server error.
      if (error.status && error.status < 500 && !pendingUnknown) {
        pending = null;
        view.lock(false);
        flow.sync(selected, staffId, time);
        if (
          error.status === 409 &&
          ['BOOKING_SLOT_UNAVAILABLE', 'BOOKING_CONDITIONS_CHANGED'].includes(error.code)
        )
          await refreshSelection();
      } else {
        pendingUnknown = true;
        view.lock(true, true);
        view.status(
          'Подтверждение не получено. Данные сохранены. Повторите отправку, чтобы уточнить результат.',
        );
        return;
      }
      view.status(error.message);
    } finally {
      busy = false;
    }
  });
  async function refreshSelection() {
    const id = ++sequence;
    resetTime();
    try {
      const fresh = await readSelection(
        'info',
        link ? '/api/public-booking/info?link=' + link : endpoint('info'),
      );
      if (id !== sequence || completed || flow.closed()) return;
      if (fresh.health?.available === false) return;
      info = {
        ...fresh,
        challenge: info.challenge,
        privacyConsentVersion: info.privacyConsentVersion,
      };
      if (!info.members.some((member) => member.id === staffId)) staffId = '';
      selected = selected.filter((id) =>
        info.services.some(
          (service) => service.id === id && (!staffId || service.staffIds.includes(staffId)),
        ),
      );
      view.staff(info.members, staffId);
      view.catalog(info, selected, view.$('#booking-service-search').value, staffId);
      applyRules();
      await loadDates();
      flow.show(selected.length && staffId ? 2 : 1, true);
    } catch {
      // Keep contact fields in the existing form. A failed read never retries a write.
    }
  }
  async function initialize() {
    if (busy || pending || completed) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    try {
      info = await request(link ? '/api/public-booking/info?link=' + link : endpoint('info'));
      if (link) {
        org = info.organization?.organizationId;
        if (typeof org !== 'string' || !org) throw Error('Не удалось открыть онлайн-запись.');
      }
      if (info.health?.available === false) {
        view.unavailable(info.organization, info.health.reason);
        view.exitAvailable(flow.canExit());
        return;
      }
      const hinted = link ? info.selectedStaffId : params.get('staff');
      staffId = info.members.some((m) => m.id === hinted)
        ? hinted
        : info.members.length === 1
          ? info.members[0].id
          : '';
      view.mount(info);
      view.exitAvailable(flow.canExit());
      view.staff(info.members, staffId);
      applyRules();
      view.catalog(info, selected, '', staffId);
      flow.show(1);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: info.organization.timeZone,
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      view.$('#booking-month').value =
        info.health?.nextDate?.slice(0, 7) ||
        parts.find((p) => p.type === 'year').value +
          '-' +
          parts.find((p) => p.type === 'month').value;
      if (!info.services.length)
        view.status('Онлайн-услуги пока не настроены. Свяжитесь с организацией.');
    } catch (error) {
      view.unavailable(
        info?.organization,
        'unavailable',
        !error.status || error.status >= 500 || error.status === 429,
      );
      view.exitAvailable(flow.canExit());
    } finally {
      busy = false;
      root.setAttribute('aria-busy', 'false');
    }
  }
  window.addEventListener('pagehide', () => {
    if (!currentRead) return;
    pausedRead = currentRead.kind;
    sequence++;
    loadingMonth = '';
    cancelRead();
  });
  // Only an explicit browser Back (BFCache) restores the draft, never the exit UI.
  window.addEventListener('pageshow', async (event) => {
    if (!event.persisted || !flow.closed()) return;
    flow.resume();
    if (pendingPhoneBlocked) {
      view.phonePending(true);
      return;
    }
    const resumeRead = pausedRead;
    pausedRead = '';
    if (!busy && !pending && !completed) {
      if (resumeRead === 'dates') await loadDates();
      else if (resumeRead === 'times' && date) await loadTimes(date);
    }
  });
  return { initialize };
}
async function publicBookingRequest(url, options = {}) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
    });
    const result = await response.json();
    const retryAfter = response.headers.get('Retry-After'),
      retrySeconds = retryAfter?.trim()
        ? /^\d+$/.test(retryAfter.trim())
          ? Number(retryAfter)
          : (Date.parse(retryAfter) - Date.now()) / 1000
        : NaN;
    if (!response.ok)
      throw Object.assign(Error(result.error || 'Не удалось выполнить запрос.'), {
        status: response.status,
        code: result.code,
        retryAfterSeconds:
          Number.isFinite(retrySeconds) && retrySeconds > 0
            ? Math.min(3600, Math.ceil(retrySeconds))
            : 60,
      });
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.name === 'AbortError')
      throw Error('Ответ не получен. Проверьте соединение и повторите действие.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
