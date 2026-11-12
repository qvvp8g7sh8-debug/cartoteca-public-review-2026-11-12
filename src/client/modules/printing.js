function createPrinting(state, actions) {
  function printablePatient() {
    return state.currentView === 'card' ||
      (state.currentView === 'clients' && !state.mobileScreen?.matches)
      ? actions.patient()
      : null;
  }
  function invalidatePrint() {
    state.printGeneration++;
    state.printJob?.abort();
    const root = actions.$('#patient-print');
    root.replaceChildren();
    delete root.dataset.patientId;
  }
  function printElement(tag, text = undefined, className = undefined) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function printField(parent, label, value) {
    const field = actions.printElement('div', undefined, 'print-field');
    field.append(
      actions.printElement('h3', label),
      actions.printElement(
        'p',
        value === undefined || value === null || value === '' ? 'Не указано' : String(value),
      ),
    );
    parent.append(field);
  }
  function printServiceItems(parent, items) {
    const table = actions.printElement('table', undefined, 'print-services'),
      head = actions.printElement('thead'),
      tr = actions.printElement('tr');
    for (const title of ['Услуга', 'Группа', 'Время', 'Цена по каталогу']) {
      const th = actions.printElement('th', title);
      th.scope = 'col';
      tr.append(th);
    }
    head.append(tr);
    table.append(head);
    const body = actions.printElement('tbody');
    for (const item of items) {
      const row = actions.printElement('tr', undefined, 'print-service-row');
      const category =
        item.categoryTitle ||
        state.SERVICE_CATEGORIES?.find((c) => c.id === item.category)?.title ||
        state.LEGACY_SERVICE_CATEGORIES?.find((c) => c.id === item.category)?.title ||
        item.category;
      for (const value of [
        item.name,
        category || '',
        actions.formatMinutes(item.duration),
        new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: 'RUB',
          maximumFractionDigits: 2,
        }).format(item.price),
      ])
        row.append(actions.printElement('td', value));
      body.append(row);
    }
    table.append(body);
    parent.append(table);
  }
  function printVisitMeta(parent, v, appointment) {
    const meta = actions.printElement('div', undefined, 'print-visit-meta');
    if (v.time) actions.printField(meta, 'Время', v.time);
    if (v.duration) actions.printField(meta, 'Длительность', actions.formatMinutes(v.duration));
    const staffId = v.staffId || appointment?.staffId;
    const staff =
      state.workspace?.members?.find((m) => m.accountId === staffId) ||
      state.teamAccess?.members?.find((m) => m.accountId === staffId);
    const name =
      staff?.displayName ||
      (staffId && staffId === state.account?.id ? state.account.displayName : '');
    if (staffId) actions.printField(meta, 'Специалист', name || 'Имя недоступно');
    // The linked appointment contains the planned room, not proof of the actual room.
    const roomId = v.roomId || appointment?.roomId;
    if (roomId)
      actions.printField(
        meta,
        v.roomId ? 'Кабинет' : 'Кабинет по записи',
        actions.roomName(roomId) || 'Название недоступно',
      );
    if (meta.children.length) parent.append(meta);
  }
  function buildPrintCard(p) {
    const root = actions.$('#patient-print');
    root.replaceChildren();
    root.dataset.patientId = p.id;
    root.append(
      actions.printElement('p', 'Карточка клиента', 'print-kicker'),
      actions.printElement('h1', p.name || 'Имя не указано'),
    );
    const profile = actions.printElement('section', undefined, 'print-profile'),
      contact = actions.printElement('div', undefined, 'print-contact');
    actions.printField(contact, 'Телефон', p.phone);
    actions.printField(contact, 'Дата рождения', p.birth ? actions.formatDate(p.birth) : '');
    profile.append(contact);
    if (p.allergies) actions.printField(profile, 'Важная информация', p.allergies);
    if (p.notes) actions.printField(profile, 'Заметки', p.notes);
    root.append(profile);
    root.append(actions.printElement('h2', 'История посещений'));
    const visits = [...(p.visits || [])].sort((a, b) =>
      ((b.date || '') + ' ' + (b.time || '')).localeCompare((a.date || '') + ' ' + (a.time || '')),
    );
    if (!visits.length) root.append(actions.printElement('p', 'Посещений пока нет.'));
    for (const v of visits) {
      const visit = actions.printElement('section', undefined, 'print-visit');
      const items = v.serviceItems || [],
        names = items.map((s) => s.name).join(' + ');
      visit.append(
        actions.printElement(
          'h2',
          actions.formatDate(v.date) +
            ' · ' +
            (items.length ? 'Посещение' : v.procedure || 'Посещение'),
        ),
      );
      const appointment = (p.appointments || []).find(
        (a) => a.id === v.appointmentId && a.status === 'completed' && a.completedVisitId === v.id,
      );
      printVisitMeta(visit, v, appointment);
      if (items.length) {
        if (v.procedure && v.procedure !== names) {
          const suffix = ' + ' + names;
          actions.printField(
            visit,
            'Ранее сохранённая услуга / описание',
            v.procedure.endsWith(suffix) ? v.procedure.slice(0, -suffix.length) : v.procedure,
          );
        }
        printServiceItems(visit, items);
      }
      for (const [key, label] of [
        ['notes', 'Результат и заметки'],
        ['recommendations', 'Рекомендации'],
      ]) {
        if (!v[key]) continue;
        actions.printField(visit, label, v[key]);
      }
      if (v.photos?.length) {
        visit.append(actions.printElement('h3', 'Фотографии'));
        let row;
        v.photos.forEach((ph, i) => {
          if (i % 3 === 0) {
            row = actions.printElement('div', undefined, 'print-photo-row');
            visit.append(row);
          }
          if (ph.caption?.length > 300) row.classList.add('print-photo-row-long');
          const figure = actions.printElement('figure', undefined, 'print-photo');
          const img = actions.printElement('img');
          img.alt = 'Фото ' + (i + 1);
          img.loading = 'eager';
          img.decoding = 'async';
          // Only the protected same-origin photo route is accepted. Text never becomes HTML.
          if (/^\/api\/photos\/[a-f0-9]{32}$/.test(ph.data)) {
            const source = actions.photoSource(ph.data);
            if (source) img.src = source;
          }
          figure.append(img, actions.printElement('figcaption', ph.caption || 'Фото ' + (i + 1)));
          row.append(figure);
        });
      }
      root.append(visit);
    }
    if (visits.some((v) => v.serviceItems?.length))
      root.append(
        actions.printElement(
          'p',
          'Цены указаны по сохранённому списку услуг и не подтверждают оплату.',
          'print-price-note',
        ),
      );
  }
  function waitPrintImage(img, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.removeEventListener('load', loaded);
        img.removeEventListener('error', failed);
        signal.removeEventListener('abort', failed);
        ok
          ? resolve()
          : reject(
              new Error(
                'Не удалось загрузить все фотографии. Проверьте соединение и повторите печать.',
              ),
            );
      };
      const loaded = () => finish(img.naturalWidth > 0),
        failed = () => finish(false);
      const timer = setTimeout(failed, 15000);
      img.addEventListener('load', loaded);
      img.addEventListener('error', failed);
      signal.addEventListener('abort', failed, { once: true });
      if (!img.getAttribute('src')) failed();
      else if (img.complete) loaded();
    });
  }
  async function printPatient() {
    const p = actions.printablePatient();
    if (!p || state.printJob) return;
    const job = new AbortController();
    state.printJob = job;
    const button = actions.$('#print-patient'),
      status = actions.$('#print-status');
    button.disabled = true;
    status.hidden = false;
    status.textContent = 'Готовим карточку к печати…';
    actions.buildPrintCard(p);
    const generation = state.printGeneration,
      selected = p.id,
      savedRevision = state.revision;
    try {
      await Promise.all(
        [...actions.$('#patient-print').querySelectorAll('img')].map((img) =>
          actions.waitPrintImage(img, job.signal),
        ),
      );
      if (
        generation !== state.printGeneration ||
        actions.printablePatient()?.id !== selected ||
        state.revision !== savedRevision
      )
        return;
      status.hidden = true;
      window.print();
      // Safari may return before its print sheet closes. Keep the DOM until the card changes.
    } catch (error) {
      if (generation === state.printGeneration) {
        status.textContent = error.message;
        status.hidden = false;
      }
    } finally {
      job.abort();
      if (state.printJob === job) state.printJob = null;
      if (button.isConnected) button.disabled = false;
    }
  }
  return {
    printablePatient,
    invalidatePrint,
    printElement,
    printField,
    buildPrintCard,
    waitPrintImage,
    printPatient,
  };
}
