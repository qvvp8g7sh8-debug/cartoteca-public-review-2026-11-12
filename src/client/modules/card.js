function createCard(state, actions) {
  const visitPageSize = 5;
  const desktopCard =
    typeof window === 'undefined' ? null : window.matchMedia?.('screen and (min-width: 981px)');
  let historyScope = '',
    visibleVisitCount = visitPageSize;
  function placeVisitAction() {
    const detail = actions.$('#detail'),
      button = detail?.querySelector('.visit-add-action'),
      row = detail?.querySelector('.card-tabs-row');
    if (!button || !row || state.activeTab !== 'visits') return;
    if (desktopCard?.matches && detail.closest('.workspace-designed.card-mode')) row.append(button);
    else
      detail
        .querySelector(button.id === 'new-visit' ? '.visit-history-heading' : '#tab-content .empty')
        ?.prepend(button);
  }
  desktopCard?.addEventListener?.('change', placeVisitAction);
  function historyVisits(p) {
    const page = actions.patientView();
    const scope = JSON.stringify([
      state.account?.id,
      state.account?.organizationId,
      p?.id,
      page?.revision,
    ]);
    if (scope !== historyScope) {
      historyScope = scope;
      visibleVisitCount = visitPageSize;
    }
    if (page?.patient === p)
      return page.history.entries.map((entry) =>
        entry.kind === 'visit'
          ? entry.record
          : { ...entry.record, historyKind: 'appointment-outcome', patientId: p.id },
      );
    const outcomes = (p?.appointments || [])
      .filter((a) => ['cancelled', 'no_show'].includes(a.status))
      .map((a) => ({ ...a, historyKind: 'appointment-outcome', patientId: p.id }));
    return [...(p?.visits || []), ...outcomes].sort((a, b) =>
      (b.date + ' ' + (b.time || '')).localeCompare(a.date + ' ' + (a.time || '')),
    );
  }
  function visitMoreHtml(total) {
    return total > visibleVisitCount
      ? `<button type="button" class="secondary" id="more-visits" aria-controls="visit-history-list">Показать ещё ${Math.min(visitPageSize, total - visibleVisitCount)}</button>`
      : '';
  }
  async function showMoreVisits() {
    let p = actions.viewPatient();
    const page = actions.patientView();
    if (
      page &&
      page.history.entries.length < visibleVisitCount + visitPageSize &&
      page.history.nextCursor
    ) {
      if (!(await actions.loadPatientViewPage('history'))) return;
      p = actions.viewPatient();
      if (!p || p.id !== page.patient.id) return;
    }
    const list = actions.$('#visit-history-list'),
      more = actions.$('#more-visits');
    if (!p || state.activeTab !== 'visits' || !list || !more) return;
    const visits = historyVisits(p),
      next = visits.slice(visibleVisitCount, visibleVisitCount + visitPageSize),
      firstNewIndex = list.children.length;
    visibleVisitCount += visitPageSize;
    list.insertAdjacentHTML('beforeend', next.map((v) => actions.visitHtml(v)).join(''));
    more.parentElement.innerHTML = visitMoreHtml(
      actions.patientView()?.history.total ?? visits.length,
    );
    list.children[firstNewIndex]?.querySelector('summary')?.focus({ preventScroll: true });
  }
  async function showMorePatientAppointments() {
    const page = actions.patientView();
    if (!page?.upcoming.nextCursor) return;
    if (!(await actions.loadPatientViewPage('upcoming'))) return;
    if (actions.patientView()?.patient.id === page.patient.id) renderDetail();
  }
  function patientAppointmentsMoreHtml() {
    return actions.patientView()?.upcoming.nextCursor
      ? '<button type="button" class="secondary" id="more-patient-appointments">Показать ещё записи</button>'
      : '';
  }
  function renderDetail() {
    actions.invalidatePrint();
    const p = actions.viewPatient();
    if (!p) {
      historyVisits(null);
      actions.$('#detail').innerHTML =
        '<div class="welcome"><h2>Откройте карточку клиента</h2><p>Выберите имя в списке слева.</p></div>';
      document.body.classList.remove('has-patient');
      return;
    }
    document.body.classList.add('has-patient');
    const visits = historyVisits(p),
      page = actions.patientView(),
      visitTotal = page?.history.total ?? visits.length,
      photoTotal =
        page?.history.photoCount ?? visits.reduce((n, v) => n + (v.photos || []).length, 0),
      designation = String(p.designation || '').trim();
    actions.$('#detail').innerHTML = [
      `<button class="back" `,
      `id="back">← Все клиенты</button>`,
      `<header class="patient-header">`,
      `<div class="patient-identity">`,
      `<p class="eyebrow">КАРТОЧКА КЛИЕНТА</p>`,
      `<h2><span>${actions.esc(p.name || (p.phone && actions.formatPhone(p.phone)) || 'Имя не указано')}</span>${actions.patientMarkHtml(p)}</h2>`,
      '<p class="contact"><span class="patient-contact-item"><span class="patient-contact-label">Телефон</span><span class="patient-contact-value">',
      p.phone
        ? actions.esc(actions.formatPhone(p.phone))
        : '<span class="patient-contact-prefix">Телефон </span>не указан',
      '</span></span><span class="patient-contact-separator"> · </span><span class="patient-contact-item"><span class="patient-contact-label">Дата рождения</span><span class="patient-contact-value"><span class="patient-contact-prefix">дата рождения </span>',
      p.birth ? actions.esc(actions.formatDate(p.birth)) : 'не указана',
      '</span></span></p>',
      '<div class="patient-card-meta">',
      designation
        ? `<p class="patient-card-designation"><span>Обозначение:</span> ${actions.esc(designation)}</p>`
        : '',
      actions.videoConsentHtml(p),
      '</div>',
      `</div>`,
      `<div class="patient-actions">`,
      `<button class="primary" `,
      `id="new-patient-appointment">+ Записать на приём</button>`,
      state.multiUser ? actions.patientConnectionsHtml(p.id) : '',
      `${actions.canEditPatient() ? '<button class="secondary" type="button" id="edit-patient">Редактировать карточку</button>' : ''}<details class="patient-more"><summary>Ещё</summary><button class="secondary" `,
      `type="button" `,
      `id="print-patient">Печать карточки</button></details>`,
      `<p id="print-status" `,
      `role="status" `,
      `aria-live="polite" hidden>`,
      `</p>`,
      `</div>`,
      `</header>`,
      `<div class="card-tabs-row"><nav class="tabs">`,
      `<button class="tab ${state.activeTab === 'visits' ? 'active' : ''}" `,
      `data-tab="visits">Посещения <span>${visitTotal}</span>`,
      `</button>`,
      `<button class="tab ${state.activeTab === 'profile' ? 'active' : ''}" `,
      `data-tab="profile">Информация</button>`,
      `<button class="tab ${state.activeTab === 'photos' ? 'active' : ''}" `,
      `data-tab="photos">Фотографии <span>${photoTotal}</span>`,
      `</button>`,
      `</nav></div>`,
      `<div id="tab-content">`,
      `</div>`,
    ].join('');
    if (state.multiUser) {
      const appointments = (p.appointments || [])
        .filter((a) => actions.isActiveAppointment(a))
        .sort((a, b) => (a.date + ' ' + a.time).localeCompare(b.date + ' ' + b.time));
      actions
        .$('.card-tabs-row')
        .insertAdjacentHTML(
          'beforebegin',
          '<section class="telegram-patient-panel patient-appointments unified-appointments" aria-label="Записи на приём"><div id="patient-telegram-body">' +
            actions.appointmentPanelHtml(appointments, p.id) +
            '</div><div class="patient-appointments-more">' +
            patientAppointmentsMoreHtml() +
            '</div></section>',
        );
    } else
      actions
        .$('.card-tabs-row')
        .insertAdjacentHTML('beforebegin', actions.patientAppointmentsHtml(p));
    actions.renderTab(p, visits);
    if (state.multiUser) {
      actions.loadPatientTelegram(p.id);
    }
    if (actions.printablePatient()) actions.buildPrintCard(p);
  }
  function renderTab(p, visits) {
    historyVisits(p);
    const root = actions.$('#tab-content');
    actions.$('#detail .card-tabs-row > .visit-add-action')?.remove();
    const visitAction =
      '<svg class="visit-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="6" rx="2"/><path d="m8 14 3 3 5-6"/></svg><span>Добавить посещение без записи</span>';
    if (state.activeTab === 'profile') {
      root.innerHTML = [
        `<section class="card">`,
        `<h3>Основные сведения</h3>`,
        `<dl class="field-value">`,
        `<dt>Важная информация</dt>`,
        `<dd>${actions.esc(p.allergies || 'Не указаны')}</dd>`,
        `</dl>`,
        `<dl class="field-value">`,
        `<dt>Заметки</dt>`,
        `<dd>${actions.esc(p.notes || 'Нет заметок')}</dd>`,
        `</dl>${actions.canEditPatient() ? '<button class="secondary" id="edit-profile">Изменить сведения</button>' : ''}</section>`,
      ].join('');
      return;
    }
    if (state.activeTab === 'photos') {
      const photos = visits.flatMap((v) =>
        (v.photos || []).map((ph, i) => ({ ...ph, date: v.date, procedure: v.procedure, i })),
      );
      root.innerHTML = photos.length
        ? [
            `<section class="card">`,
            `<div class="content-heading">`,
            `<h3>Фотографии</h3>`,
            `<small>${photos.length} ${actions.plural(photos.length, 'снимок', 'снимка', 'снимков')}</small>`,
            `</div>`,
            `<div class="photo-grid">${photos
              .map((ph) => {
                const source = actions.photoSource(ph.data);
                return [
                  `<button class="photo-item" `,
                  `data-photo="${actions.esc(source)}" `,
                  `data-caption="${actions.esc(actions.formatDate(ph.date) + ' · ' + (ph.procedure || 'Посещение') + ' · ' + (ph.caption || 'Фото визита'))}">`,
                  `<img${source ? ` src="${actions.esc(source)}"` : ''} `,
                  `alt="Фото от ${actions.esc(actions.formatDate(ph.date))}">`,
                  `<span class="photo-item-caption"><strong class="photo-item-procedure">${actions.esc(ph.procedure || 'Посещение')}</strong>`,
                  `<small>${actions.esc(actions.formatDate(ph.date))} · ${actions.esc(ph.caption || 'Фото визита')}</small>`,
                  `</span>`,
                  `</button>`,
                ].join('');
              })
              .join('')}</div>`,
            `</section>`,
          ].join('')
        : '<div class="empty"><h3>Фотографий пока нет</h3><p>Они появятся здесь после добавления к посещению.</p></div>';
      return;
    }
    const total = actions.patientView()?.history.total ?? visits.length;
    root.innerHTML = visits.length
      ? [
          `<div class="content-heading visit-history-heading">`,
          `<button class="secondary visit-add-action" type="button" `,
          `id="new-visit">${visitAction}</button>`,
          `<h3>История посещений</h3>`,
          `<small>${total} ${actions.plural(total, 'запись', 'записи', 'записей')}</small>`,
          `</div><div id="visit-history-list">`,
          visits
            .slice(0, visibleVisitCount)
            .map((v) => actions.visitHtml(v))
            .join(''),
          `</div><div class="visit-history-more">${visitMoreHtml(total)}</div>`,
        ].join('')
      : [
          '<div class="empty">',
          '<button class="secondary visit-add-action" type="button" ',
          `id="empty-new">${visitAction}</button>`,
          '<h3>Посещений пока нет</h3>',
          '<p>Здесь только проведённые посещения. Для будущего приёма нажмите «Записать на приём».</p>',
          '</div>',
        ].join('');
    placeVisitAction();
  }
  function visitHtml(v) {
    if (v.historyKind === 'appointment-outcome') {
      const cancelled = v.status === 'cancelled',
        status = cancelled ? 'Отменена' : 'Не пришёл';
      return [
        `<article class="visit appointment-outcome-history">`,
        `<div class="visit-head">`,
        `<span class="visit-date">${actions.esc(actions.formatDate(v.date))}${v.time ? `<small>${actions.esc(v.time)}</small>` : ''}</span>`,
        `<span class="visit-brief" title="${actions.esc(v.service || 'Запись')}">${actions.esc(v.service || 'Запись')}</span>`,
        `<strong class="appointment-outcome-status ${cancelled ? 'is-cancelled' : 'is-no-show'}">${status}</strong>`,
        `</div>`,
        `<div class="visit-body appointment-outcome-body">`,
        `<p class="form-hint">${cancelled ? 'Приём был отменён.' : 'Клиент не пришёл.'} Запись сохранена в истории.</p>`,
        `${actions.canEditRecord(v) ? `<button type="button" class="secondary" data-book-again="${actions.esc(v.patientId)}">Перезаписать</button>` : ''}`,
        `</div>`,
        `</article>`,
      ].join('');
    }
    return [
      `<details class="visit visit-accordion compact-accordion">`,
      `<summary class="visit-head">`,
      `<span class="visit-date">${actions.esc(actions.formatDate(v.date))}${v.time ? `<small>${actions.esc(v.time)}</small>` : ''}</span>`,
      `<span class="visit-brief" `,
      `title="${actions.esc(v.procedure || v.type || 'Посещение')}">${actions.esc(v.procedure || v.type || 'Посещение')}</span>`,
      `</summary>`,
      `<div class="visit-body">`,
      `<div class="visit-expanded-meta">`,
      `${v.duration ? `<small>${actions.formatMinutes(v.duration)}</small>` : ''}</div>`,
      `<h3>${actions.esc(v.procedure || 'Посещение')}</h3>`,
      `${v.notes ? `<p class="note">${actions.esc(v.notes)}</p>` : ''}${v.recommendations ? `<h4>Рекомендации</h4><p class="note">${actions.esc(v.recommendations)}</p>` : ''}${
        v.photos?.length
          ? `<div class="thumbs">${v.photos
              .map((ph, i) => {
                const source = actions.photoSource(ph.data);
                return [
                  `<button data-photo="${actions.esc(source)}" `,
                  `data-caption="${actions.esc(actions.formatDate(v.date) + ' · ' + (v.procedure || 'Посещение') + ' · ' + (ph.caption || 'Фото визита'))}">`,
                  `<img${source ? ` src="${actions.esc(source)}"` : ''} `,
                  `alt="Фото ${i + 1}">`,
                  `</button>`,
                ].join('');
              })
              .join('')}</div>`
          : ''
      }<div class="visit-footer">`,
      `<small>${v.photos?.length || 0} фото</small>${actions.canEditRecord(v) ? `<button class="text-btn" data-edit-visit="${actions.esc(v.id)}">Редактировать</button>` : ''}</div>`,
      `</div>`,
      `</details>`,
    ].join('');
  }

  return { renderDetail, renderTab, visitHtml, showMoreVisits, showMorePatientAppointments };
}
