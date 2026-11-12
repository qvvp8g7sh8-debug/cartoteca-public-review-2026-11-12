function createClients(state, actions) {
  let localKey = '',
    visibleCount = 20;
  let deferredList = null;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  document.addEventListener('click', (e) => {
    if (!state.busy && e.target.closest('.empty [data-client-filter="all"]')) {
      state.clientFilter = 'all';
      renderList();
      actions.$('#search').focus();
    }
    if (!state.pagedReads && e.target.closest('#directory-more')) {
      visibleCount += 20;
      renderList();
    }
  });
  function patient() {
    return state.data.find((x) => x.id === state.selectedId);
  }
  function countVisits(p) {
    return p.visitCount ?? (p.visits || []).length;
  }
  function avatarColor(id) {
    let hash = 0;
    for (const letter of String(id || '')) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
    return hash % 6;
  }
  function flushClientList() {
    if (document.visibilityState === 'hidden') return;
    const deferred = deferredList;
    deferredList = null;
    if (
      !deferred ||
      state.sessionReady === false ||
      deferred.account !== state.account ||
      deferred.scope !== scope() ||
      deferred.view !== state.currentView ||
      !['clients', 'card'].includes(state.currentView)
    )
      return;
    renderList();
  }
  function renderList(options = {}) {
    if (options?.immediate !== true && document.visibilityState === 'hidden') {
      deferredList = { account: state.account, scope: scope(), view: state.currentView };
      return;
    }
    deferredList = null;
    const q = (actions.$('#search').value || '').trim().toLowerCase();
    const page = actions.directoryView();
    const records = actions.clientRecords();
    const sortMode = state.patientSort;
    const collator = new Intl.Collator('ru', { sensitivity: 'base' });
    const today = actions.cabinetToday();
    const daysAgo = (days) => {
      const date = actions.cabinetTodayDate();
      date.setDate(date.getDate() - days);
      return actions.isoDate(date);
    };
    const recentDate = daysAgo(30),
      inactiveDate = daysAgo(90);
    const lastVisitDate = (p) =>
      p.lastVisit?.date ||
      [...(p.visits || [])].map((v) => v.date || '').sort((a, b) => b.localeCompare(a))[0] ||
      '';
    const hasAppointment = (p) =>
      (p.appointments || []).some((a) => actions.isActiveAppointment(a) && (a.date || '') >= today);
    const hasPastAppointmentSince = (p, from) =>
      (p.appointments || []).some(
        (a) => actions.isActiveAppointment(a) && a.date >= from && a.date <= today,
      );
    const wasRecent = (p) =>
      (lastVisitDate(p) >= recentDate && lastVisitDate(p) <= today) ||
      hasPastAppointmentSince(p, recentDate);
    const wasInactive = (p) =>
      (!lastVisitDate(p) || lastVisitDate(p) < inactiveDate) &&
      !hasPastAppointmentSince(p, inactiveDate);
    const matchesFilter = (p) =>
      state.clientFilter === 'appointment'
        ? hasAppointment(p)
        : state.clientFilter === 'recent'
          ? wasRecent(p)
          : state.clientFilter === 'inactive'
            ? wasInactive(p)
            : true;
    const filterCounts = page
      ? page.counts
      : {
          all: records.length,
          appointment: records.filter(hasAppointment).length,
          recent: records.filter(wasRecent).length,
          inactive: records.filter(wasInactive).length,
        };
    Object.entries(filterCounts).forEach(([key, value]) => {
      const count = actions.$(`#filter-count-${key}`);
      if (count) count.textContent = value;
    });
    document.querySelectorAll('[data-client-filter]').forEach((button) => {
      const active = button.dataset.clientFilter === state.clientFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-patient-sort]').forEach((button) => {
      const active = button.dataset.patientSort === state.patientSort;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const nextKey = JSON.stringify([
      state.account?.id,
      state.currentView,
      q,
      sortMode,
      state.clientFilter,
    ]);
    if (nextKey !== localKey) {
      localKey = nextKey;
      visibleCount = 20;
    }
    const matches = page
      ? page.items
      : records
          .filter(
            (p) =>
              (!q || actions.patientMatchesSearch(p, q)) &&
              (state.currentView !== 'clients' || matchesFilter(p)),
          )
          .sort((a, b) => {
            const x = actions.patientNameParts(a),
              y = actions.patientNameParts(b);
            if (sortMode === 'last' && Boolean(x.last) !== Boolean(y.last)) return x.last ? -1 : 1;
            const primary =
              sortMode === 'last'
                ? collator.compare(x.last, y.last)
                : collator.compare(x.first, y.first);
            const secondary =
              sortMode === 'last'
                ? collator.compare(x.first, y.first)
                : collator.compare(x.last, y.last);
            return primary || secondary || collator.compare(x.full, y.full);
          });
    actions.$('#count').textContent = 'Всего: ' + (page ? page.total : records.length);
    const matched = page ? page.matched : matches.length;
    const items = page ? matches : matches.slice(0, visibleCount);
    actions.$('#list-result-count').textContent =
      `${q ? 'Найдено: ' : 'В списке: '}${matched} ${actions.plural(matched, 'клиент', 'клиента', 'клиентов')}`;
    const status = page?.error
      ? `<div class="form-hint" role="status">${actions.esc(page.error)} <button type="button" class="secondary" id="directory-retry">Повторить загрузку</button></div>`
      : page?.loading
        ? '<div class="form-hint" role="status">Загрузка клиентов…</div>'
        : '';
    const more = page ? page.more : items.length < matched;
    const tail =
      more || status
        ? [
            `<div id="directory-tail" `,
            `class="directory-more">${status}${more && !page?.error ? `<button type="button" class="secondary" id="directory-more" ${page?.loading ? 'disabled' : ''}>${page?.loading ? 'Загрузка…' : 'Показать ещё 20'}</button>` : ''}</div>`,
          ].join('')
        : '';
    if (state.currentView === 'card' && !q) {
      actions.$('#patient-list').innerHTML = '';
      return;
    }
    if (!items.length) {
      actions.$('#patient-list').innerHTML =
        status ||
        '<div class="empty"><h3>Ничего не найдено</h3><p>' +
          (state.currentView === 'clients' && state.clientFilter !== 'all'
            ? 'Поиск ограничен фильтром «' +
              actions.esc(
                { appointment: 'Есть запись', recent: 'Были недавно', inactive: 'Давно не были' }[
                  state.clientFilter
                ] || state.clientFilter,
              ) +
              '».</p><button type="button" class="secondary" data-client-filter="all">Искать среди всех клиентов</button>'
            : 'Попробуйте изменить поиск.</p>') +
          '</div>';
      return;
    }
    if (state.currentView === 'clients') {
      const rows = items
        .map((p) => {
          const last =
            p.lastVisit ||
            [...(p.visits || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
          const next = [...(p.appointments || [])]
            .filter((a) => actions.isActiveAppointment(a) && (a.date || '') >= today)
            .sort((a, b) =>
              `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`),
            )[0];
          const displayedName =
            (state.patientSort === 'last'
              ? actions.patientNameParts(p).lastFirst
              : actions.patientFullName(p)) || actions.formatPhone(p.phone);
          return [
            `<div class="patient-row client-list-row ${p.id === state.selectedId ? 'active' : ''}">`,
            `<button type="button" class="person-cell client-open-patient" data-patient="${actions.esc(p.id)}" aria-label="Открыть карточку: ${actions.esc(displayedName || 'Имя не указано')}">`,
            `<span class="avatar" data-client-color="${avatarColor(p.id)}">${actions.esc(actions.initials(p.name))}</span>`,
            `<span>`,
            `<strong>${actions.esc(displayedName || 'Имя не указано')}</strong>${actions.patientDesignationHtml(p)}<small>${actions.countVisits(p)} ${actions.plural(actions.countVisits(p), 'посещение', 'посещения', 'посещений')}</small>`,
            state.multiUser
              ? `<small class="client-inline-phone">${actions.esc(actions.formatPhone(p.phone) || 'Телефон не указан')}</small>`
              : '',
            `</span>`,
            `</button>`,
            `<span class="client-list-cell client-list-phone">${actions.esc(actions.formatPhone(p.phone) || 'Телефон не указан')}</span>`,
            `<span class="client-list-cell client-list-last">${last ? `${actions.esc(actions.formatDate(last.date))}<small>${actions.esc(last.procedure || 'Посещение')}</small>` : 'Посещений нет'}</span>`,
            `<span class="client-list-cell client-list-next">${
              next
                ? [
                    `<span class="client-next">${actions.esc(actions.formatDate(next.date))}, ${actions.esc(next.time || '')}</span>`,
                    `<small>${actions.esc(next.service || 'Запись')}</small>`,
                  ].join('')
                : 'Записи нет'
            }</span>`,
            actions.clientContactActionsHtml(p),
            `</div>`,
          ].join('');
        })
        .join('');
      actions.$('#patient-list').innerHTML = [
        `<div class="patient-list-head">`,
        `<span>Клиент</span>`,
        `<span>Телефон</span>`,
        `<span>Последний визит</span>`,
        `<span>Ближайшая запись</span>`,
        `<span>`,
        `</span>`,
        `</div>${rows}${tail}`,
      ].join('');
      return;
    }
    actions.$('#patient-list').innerHTML =
      items
        .map((p) =>
          [
            `<button class="patient-row search-result-row ${p.id === state.selectedId ? 'active' : ''}" `,
            `data-patient="${actions.esc(p.id)}">`,
            `<span class="avatar">${actions.esc(actions.initials(p.name))}</span>`,
            `<span>`,
            `<strong>${actions.esc(p.name || actions.formatPhone(p.phone) || 'Имя не указано')}</strong>${actions.patientDesignationHtml(p)}<small>${actions.esc(actions.formatPhone(p.phone) || 'Телефон не указан')}</small>`,
            `</span>`,
            `<span class="client-chevron" `,
            `aria-hidden="true">›</span>`,
            `</button>`,
          ].join(''),
        )
        .join('') + tail;
  }
  function openPatientForm(p = null) {
    if (p && !actions.canEditPatient()) {
      actions.toast('Изменять основные сведения может владелец или администратор');
      return;
    }
    state.editorMode = { kind: 'patient', id: p?.id || null };
    actions.$('#dialog-title').textContent = p ? 'Редактировать карточку' : 'Новый клиент';
    actions.$('#form-content').innerHTML = [
      `<div class="form-grid">${actions.patientFieldsHtml(p)}<label class="field">Телефон<input name="phone" `,
      `type="tel" inputmode="tel" autocomplete="tel" data-patient-phone `,
      `placeholder="+7 (___) ___-__-__" `,
      `value="${actions.esc(actions.formatPhone(p?.phone || ''))}">`,
      `</label>`,
      `<label class="field">Дата рождения (необязательно)<input name="birth" `,
      `type="date" `,
      `value="${actions.esc(p?.birth || '')}">`,
      `</label>`,
      `<label class="field full">Важная информация<textarea name="allergies">${actions.esc(p?.allergies || '')}</textarea>`,
      `</label>`,
      `<label class="field full">Заметки<textarea name="notes">${actions.esc(p?.notes || '')}</textarea>`,
      `</label>`,
      `</div>`,
    ].join('');
    actions.openDialog();
  }
  return { patient, countVisits, renderList, flushClientList, openPatientForm };
}
