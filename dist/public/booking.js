// Generated from src/client/public. Edit source files.
(() => {
// Domestic numbers use +7; an explicit foreign country code is kept intact.
function formatPublicBookingPhone(value) {
  const raw = String(value).trim(),
    digits = raw.replace(/\D/g, '');
  if (!digits) return { value: raw.startsWith('+') ? '+' : '', added: 0 };
  if (raw.startsWith('+') && !digits.startsWith('7')) return { value: '+' + digits, added: 0 };
  const prefix = raw.startsWith('+') || (/^[78]/.test(digits) && digits.length !== 10);
  const national = prefix ? digits.slice(1) : digits;
  const groups = [
    national.slice(0, 3),
    national.slice(3, 6),
    national.slice(6, 8),
    national.slice(8),
  ];
  return {
    value:
      '+7' +
      (groups[0] ? ' ' + groups[0] : '') +
      (groups[1] ? ' ' + groups[1] : '') +
      (groups[2] ? '-' + groups[2] : '') +
      (groups[3] ? '-' + groups[3] : ''),
    added: prefix ? 0 : 1,
  };
}

function bindPublicBookingPhone(root) {
  const isPhone = (target) => target?.matches?.('#booking-contact-form input[name="phone"]');
  function format(event) {
    const input = event.target;
    if (!isPhone(input) || input.disabled || event.isComposing) return;
    const position = input.selectionStart ?? input.value.length;
    const count = input.value.slice(0, position).replace(/\D/g, '').length;
    const formatted = formatPublicBookingPhone(input.value);
    input.value = formatted.value;
    if (root.ownerDocument.activeElement === input) {
      let remaining = count + formatted.added,
        caret = 0;
      while (caret < input.value.length && remaining > 0) {
        if (/\d/.test(input.value[caret])) remaining--;
        caret++;
      }
      input.setSelectionRange(caret, caret);
    }
    const digits = input.value.replace(/\D/g, '');
    const valid = input.value.startsWith('+7') ? digits.length === 11 : /^\d{10,15}$/.test(digits);
    input.setCustomValidity(
      !input.value || valid ? '' : 'Введите номер полностью, например +7 999 123-45-67.',
    );
  }
  root.addEventListener('input', format);
  root.addEventListener('change', format); // Autofill may emit change rather than input.
  root.addEventListener('beforeinput', (event) => {
    const input = event.target;
    if (!isPhone(input) || input.disabled || input.selectionStart !== input.selectionEnd) return;
    const backward = event.inputType === 'deleteContentBackward';
    if (!backward && event.inputType !== 'deleteContentForward') return;
    const caret = input.selectionStart;
    const adjacent = backward ? caret - 1 : caret;
    if (adjacent < 0 || adjacent >= input.value.length || /\d/.test(input.value[adjacent])) return;
    let edge = adjacent;
    while (edge >= 0 && edge < input.value.length && !/\d/.test(input.value[edge]))
      edge += backward ? -1 : 1;
    if (edge >= 0 && edge < input.value.length)
      input.setSelectionRange(backward ? edge : caret, backward ? caret : edge + 1);
  });
}

function markPublicBookingEntry(browser) {
  try {
    const navigation = browser.navigation;
    if (!navigation?.updateCurrentEntry || !navigation.currentEntry?.getState) return;
    const state = navigation.currentEntry.getState();
    if (state != null && (typeof state !== 'object' || Array.isArray(state))) return;
    navigation.updateCurrentEntry({ state: { ...state, cartotecaPublicBooking: true } });
  } catch {
    // Optional enhancement; the form must work in browsers without Navigation API.
  }
}
function publicBookingReturnOffset(browser) {
  const isBooking = (url) =>
    /\/booking(?:-reply)?\.html$/i.test(url.pathname) || /^\/b\/[a-z0-9]{8}$/.test(url.pathname);
  const isReturnShim = (url) => url.hostname.toLowerCase() === 'l.instagram.com';
  const destination = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  };
  try {
    const navigation = browser.navigation,
      index = navigation?.currentEntry?.index;
    if (Number.isInteger(index) && typeof navigation.entries === 'function') {
      const previous = navigation
        .entries()
        .filter((entry) => entry.index < index)
        .reverse();
      for (const entry of previous) {
        if (entry.getState?.()?.cartotecaPublicBooking === true) continue;
        // A hidden URL needs an external referrer as evidence of a return path.
        if (entry.url === null) {
          const referrer = destination(browser.document?.referrer);
          return referrer && !isBooking(referrer) && !isReturnShim(referrer)
            ? entry.index - index
            : 0;
        }
        const url = destination(entry.url);
        if (!url) return 0;
        if (!isBooking(url) && !isReturnShim(url)) return entry.index - index;
      }
      if (previous.length) return 0;
    }
  } catch {
    // Older/embedded browsers may not expose Navigation history entries.
  }
  // Referrer is only evidence for Back, never a URL to redirect to or persist.
  const referrer = destination(browser.document?.referrer);
  return browser.history?.length > 1 && referrer && !isBooking(referrer) && !isReturnShim(referrer)
    ? -1
    : 0;
}
function leavePublicBookingPage(browser = window) {
  const offset = publicBookingReturnOffset(browser);
  function close() {
    // noopener tabs can still be script-closable. Always attempt actual closing.
    try {
      browser.close();
    } catch {
      // A browser/WebView may forbid closing its tab.
    }
  }
  // A real opener identifies a separate window; otherwise prefer known Back.
  if (!browser.opener && offset) {
    try {
      browser.history.go(offset);
      return;
    } catch {
      // Fall through when the embedded browser denies traversal.
    }
  }
  close();
}
function createPublicBookingFlow(root) {
  markPublicBookingEntry(window);
  const $ = (selector) => root.querySelector(selector);
  let step = 1,
    exited = false;
  window.addEventListener('pagehide', () => {
    exited = true;
  });
  const sections = [
    '#booking-services-section',
    '#booking-date-section',
    '#booking-contact-section',
  ];
  function show(value = step, focus = false) {
    step = value;
    sections.forEach((selector, index) => {
      const section = $(selector);
      if (section) section.hidden = step !== index + 1;
    });
    root.querySelectorAll('[data-booking-progress]').forEach((item) => {
      if (Number(item.dataset.bookingProgress) === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    if (focus && !exited) {
      const heading = $(sections[step - 1] + ' h2');
      heading?.focus({ preventScroll: true });
      root.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }
  function sync(selected, staffId, time) {
    const services = $('[data-booking-next="2"]'),
      date = $('[data-booking-next="3"]');
    if (services) services.disabled = !selected.length || !staffId;
    if (date) date.disabled = !time;
    if (step === 3 && !time) show(2);
    else show();
  }
  function close() {
    leavePublicBookingPage();
  }
  function resume() {
    exited = false;
    const result = $('#booking-result');
    if (result && !result.hidden) result.focus();
    else if ($('#booking-flow')) show(step, true);
    else $('[data-booking-retry]')?.focus();
  }
  return {
    show,
    sync,
    close,
    resume,
    canExit: () => Boolean(window.opener) || publicBookingReturnOffset(window) < 0,
    closed: () => exited,
  };
}

function createPublicBookingReceipt(root, { $, esc, price, dateLabel, status }) {
  function success(info, result, selection) {
    const states = {
      booked: [
        'Запись успешно создана',
        'Подтверждена организацией',
        'Выбранное время закреплено за вами. Ожидать принятия заявки сотрудником не нужно.',
      ],
      pending: [
        'Заявка успешно отправлена',
        'Ожидает подтверждения',
        'Организация получила вашу заявку. Дождитесь связи по указанному телефону: запись ещё не подтверждена.',
      ],
      requested: [
        'Запрос времени отправлен',
        'Нужно согласовать время',
        'Время не резервируется. Организация свяжется с вами по указанному телефону, чтобы согласовать запись.',
      ],
      accepted: [
        'Запись принята',
        'Принята организацией',
        'Организация приняла вашу заявку на это время.',
      ],
      expired: [
        'Заявка сохранена',
        selection.kind === 'other-time' ? 'Срок ожидания истёк' : 'Резерв истёк',
        selection.kind === 'other-time'
          ? 'Срок ожидания решения уже истёк. Можно отправить новую заявку или связаться с организацией.'
          : 'Резерв времени уже истёк. Свяжитесь с организацией, чтобы уточнить доступность и подтвердить запись.',
      ],
      rejected: [
        'Заявка отклонена',
        'Не подтверждена',
        'Свяжитесь с организацией, чтобы подобрать другое время.',
      ],
      cancelled: [
        'Заявка отменена',
        'Не подтверждена',
        'Свяжитесь с организацией, чтобы подобрать другое время.',
      ],
    };
    const [title, state, message] = states[result.status] || [
      'Заявка сохранена',
      'Проверяется организацией',
      'Свяжитесь с организацией для уточнения результата.',
    ];
    const member = info.members.find((m) => m.id === selection.staffId);
    const services = info.services.filter((s) => selection.serviceIds.includes(s.id));
    const date = result.date || selection.date,
      time = result.time || selection.time;
    $('#booking-flow').hidden = true;
    root.classList.add('booking-completed');
    const element = $('#booking-result');
    const negative = ['rejected', 'cancelled'].includes(result.status);
    element.dataset.state = result.status;
    element.innerHTML = [
      '<button type="button" class="booking-result-close" data-booking-result-close aria-label="Закрыть результат отправки" title="Закрыть"><span aria-hidden="true">×</span></button>',
      `<span class="booking-result-icon" aria-hidden="true">${negative ? '×' : '✓'}</span>`,
      `<h2>${esc(title)}</h2>`,
      `<p class="booking-result-state">${esc(state)}</p><p>${esc(message)}</p>`,
      `<div class="booking-receipt"><strong>${esc(dateLabel(date))} · ${esc(time)}</strong>`,
      `<p>${esc(info.organization.name)}${member ? ' · ' + esc(member.name) : ''}</p>`,
      `<p>${esc(services.map((s) => s.name).join(', '))}</p>`,
      `<p>${result.duration || services.reduce((n, s) => n + s.duration, 0)} мин`,
      info.showPrices !== false && services.every((s) => s.price != null)
        ? ' · ' + esc(price(services.reduce((n, s) => n + s.price, 0)))
        : '',
      `</p><small>Время организации · ${esc(info.organization.timeZone)}</small></div>`,
      result.status === 'pending'
        ? `<p class="booking-result-note">${result.expiresAt ? 'Резерв действует до ' + new Intl.DateTimeFormat('ru-RU', { timeZone: info.organization.timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(result.expiresAt)) + ' по времени организации.' : 'Время временно зарезервировано.'} Это не окончательное подтверждение записи.</p>`
        : '',
      result.status === 'requested'
        ? '<p class="booking-result-note">Запрос ожидает решения до 24 часов с момента отправки. После истечения срока можно отправить новую заявку. Время не резервируется.</p>'
        : '',
      result.status === 'booked'
        ? '<p class="booking-result-note">Сохраните дату и время. Отдельное письмо или сообщение после этой формы не отправляется. Для отмены или переноса свяжитесь с организацией.</p>'
        : '<p class="booking-result-note">Письмо или сообщение в мессенджер автоматически после отправки этой формы не отправляется. Уточнения поступят от организации по вашему контакту.</p>',
    ].join('');
    element.hidden = false;
    status(title + '. ' + message);
    $('#booking-page-status').classList.add('sr-only');
    if (!root.classList.contains('booking-exited')) {
      element.focus();
      element.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }
  function dismissResult() {
    $('#booking-result').hidden = true;
    const element = $('#booking-page-status');
    element.classList.remove('sr-only');
    element.classList.add('booking-dismissed');
    // Keep the actual server result; closing the receipt is not cancellation.
    element.textContent += ' Экран результата закрыт. Эту вкладку можно закрыть.';
    element.tabIndex = -1;
    element.focus();
    element.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }
  return { success, dismissResult };
}

function createPublicBookingView(root) {
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const $ = (selector) => root.querySelector(selector);
  const price = (value) => Number(value).toLocaleString('ru-RU') + ' ₽';
  const dateLabel = (date) =>
    new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(date + 'T12:00:00Z'));
  const periods = [
    { id: 'morning', name: 'Утро', hours: 'до 12:00', from: 0, to: 12 },
    { id: 'day', name: 'День', hours: '12:00–18:00', from: 12, to: 18 },
    { id: 'evening', name: 'Вечер', hours: 'после 18:00', from: 18, to: 24 },
  ];
  const closeButton =
    '<button type="button" class="booking-page-close icon-btn" data-booking-close aria-label="Закрыть онлайн-запись" title="Закрыть онлайн-запись"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg></button>';
  let currentAvailability,
    classic = false,
    currentKind,
    period = '',
    visibleTimes = 12;
  function unavailable(organization, reason = 'unavailable', technical = false) {
    const states = {
      paused: [
        'Онлайн-запись временно закрыта',
        'Для записи на приём или уточнения времени свяжитесь с организацией.',
      ],
      awaiting_activation: [
        'Онлайн-запись пока закрыта',
        'Организация ещё не открыла онлайн-запись. Свяжитесь с ней, чтобы согласовать посещение.',
      ],
      no_working_days: [
        'Пока нет открытых дней для записи',
        'Организация ещё не открыла рабочие дни для онлайн-записи. Попробуйте позже или свяжитесь с организацией.',
      ],
      no_slots: [
        'Свободного времени пока нет',
        'В открытом графике нет подходящих свободных окон. Попробуйте позже или уточните время у организации.',
      ],
      unavailable: [
        'Онлайн-запись сейчас недоступна',
        'Свяжитесь с организацией, чтобы уточнить возможность записи.',
      ],
      technical: [
        'Не удалось загрузить онлайн-запись',
        'Проверьте подключение к интернету и повторите загрузку. Это не означает, что всё время занято.',
      ],
    };
    const [title, message] = states[technical ? 'technical' : reason] || states.unavailable;
    const phone = String(organization?.phone || '');
    let digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
    if (digits.length === 10) digits = '7' + digits;
    const displayPhone = /^7\d{10}$/.test(digits)
      ? `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
      : phone;
    const contact = /^\d{10,15}$/.test(digits)
      ? `<span>${esc(organization?.phoneLabel || 'Телефон организации')}</span>` +
        `<a class="booking-contact-phone" href="tel:+${digits}">${esc(displayPhone)}</a>`
      : '';
    root.classList.remove('booking-completed');
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = [
      '<header class="booking-header"><span class="booking-eyebrow">Онлайн-запись</span>',
      `<div class="booking-heading-row"><h1>${esc(organization?.name || 'Запись на приём')}</h1>${closeButton}</div>`,
      '</header><section class="booking-step booking-unavailable" aria-labelledby="booking-unavailable-title">',
      '<span class="booking-unavailable-icon" aria-hidden="true">○</span>',
      `<h2 id="booking-unavailable-title">${esc(title)}</h2><p>${esc(message)}</p>`,
      '<div class="booking-unavailable-actions">',
      contact,
      '<button type="button" data-booking-retry>Повторить загрузку</button>',
      '</div></section><p id="booking-page-status" class="sr-only" role="status" aria-live="polite"></p>',
    ].join('');
  }
  function mount(info) {
    classic = info.bookingMode === 'classic';
    const zoneLabel = ['long', 'longOffset']
      .map(
        (timeZoneName) =>
          new Intl.DateTimeFormat('ru-RU', { timeZone: info.organization.timeZone, timeZoneName })
            .formatToParts(new Date())
            .find((part) => part.type === 'timeZoneName')
            ?.value.replace(/,.*$/, '') || '',
      )
      .join(' · ')
      .replace('GMT', 'UTC');
    const organizationId =
      info.organization.organizationId ||
      new URLSearchParams(location.search).get('organization') ||
      '';
    const consentLink =
      '/consent.html?organization=' + encodeURIComponent(organizationId) + '#booking';
    root.innerHTML = [
      '<header class="booking-header"><span class="booking-eyebrow">Онлайн-запись</span>',
      `<div class="booking-heading-row"><h1>${esc(info.organization.name)}</h1>${closeButton}</div>`,
      '</header>',
      '<div id="booking-flow" class="booking-flow">',
      '<ol class="booking-progress" aria-label="Шаги записи"><li data-booking-progress="1" aria-current="step"><span>1</span>Услуги</li><li data-booking-progress="2"><span>2</span>Дата и время</li><li data-booking-progress="3"><span>3</span>Контакты</li></ol>',
      '<section id="booking-services-section" class="booking-step"><h2 tabindex="-1">Выберите услуги</h2>',
      '<input id="booking-service-search" type="search" placeholder="Поиск услуги или группы" aria-label="Поиск услуг и групп">',
      '<div id="booking-services" class="booking-services"></div><p id="booking-total" class="booking-total"></p>',
      '<div id="booking-staff-section" class="booking-staff-choice" hidden><label for="booking-staff">Специалист</label><select id="booking-staff"></select></div>',
      '<p id="booking-selected-staff" class="booking-calendar-hint" hidden></p>',
      '<div class="booking-step-actions"><button type="button" class="primary" data-booking-next="2" disabled>Далее: дата и время</button></div></section>',
      '<section id="booking-date-section" class="booking-step" hidden><h2 tabindex="-1">Дата и время</h2>',
      '<div class="booking-month-nav"><button type="button" data-booking-month-shift="-1" aria-label="Предыдущий месяц">‹</button>',
      '<label class="booking-month-field"><span class="sr-only">Месяц</span><input id="booking-month" type="month"></label>',
      '<button type="button" data-booking-month-shift="1" aria-label="Следующий месяц">›</button></div>',
      '<div class="booking-weekdays" aria-hidden="true"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>',
      '<div id="booking-days" class="booking-days"></div>',
      '<p class="booking-calendar-hint">Даты с рамкой доступны для выбора. Свободное время покажем после выбора дня.</p>',
      '<div id="booking-time-area" hidden><p id="booking-selected-date" class="booking-selected-date"></p><h3 id="booking-time-heading">Выберите время</h3>',
      '<button id="booking-times-refresh" type="button" class="booking-text-button">Обновить время</button>',
      '<div id="booking-time-periods" class="booking-time-periods" aria-label="Период дня"></div>',
      '<div id="booking-times" class="booking-times"></div>',
      '<button id="booking-times-more" type="button" class="booking-text-button" hidden>Показать ещё время</button>',
      '<button id="booking-other-time" type="button" class="booking-text-button" hidden>Запросить другое время</button>',
      '<p id="booking-time-note" class="muted"></p></div>',
      '<div class="booking-step-actions"><button type="button" data-booking-back="1">Назад</button><button type="button" class="primary" data-booking-next="3" disabled>Далее: контакты</button></div></section>',
      '<section id="booking-contact-section" class="booking-step" hidden><h2 tabindex="-1">Ваши контакты</h2>',
      '<form id="booking-contact-form" class="booking-contact-form"><div class="booking-contact-fields">',
      '<label>Имя<input name="firstName" autocomplete="given-name" maxlength="120" required></label>',
      '<label>Телефон<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67" aria-describedby="booking-phone-hint" maxlength="40" required><small id="booking-phone-hint">Можно начать с +7, 8 или сразу с кода номера. Другую страну укажите через +.</small></label>',
      '</div><details class="booking-optional"><summary>Добавить сведения <small>необязательно</small></summary><div class="booking-contact-fields">',
      '<label>Фамилия <small>необязательно</small><input name="lastName" autocomplete="family-name" maxlength="120"></label>',
      '<label>Отчество <small>необязательно</small><input name="middleName" autocomplete="additional-name" maxlength="120"></label></div>',
      '<label>Комментарий <small>необязательно</small><textarea name="comment" maxlength="1000" placeholder="Что важно учесть при записи?"></textarea></label></details>',
      '<div class="booking-summary" aria-label="Выбранная запись"><p id="booking-summary"></p><div class="booking-edit-selection"><button type="button" data-booking-edit="services">Изменить услуги</button><button type="button" data-booking-edit="time">Изменить время</button></div></div>',
      `<div class="booking-legal-box"><div class="booking-consent"><input id="booking-consent" type="checkbox" name="consent" required><label for="booking-consent">Даю согласие на обработку персональных данных для записи в ${esc(info.organization.name)}.</label></div><p class="booking-legal"><a href="${esc(consentLink)}" target="_blank" rel="noopener noreferrer">Текст согласия</a><span aria-hidden="true"> · </span><a href="/privacy.html" target="_blank" rel="noopener noreferrer">Политика конфиденциальности</a></p></div>`,
      `<div class="booking-step-actions"><button type="submit" class="primary">${classic ? 'Записаться' : 'Отправить заявку'}</button><button type="button" data-booking-back="2">Назад</button></div>`,
      `<p class="booking-submit-hint">${classic ? 'Без регистрации. После сохранения вы сразу увидите подтверждение записи.' : 'Без регистрации. Это заявка — дождитесь подтверждения организации.'}</p></form></section></div>`,
      '<section id="booking-phone-pending" class="booking-step booking-phone-pending" role="status" tabindex="-1" aria-labelledby="booking-phone-pending-title" hidden><h2 id="booking-phone-pending-title">Заявка уже отправлена</h2><p>С этим номером телефона уже есть заявка. Дождитесь подтверждения организации</p><button type="button" data-booking-change-phone>Изменить номер</button></section>',
      '<section id="booking-result" class="booking-result" tabindex="-1" hidden></section>',
      '<p id="booking-page-status" class="booking-status" role="status" aria-live="polite"></p>',
    ].join('');
    root.setAttribute('aria-busy', 'false');
  }
  function catalog(info, selected, query = '', staffId = '') {
    const showPrices = info.showPrices !== false;
    const providers = selected.length
      ? info.members.filter((member) =>
          selected.every((id) =>
            info.services.find((service) => service.id === id)?.staffIds.includes(member.id),
          ),
        )
      : null;
    const search = query.trim().toLowerCase();
    const list = info.services.filter(
      (s) =>
        (!staffId || s.staffIds.includes(staffId)) &&
        [s.name, s.categoryId && s.categoryTitle ? s.categoryTitle : 'Другие услуги'].some((text) =>
          text.toLowerCase().includes(search),
        ),
    );
    const groups = new Map();
    for (const service of list) {
      const id = service.categoryId && service.categoryTitle ? service.categoryId : '';
      if (!groups.has(id))
        groups.set(id, { title: id ? service.categoryTitle : 'Другие услуги', services: [] });
      groups.get(id).services.push(service);
    }
    $('#booking-services').innerHTML =
      [...groups.values()]
        .map(
          (group, index) =>
            `<div class="booking-service-group" role="group" aria-labelledby="booking-service-group-${index}"><h3 id="booking-service-group-${index}">${esc(group.title)}</h3><div class="booking-service-options">` +
            group.services
              .map((s) =>
                [
                  `<label class="booking-service"><input type="checkbox" data-booking-service="${esc(s.id)}" ${selected.includes(s.id) ? 'checked' : ''} ${providers && !selected.includes(s.id) && !providers.some((member) => s.staffIds.includes(member.id)) ? 'disabled' : ''}>`,
                  `<span><strong>${esc(s.name)}</strong><small>${s.duration} мин${showPrices && s.price != null ? ' · ' + esc(price(s.price)) : ''}</small>`,
                  info.members.length > 1
                    ? `<small>${esc(
                        info.members
                          .filter((member) => s.staffIds.includes(member.id))
                          .map((member) => member.name)
                          .join(', '),
                      )}</small>`
                    : '',
                  s.description ? `<small>${esc(s.description)}</small>` : '',
                  '</span></label>',
                ].join(''),
              )
              .join('') +
            '</div></div>',
        )
        .join('') || '<p>Услуги не найдены.</p>';
    const chosen = info.services.filter((s) => selected.includes(s.id));
    $('#booking-total').textContent = chosen.length
      ? `Длительность: ${chosen.reduce((n, s) => n + s.duration, 0)} мин` +
        (showPrices && chosen.every((s) => s.price != null)
          ? ' · Итого ' + price(chosen.reduce((n, s) => n + s.price, 0))
          : '')
      : 'Выберите одну или несколько услуг';
  }
  function staff(members, selected) {
    const current = members.find((member) => member.id === selected),
      label = $('#booking-selected-staff');
    if (label) {
      label.hidden = !current;
      label.textContent = current ? `Специалист: ${current.name}` : '';
    }
    $('#booking-staff-section').hidden = members.length <= 1;
    $('#booking-staff').innerHTML =
      '<option value="">Выберите специалиста</option>' +
      members
        .map(
          (m) =>
            `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}${m.specialty ? ' · ' + esc(m.specialty) : ''}</option>`,
        )
        .join('');
  }
  function rules(value) {
    const known = Boolean(value?.bookingMode),
      intro = root.querySelector('.booking-intro'),
      button = root.querySelector('#booking-contact-form [type="submit"]'),
      hint = root.querySelector('.booking-submit-hint');
    classic = value?.bookingMode === 'classic';
    if (intro)
      intro.textContent = !known
        ? 'Выберите услуги и специалиста. Затем покажем доступные даты и время.'
        : classic
          ? 'Выберите услуги и удобное время. Запись создаётся сразу, без ожидания ответа организации.'
          : 'Выберите услуги и удобное время. Организация подтвердит вашу заявку.';
    if (button)
      button.textContent = !known ? 'Продолжить' : classic ? 'Записаться' : 'Отправить заявку';
    if (hint)
      hint.textContent = !known
        ? 'Условия записи покажем после выбора специалиста.'
        : classic
          ? 'Без регистрации. После сохранения вы сразу увидите подтверждение записи.'
          : 'Без регистрации. Это заявка — дождитесь подтверждения организации.';
  }
  function dates(items, selected) {
    const month = $('#booking-month').value;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      $('#booking-days').innerHTML = '';
      return;
    }
    const [year, number] = month.split('-').map(Number);
    const offset = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
    const open = new Set(items),
      cells = Array(offset).fill('<span></span>');
    for (let day = 1; day <= count; day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      cells.push(
        `<button type="button" ${open.has(date) ? `data-booking-date="${date}"` : 'disabled'} aria-label="${esc(dateLabel(date))}" aria-pressed="${date === selected}">${day}</button>`,
      );
    }
    $('#booking-days').innerHTML =
      cells.join('') +
      (items.length
        ? ''
        : '<p class="booking-empty-days">В этом месяце нет открытых рабочих дней. Выберите другой месяц.</p>');
  }
  function times(availability, time = '', kind = 'reserve') {
    const values =
      kind === 'other-time' ? availability.requestedTimes : availability.slots.map((s) => s.time);
    const availablePeriods = periods.filter((p) =>
      values.some((t) => +t.slice(0, 2) >= p.from && +t.slice(0, 2) < p.to),
    );
    if (availability !== currentAvailability || kind !== currentKind) {
      period = availablePeriods[0]?.id || '';
      visibleTimes = 12;
      currentAvailability = availability;
      currentKind = kind;
    }
    const active = availablePeriods.find((p) => p.id === period);
    const filtered = active
      ? values.filter((t) => +t.slice(0, 2) >= active.from && +t.slice(0, 2) < active.to)
      : [];
    $('#booking-time-periods').innerHTML = values.length
      ? periods
          .map(
            (p) =>
              `<button type="button" data-booking-period="${p.id}" ${availablePeriods.includes(p) ? '' : 'disabled'} aria-pressed="${p.id === period}"><strong>${p.name}</strong><small>${p.hours}</small></button>`,
          )
          .join('')
      : '';
    $('#booking-times').innerHTML =
      filtered
        .slice(0, visibleTimes)
        .map(
          (t) =>
            `<button type="button" ${kind === 'other-time' ? 'data-booking-requested-time' : 'data-booking-time'}="${t}" aria-pressed="${t === time}">${t}</button>`,
        )
        .join('') ||
      '<p class="booking-empty-times">На эту дату нет свободного времени для выбранных услуг. Выберите другую дату или уточните время у организации.</p>';
    $('#booking-times-more').hidden = filtered.length <= visibleTimes;
    $('#booking-other-time').hidden = classic || !availability.requestedTimes.length;
    $('#booking-other-time').textContent =
      kind === 'other-time' ? 'Вернуться к свободному времени' : 'Запросить другое время';
    $('#booking-time-heading').textContent =
      kind === 'other-time' ? 'Какое время вам удобно?' : 'Выберите время';
    $('#booking-time-note').textContent =
      kind === 'other-time'
        ? 'Это пожелание, а не свободный слот. Время не резервируется — его нужно согласовать с организацией.'
        : '';
  }
  function timePeriod(value) {
    period = value;
    visibleTimes = 12;
  }
  function moreTimes() {
    visibleTimes += 12;
  }
  const receipt = createPublicBookingReceipt(root, { $, esc, price, dateLabel, status });
  function status(message) {
    const element = $('#booking-page-status');
    if (element) element.textContent = message;
    else root.textContent = message;
  }
  function exitAvailable(available) {
    root.querySelectorAll('[data-booking-close], [data-booking-result-close]').forEach((button) => {
      button.hidden = available !== true;
    });
  }
  function phonePending(visible = true) {
    const card = $('#booking-phone-pending'),
      flow = $('#booking-flow');
    if (!card || !flow) return;
    card.hidden = !visible;
    flow.hidden = visible;
    if (visible) card.focus();
  }
  function lock(locked, retry = false, options = null) {
    const cooldown =
      locked &&
      retry &&
      options !== null &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      Number.isFinite(options.retryAfterSeconds) &&
      options.retryAfterSeconds > 0;
    root.querySelectorAll('input,select,textarea,button').forEach((element) => {
      element.disabled =
        !element.hasAttribute('data-booking-close') &&
        (locked ||
          (element.matches('#booking-days button') && !element.dataset.bookingDate) ||
          (element.hasAttribute('data-booking-period') &&
            !currentAvailability?.[currentKind === 'other-time' ? 'requestedTimes' : 'slots']?.some(
              (slot) => {
                const hour = Number((typeof slot === 'string' ? slot : slot.time).slice(0, 2));
                const range = periods.find((p) => p.id === element.dataset.bookingPeriod);
                return range && hour >= range.from && hour < range.to;
              },
            )));
    });
    const button = $('#booking-contact-form button[type="submit"]');
    if (button) {
      const active = locked && !retry;
      button.classList.toggle('booking-submit-pending', active);
      button.setAttribute('aria-busy', String(active));
      button.textContent = active
        ? classic
          ? 'Создаём запись…'
          : 'Отправляем заявку…'
        : classic
          ? 'Записаться'
          : 'Отправить заявку';
    }
    if (button && retry) {
      button.disabled = cooldown;
      button.textContent = cooldown ? 'Повторить позже' : 'Повторить отправку';
    }
  }
  return {
    $,
    unavailable,
    mount,
    catalog,
    staff,
    rules,
    dates,
    times,
    timePeriod,
    moreTimes,
    ...receipt,
    status,
    exitAvailable,
    phonePending,
    lock,
  };
}

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

function createBookingReplyPage(root, request) {
  // Fragment is not sent as a URL to the server or referrer. Only POST bodies carry it.
  const secret = new URLSearchParams(location.hash.slice(1)).get('reply');
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let busy = false,
    pending = null;
  const call = (name, payload) =>
    request('/api/public-booking/' + name, { method: 'POST', body: JSON.stringify(payload) });
  function render(info) {
    const messages = {
      waiting:
        'Время не резервируется. После вашего согласия организация завершит оформление записи.',
      agreed: 'Вы согласились на это время. Организация завершит оформление записи.',
      accepted: 'Запись принята организацией.',
      rejected: 'Предложение отклонено.',
    };
    root.innerHTML = [
      '<section class="booking-section"><h1>Согласование записи</h1>',
      `<h2>${esc(info.organization.name)}</h2>`,
      info.staff
        ? `<p>${esc(info.staff.name)}${info.staff.specialty ? ' · ' + esc(info.staff.specialty) : ''}</p>`
        : '',
      `<p><strong>${esc(info.date.split('-').reverse().join('.'))} · ${esc(info.time)}</strong> · ${esc(info.duration)} мин.</p>`,
      `<p>${esc(info.services.map((s) => s.name).join(', '))}</p>`,
      `<p>${esc(messages[info.state] || 'Предложение уже обработано.')}</p>`,
      info.state === 'waiting'
        ? '<div class="booking-times"><button type="button" class="primary" data-reply="agree">Подтвердить время</button><button type="button" data-reply="decline">Отказаться</button></div>'
        : '',
      '<p data-reply-status role="status" aria-live="polite"></p></section>',
    ].join('');
  }
  async function initialize() {
    root.innerHTML = '<p role="status">Загрузка предложения…</p>';
    try {
      render(await call('proposal', { secret }));
    } catch (error) {
      root.innerHTML = `<p role="status">${esc(error.message)}</p>`;
    }
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-reply]');
      if (!button || busy) return;
      const decision = button.dataset.reply;
      if (pending && pending !== decision) return;
      busy = true;
      pending = decision;
      root.querySelectorAll('[data-reply]').forEach((b) => {
        b.disabled = true;
      });
      try {
        render(await call('proposal-response', { secret, decision }));
        pending = null;
      } catch (error) {
        root.querySelector('[data-reply-status]').textContent =
          error.message +
          (error.status >= 400 && error.status < 500
            ? ''
            : ' Повторите тот же ответ: дубль не создаётся.');
        if (error.status >= 400 && error.status < 500) pending = null;
        root.querySelectorAll('[data-reply]').forEach((b) => {
          b.disabled = Boolean(pending && b.dataset.reply !== pending);
        });
      } finally {
        busy = false;
      }
    });
  }
  return { initialize };
}

const root=document.getElementById("public-booking");
if(new URLSearchParams(location.hash.slice(1)).has("reply")) createBookingReplyPage(root,publicBookingRequest).initialize();
else createPublicBookingPage(root,createPublicBookingView).initialize();
})();
