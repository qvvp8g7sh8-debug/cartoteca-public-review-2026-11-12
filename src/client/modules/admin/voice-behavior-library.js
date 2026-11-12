function createAdminVoiceBehaviorLibrary({
  root,
  request,
  records,
  behaviorView,
  addCases,
  canEdit,
  onDenied,
}) {
  const view = createAdminVoiceBehaviorLibraryView({ records, behaviorView });
  const route = '/api/admin/voice-assistant/behavior/library';
  let snapshot = null,
    generation = 0,
    busy = false,
    initialized = false;
  const find = (selector) => root.querySelector(selector);
  function status(text, error = false) {
    const node = find('[data-library-status]');
    if (!node) return;
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  }
  function available() {
    if (!initialized) {
      root.innerHTML = view.shell();
      initialized = true;
    }
  }
  function clear() {
    generation++;
    busy = false;
    initialized = false;
    snapshot = null;
    root.textContent = '';
  }
  function lock(value) {
    root.querySelectorAll('button,input,select').forEach((item) => {
      item.disabled = value;
    });
    if (!value && snapshot) {
      find('[data-library-previous]').disabled = snapshot.offset <= 0;
      find('[data-library-next]').disabled =
        snapshot.offset + snapshot.cases.length >= snapshot.total;
    }
  }
  function filters(offset = 0) {
    const values = new FormData(find('[data-library-filter]'));
    const query = new URLSearchParams({ offset: String(offset), limit: '20' });
    for (const key of ['q', 'category', 'status']) {
      const value = String(values.get(key) || '').trim();
      if (value) query.set(key, value);
    }
    return query;
  }
  function render(data) {
    snapshot = data;
    const form = find('[data-library-filter]');
    form.elements.category.innerHTML = view.options(
      data.categories,
      form.elements.category.value,
      'Все темы',
    );
    form.elements.status.innerHTML = view.options(
      data.statuses,
      form.elements.status.value,
      'Все варианты',
    );
    find('[data-library-packs]').innerHTML = view.packs(data.packs || []);
    find('[data-library-coverage]').innerHTML = view.coverage(data.coverage);
    find('[data-library-cases]').innerHTML = view.cases(data.cases);
    find('[data-library-page]').textContent = data.total
      ? data.offset + 1 + '–' + (data.offset + data.cases.length) + ' из ' + data.total
      : '0 сценариев';
  }
  async function load(offset = 0) {
    if (busy || !initialized) return;
    const serial = ++generation;
    busy = true;
    const query = filters(offset);
    lock(true);
    status('Загружаем библиотеку сценариев…');
    try {
      const data = await request(route + '?' + query);
      if (serial !== generation || !initialized) return;
      render(data);
      status('Библиотека описывает возможности и ограничения кода. Модель и тесты не запускались.');
    } catch (error) {
      if (serial === generation && !onDenied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  function importCases(items) {
    if (!canEdit()) throw Error('Дождитесь завершения текущей операции с правилами.');
    if (items.some((item) => !view.importable(item)))
      throw Error('Пакет содержит сценарии, которые нельзя перенести в действующие примеры.');
    const result = addCases(items);
    status(
      result.added
        ? 'В черновик добавлено ' +
            result.added +
            ' примеров, все выключены. Проверьте их, выберите нужные и просмотрите изменения.'
        : 'Эти примеры уже есть в черновике.',
    );
  }
  async function addPack(id) {
    if (busy || !canEdit()) return;
    const serial = ++generation;
    busy = true;
    lock(true);
    status('Загружаем выбранный пакет в черновик…');
    try {
      const query = new URLSearchParams({ pack: id, limit: '40' });
      const data = await request(route + '?' + query);
      if (serial !== generation || !initialized) return;
      if (data.total !== data.cases.length)
        throw Error('Пакет слишком велик для одного добавления. Выберите отдельные примеры.');
      importCases(data.cases);
    } catch (error) {
      if (serial === generation && !onDenied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  root.addEventListener(
    'toggle',
    (event) => {
      if (event.target.matches('[data-library-panel]') && event.target.open && !snapshot)
        void load();
    },
    true,
  );
  root.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-library-filter]')) return;
    event.preventDefault();
    void load();
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-library-previous'))
      void load(Math.max(0, snapshot.offset - snapshot.limit));
    else if (button.hasAttribute('data-library-next')) void load(snapshot.offset + snapshot.limit);
    else if (button.hasAttribute('data-library-pack')) void addPack(button.dataset.libraryPack);
    else if (button.hasAttribute('data-library-import')) {
      const item = snapshot?.cases.find((value) => value.id === button.dataset.libraryImport);
      if (!item) return;
      try {
        importCases([item]);
      } catch (error) {
        status(error.message, true);
      }
    }
  });
  return { available, clear };
}
