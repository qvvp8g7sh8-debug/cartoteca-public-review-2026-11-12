function createAdminVoiceBehaviorEditor({ root, view, requestId, onChange, status }) {
  let examples = [],
    limits = null,
    editing = null;
  const importedSources = new Map();
  const find = (selector) => root.querySelector(selector);
  const form = () => find('[data-behavior-rules]');
  const selection = () => form()?.elements.exampleSelection?.value || 'manual';
  function list() {
    const automatic = selection() === 'automatic',
      count = examples.filter((item) => item.enabled).length;
    find('[data-behavior-examples]').innerHTML = view.examples(examples, selection());
    find('[data-behavior-count]').textContent = automatic
      ? count +
        ' доступных пользовательских кандидатов из ' +
        examples.length +
        '; до ' +
        limits.maxEnabledExamples +
        ' примеров на один запрос, вместе со встроенным каталогом.'
      : examples.length + ' примеров, включено ' + count + ' из ' + limits.maxEnabledExamples + '.';
    find('[data-behavior-add]').disabled = examples.length >= limits.maxExamples;
  }
  function render(data) {
    limits = data.limits;
    examples = data.rules.examples.map((item) => ({ ...item, expected: { ...item.expected } }));
    editing = null;
    root.innerHTML = view.rules(data);
    find('[data-behavior-provider]').textContent = view.provider(data);
    list();
  }
  function change() {
    form().dataset.dirty = '1';
    onChange();
  }
  function cancelExample() {
    editing = null;
    find('[data-behavior-example-editor]').textContent = '';
  }
  function syncIntent() {
    const editor = find('[data-behavior-example]');
    if (!editor) return;
    const allowed = view.applicable[editor.elements.intent.value];
    editor.querySelectorAll('[data-behavior-output]').forEach((node) => {
      node.hidden = !allowed.includes(node.dataset.behaviorOutput);
      node.querySelector('input,select').disabled = node.hidden;
    });
  }
  function openExample(value) {
    if (
      find('[data-behavior-example][data-dirty]') &&
      !confirm('Отменить несохранённое редактирование примера?')
    )
      return;
    editing = value.id || '';
    find('[data-behavior-example-editor]').innerHTML = view.exampleForm(value, limits, selection());
    syncIntent();
    find('[data-behavior-example] textarea').focus();
  }
  function allowedEnabled(item, replacedId = null) {
    const maximum =
      selection() === 'automatic'
        ? limits.maxCandidateExamples || limits.maxExamples
        : limits.maxEnabledExamples;
    if (
      item.enabled &&
      examples.filter((value) => value.enabled && value.id !== replacedId).length >= maximum
    )
      throw Error(
        selection() === 'automatic'
          ? 'В автоматический отбор можно включить не более ' +
              maximum +
              ' пользовательских примеров.'
          : 'В запросы к модели можно включить не более ' + maximum + ' примеров.',
      );
  }
  function saveExample(editor) {
    if (!editor.reportValidity()) return;
    const values = new FormData(editor),
      expected = { intent: values.get('intent') };
    for (const key of view.applicable[expected.intent]) {
      const value = String(values.get(key) || '').trim();
      if (value) expected[key] = key === 'duration' ? Number(value) : value;
    }
    const item = {
      id: editing || requestId(),
      text: values.get('text').trim(),
      referenceDate: values.get('referenceDate'),
      referenceTime: values.get('referenceTime'),
      enabled: values.has('enabled'),
      expected,
    };
    if (!item.text) throw Error('Введите непустую фразу пользователя.');
    allowedEnabled(item, editing);
    if (editing) examples = examples.map((value) => (value.id === editing ? item : value));
    else {
      if (examples.length >= limits.maxExamples)
        throw Error('Достигнуто максимальное число примеров.');
      examples.push(item);
    }
    cancelExample();
    list();
    change();
    status('Пример изменён только в локальном черновике.');
  }
  function click(event) {
    if (!form() || form().querySelector('fieldset').disabled) return;
    const button = event.target.closest(
      '[data-behavior-add],[data-behavior-edit],[data-behavior-remove],[data-behavior-cancel-example]',
    );
    if (!button) return;
    if (button.hasAttribute('data-behavior-add')) {
      if (examples.length >= limits.maxExamples) return;
      const now = new Date();
      openExample({
        referenceDate:
          now.getFullYear() +
          '-' +
          String(now.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(now.getDate()).padStart(2, '0'),
        referenceTime:
          String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        enabled: false,
      });
    } else if (button.hasAttribute('data-behavior-edit')) {
      const item = examples.find((value) => value.id === button.dataset.behaviorEdit);
      if (item) openExample(item);
    } else if (button.hasAttribute('data-behavior-remove')) {
      const id = button.dataset.behaviorRemove;
      if (editing === id) cancelExample();
      examples = examples.filter((value) => value.id !== id);
      list();
      change();
    } else cancelExample();
  }
  function importCases(items) {
    if (find('[data-behavior-example]'))
      throw Error(
        'Примените к черновику или отмените редактируемый пример перед добавлением из библиотеки.',
      );
    const signature = (value) =>
      JSON.stringify([
        value.text.trim(),
        value.referenceDate,
        value.referenceTime,
        Object.entries(value.expected).sort(([left], [right]) => left.localeCompare(right)),
      ]);
    const known = new Map(examples.map((item) => [signature(item), item.id]));
    const additions = [],
      sources = [];
    for (const item of items) {
      const context = item.context || item;
      if (
        !(
          ['supported', 'manual'].includes(item.current?.status) ||
          (item.current?.status === 'needs_clarification' &&
            item.current?.intent?.intent === 'prepareAppointment')
        ) ||
        !Object.hasOwn(view.intents, item.current?.intent?.intent)
      )
        throw Error('Этот справочный сценарий пока нельзя использовать как действующее действие.');
      const value = {
        id: '',
        text: item.text.trim(),
        referenceDate: context.referenceDate,
        referenceTime: context.referenceTime,
        enabled: false,
        expected: { ...item.current.intent },
      };
      const sourceId = importedSources.get(item.id);
      const existing =
        sourceId && examples.some((entry) => entry.id === sourceId)
          ? sourceId
          : known.get(signature(value));
      if (existing) {
        sources.push([item.id, existing]);
        continue;
      }
      value.id = requestId();
      known.set(signature(value), value.id);
      sources.push([item.id, value.id]);
      additions.push(value);
    }
    if (examples.length + additions.length > limits.maxExamples)
      throw Error(
        'В черновике осталось мест: ' +
          (limits.maxExamples - examples.length) +
          '. Выберите меньше примеров или удалите ненужные; пакет не добавлен.',
      );
    for (const [sourceId, exampleId] of sources) importedSources.set(sourceId, exampleId);
    if (additions.length) {
      examples.push(...additions);
      list();
      change();
    }
    return { added: additions.length, existing: items.length - additions.length };
  }
  function bind() {
    root.addEventListener('click', click);
    root.addEventListener('submit', (event) => {
      const editor = event.target.closest('[data-behavior-example]');
      if (!editor) return;
      event.preventDefault();
      try {
        saveExample(editor);
      } catch (error) {
        status(error.message, true);
      }
    });
    root.addEventListener('input', (event) => {
      const target = event.target.closest('[data-behavior-rules],[data-behavior-example]');
      if (target) {
        target.dataset.dirty = '1';
        onChange();
      }
    });
    root.addEventListener('change', (event) => {
      const target = event.target.closest('[data-behavior-rules],[data-behavior-example]');
      if (!target) return;
      target.dataset.dirty = '1';
      onChange();
      if (event.target.name === 'intent') syncIntent();
      if (event.target.name === 'exampleSelection') {
        list();
        const label = find('[data-behavior-enabled-label]');
        if (label) label.textContent = view.enabledLabel(selection());
      }
      if (event.target.hasAttribute('data-behavior-enabled')) {
        const item = examples.find((value) => value.id === event.target.dataset.behaviorEnabled);
        if (!item) return;
        try {
          allowedEnabled({ enabled: event.target.checked }, item.id);
          item.enabled = event.target.checked;
        } catch (error) {
          event.target.checked = item.enabled;
          status(error.message, true);
        }
        list();
      }
    });
  }
  function rules() {
    if (find('[data-behavior-example]'))
      throw Error('Примените к черновику или отмените редактируемый пример.');
    const values = new FormData(form());
    if (
      selection() === 'manual' &&
      examples.filter((item) => item.enabled).length > limits.maxEnabledExamples
    )
      throw Error(
        'Для фиксированного набора оставьте не более ' +
          limits.maxEnabledExamples +
          ' включённых примеров. Черновик сохранён.',
      );
    return {
      exampleSelection: selection(),
      instructions: values.get('instructions'),
      dictionary: values.get('dictionary'),
      examples: examples.map((item) => ({ ...item, expected: { ...item.expected } })),
    };
  }
  return { render, bind, rules, importCases };
}
