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
