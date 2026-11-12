// Presentation only; provider credentials stay in the rendered subscription controls.
function createCalendarIntegrationView(state, actions) {
  function calendarIntegrationHeading(calendar) {
    const admin = state.account?.role === 'salon_admin';
    const help =
      (admin
        ? `Расписание всех или выбранных специалистов организации передаётся в ${calendar.name}. Выбор сохраняется отдельно для Apple и Google и доступен до подключения календаря. `
        : `Ваши приёмы и личная занятость передаются в ${calendar.name}. `) +
      'Это односторонняя подписка: изменения в Картотеке обновляют календарь, а изменения в календаре не меняют Картотеку. ' +
      (admin
        ? 'Передаются имя клиента, время и длительность приёма, имя специалиста. Личная занятость отмечается общей подписью с именем специалиста. '
        : 'Передаются имя клиента, время и длительность приёма. ') +
      'Телефоны, услуги и заметки не передаются.\n\n' +
      'Период: 7 дней назад и 30 дней вперёд. ' +
      (calendar.id === 'google'
        ? 'Google сам определяет частоту обновления, поэтому изменения могут появляться с задержкой. После добавления включите календарь в приложении Android в том же аккаунте Google. '
        : 'Рекомендуемое обновление — раз в 10 минут; Apple может обновлять реже. ') +
      'Картотека не получает подтверждение, что Google или Apple добавили подписку.\n\n' +
      'Выключение отзывает ссылку только этого подключения. Сохранённый календарь можно удалить в приложении. ' +
      'Повторное включение создаёт новую ссылку. Подключения Apple и Google отключаются отдельно.';
    return (
      `<div class="settings-label-row integration-card-heading"><h4>${actions.esc(calendar.name)}</h4>` +
      actions.settingsHelpHtml(calendar.name, help) +
      '</div>'
    );
  }

  function calendarIntegrationTarget(calendar, result) {
    if (!result?.connected || typeof result.credential !== 'string' || !result.credential)
      return null;
    const feed = new URL('/api/calendar/feed.ics', location.origin);
    feed.searchParams.set('subscription', result.credential);
    const webcal = new URL('webcal://' + feed.host + feed.pathname);
    webcal.search = feed.search;
    if (calendar.id !== 'google') return { feed: feed.href, url: webcal.href };
    const google = new URL('https://calendar.google.com/calendar/r');
    google.searchParams.set('cid', webcal.href);
    return { feed: feed.href, url: google.href };
  }

  function calendarManualHtml(calendar, target) {
    if (!target) return '';
    const google = calendar.id === 'google';
    const fieldId = calendar.id + '-calendar-subscription-url';
    return [
      '<details class="integration-manual"><summary>Если календарь не открылся</summary>',
      '<div class="integration-manual-content">',
      google
        ? '<p>Если Google не подставил адрес подписки, скопируйте ссылку ниже. Откройте «Добавить по URL», вставьте её в поле «URL календаря» и нажмите «Добавить календарь». На Android включите этот календарь в том же аккаунте Google.</p>'
        : '<p>В Apple Календаре выберите добавление подписного календаря и вставьте ссылку ниже. Если календарь уже добавлен, повторная подписка не нужна.</p>',
      `<div class="field"><label for="${actions.esc(fieldId)}">Ссылка подписки</label>`,
      `<input id="${actions.esc(fieldId)}" type="text" readonly spellcheck="false" autocomplete="off" value="${actions.esc(target.feed)}"></div>`,
      '<div class="integration-manual-controls">',
      google
        ? '<button type="button" class="secondary" data-calendar-copy>Скопировать ссылку</button>' +
          '<a class="secondary" href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" data-calendar-manual-google target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Добавить по URL</a>'
        : '',
      `<a class="secondary" href="${actions.esc(target.url)}" data-calendar-launch target="${google ? '_blank' : '_self'}" rel="noopener noreferrer" referrerpolicy="no-referrer">Открыть ${actions.esc(calendar.name)}</a>`,
      '</div></div></details>',
    ].join('');
  }

  function calendarSelectionHtml(calendar, result) {
    if (state.account?.role !== 'salon_admin') return '';
    const specialists = Array.isArray(result.specialists) ? result.specialists : [],
      selected = result.selection?.mode === 'selected',
      staffIds = new Set(result.selection?.staffIds || []),
      name = calendar.id + '-calendar-selection-mode';
    return [
      `<fieldset class="integration-selection" data-calendar-selection aria-describedby="${calendar.id}-calendar-selection-hint">`,
      '<legend>Расписание специалистов</legend>',
      `<label class="integration-selection-choice"><input type="radio" name="${name}" value="all" data-calendar-mode ${selected ? '' : 'checked'}><span>Все специалисты</span></label>`,
      `<label class="integration-selection-choice"><input type="radio" name="${name}" value="selected" data-calendar-mode ${selected ? 'checked' : ''} ${specialists.length ? '' : 'disabled'}><span>Выбрать специалистов</span></label>`,
      `<div class="integration-staff-list" data-calendar-staff-list ${selected ? '' : 'hidden'}>`,
      ...specialists.map(
        (staff) =>
          '<label class="integration-selection-choice">' +
          `<input type="checkbox" name="${calendar.id}-calendar-staff" value="${actions.esc(staff.id)}" data-calendar-staff ${staffIds.has(staff.id) ? 'checked' : ''}>` +
          `<span>${actions.esc(staff.displayName)}</span></label>`,
      ),
      '</div>',
      `<p id="${calendar.id}-calendar-selection-hint" class="form-hint" role="status" aria-live="polite" data-calendar-selection-hint></p>`,
      '<button type="button" class="secondary" data-calendar-save disabled>Сохранить выбор</button>',
      '</fieldset>',
    ].join('');
  }

  function calendarIntegrationHtml(calendar, result) {
    const connected = !!result.connected;
    const dialogId = calendar.id + '-calendar-help';
    const titleId = dialogId + '-title';
    const textId = dialogId + '-text';
    const heading = calendarIntegrationHeading(calendar).replace(
      'aria-controls="settings-help-dialog"',
      `aria-controls="${actions.esc(dialogId)}"`,
    );
    return [
      '<div class="integration-card-summary">',
      heading,
      `<p class="integration-card-status" role="status" data-calendar-status="${connected ? 'connected' : 'disconnected'}">${connected ? 'Включено' : 'Выключено'}</p>`,
      '</div>',
      '<label class="integration-switch">',
      `<input type="checkbox" role="switch" data-calendar-switch aria-label="${actions.esc('Передавать расписание в ' + calendar.name)}" ${connected ? 'checked' : ''}>`,
      '<span class="integration-switch-track" aria-hidden="true"></span>',
      '</label>',
      calendarSelectionHtml(calendar, result),
      `<dialog id="${actions.esc(dialogId)}" class="integration-help-dialog" aria-labelledby="${actions.esc(titleId)}" aria-describedby="${actions.esc(textId)}">`,
      `<div class="integration-help-heading"><h3 id="${actions.esc(titleId)}">${actions.esc(calendar.name)}</h3>`,
      '<button type="button" class="integration-help-close" data-calendar-help-close aria-label="Закрыть пояснение" autofocus>×</button></div>',
      `<p id="${actions.esc(textId)}" data-calendar-help-text></p>`,
      calendarManualHtml(calendar, calendarIntegrationTarget(calendar, result)),
      '</dialog>',
      '<p class="form-hint" role="status" aria-live="polite" data-calendar-message></p>',
    ].join('');
  }

  return {
    calendarIntegrationHeading,
    calendarIntegrationHtml,
    calendarIntegrationTarget,
  };
}
