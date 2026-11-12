function initializeMaxSetup() {
  const csrf = document.querySelector('meta[name="cartoteca-setup"]').content;
  const form = document.querySelector('#setup-form');
  const tokenInput = document.querySelector('#token');
  const save = document.querySelector('#save');
  const verify = document.querySelector('#verify');
  const result = document.querySelector('#result');
  let saved = false,
    busy = false,
    preview = null,
    firstChannel = '';
  async function request(route, values = {}) {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cartoteca-setup': csrf },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(values),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Операция не завершена.');
    return value;
  }
  function render(value) {
    saved = value.saved;
    const state = document.querySelector('#state');
    state.textContent = value.label;
    state.dataset.state = value.state;
    document.querySelector('#nickname').textContent = '@' + value.nickname;
    verify.disabled = busy || !saved;
    if (value.preview) {
      preview = value.preview;
      for (const channel of ['telegram', 'max'])
        document.querySelector('#' + channel + '-preview').textContent = preview[channel];
    }
  }
  async function action(work) {
    if (busy) return;
    busy = true;
    save.disabled = true;
    verify.disabled = true;
    result.textContent = 'Подождите…';
    try {
      await work();
    } catch (error) {
      result.textContent = error.message;
      try {
        render(await request('/state'));
      } catch {
        /* The timed-out window stays closed. */
      }
    } finally {
      busy = false;
      save.disabled = false;
      verify.disabled = !saved;
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !tokenInput.value.trim()) return;
    if (saved && !window.confirm('Заменить сохранённый токен MAX? Рассылка останется выключенной.'))
      return;
    const token = tokenInput.value.trim();
    tokenInput.value = '';
    void action(async () => {
      render(await request('/save', { token, replace: saved }));
      result.textContent =
        'Токен сохранён зашифрованно. Теперь можно проверить, что это нужный бот.';
    });
  });
  verify.addEventListener('click', () => {
    void action(async () => {
      render(await request('/verify'));
      result.textContent =
        'Бот «Картотека» проверен. Сообщения не отправлялись; подключение сайта ещё не включено.';
    });
  });
  for (const button of document.querySelectorAll('[data-preview]'))
    button.addEventListener('click', () => {
      if (!preview) return;
      const channel = button.dataset.preview;
      document.querySelector('#preview-result').textContent = firstChannel
        ? preview.repeated + ' Первый канал: ' + firstChannel + '.'
        : preview.confirmed + ' Первый канал: ' + channel + '.';
      firstChannel ||= channel;
    });
  document.querySelector('#preview-reset').addEventListener('click', () => {
    firstChannel = '';
    document.querySelector('#preview-result').textContent = '';
  });
  window.addEventListener('pagehide', () => {
    tokenInput.value = '';
  });
  void request('/state')
    .then(render)
    .catch(() => {
      result.textContent = 'Окно недоступно или истекли 30 минут. Откройте его заново.';
    });
}
initializeMaxSetup();
