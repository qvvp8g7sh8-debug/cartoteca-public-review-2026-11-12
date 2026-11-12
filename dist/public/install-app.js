// Generated from src/client/pwa/install-app.js. Edit the source file.
(() => {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;

  const agent = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(agent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(agent);
  const embedded = /FBAN|FBAV|Instagram|Line\/|Telegram|VKClient|wv\)/i.test(agent);
  if (!ios && !android) return;

  let promptEvent = null;
  const root = document.createElement('section');
  root.className = 'install-app';
  root.setAttribute('aria-label', 'Установка Картотеки');
  root.innerHTML = `
    <button class="install-app-close" type="button" aria-label="Закрыть">×</button>
    <span class="install-app-icon" aria-hidden="true">К</span>
    <span class="install-app-copy"><strong>Картотека на телефоне</strong><small>Открывайте как обычное приложение</small></span>
    <button class="install-app-action" type="button">Установить</button>
  `;

  const dialog = document.createElement('dialog');
  dialog.className = 'install-app-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <button class="install-app-dialog-close" value="close" aria-label="Закрыть">×</button>
      <span class="install-app-icon install-app-dialog-icon" aria-hidden="true">К</span>
      <h2>Установите Картотеку</h2>
      <p class="install-app-lead"></p>
      <ol class="install-app-steps"></ol>
      <button class="primary" value="close">Понятно</button>
    </form>
  `;

  function instructions() {
    const lead = dialog.querySelector('.install-app-lead');
    const steps = dialog.querySelector('.install-app-steps');
    if (embedded) {
      lead.textContent = 'Встроенный браузер не умеет устанавливать веб-приложения.';
      steps.innerHTML = ios
        ? '<li>Откройте меню этой страницы.</li><li>Выберите «Открыть в Safari».</li><li>В Safari нажмите «Поделиться» → «На экран Домой».</li>'
        : '<li>Откройте меню этой страницы.</li><li>Выберите «Открыть в Chrome».</li><li>В Chrome нажмите «Установить приложение».</li>';
    } else if (ios) {
      lead.textContent =
        'Иконка появится на экране «Домой» и будет открываться без панели браузера.';
      steps.innerHTML =
        '<li>Нажмите <strong>•••</strong> — меню страницы. Если внизу Safari уже есть отдельная кнопка «Поделиться», нажмите её сразу.</li><li>В меню нажмите <strong>«Поделиться»</strong>, затем выберите <strong>«На экран Домой»</strong>.</li><li>Включите «Открыть как веб-приложение» и нажмите <strong>«Добавить»</strong>.</li>';
    } else {
      lead.textContent = 'Если системное окно не появилось автоматически:';
      steps.innerHTML =
        '<li>Откройте меню браузера ⋮.</li><li>Выберите «Установить приложение» или «Добавить на главный экран».</li><li>Подтвердите установку.</li>';
    }
    dialog.showModal();
  }

  root.querySelector('.install-app-close').addEventListener('click', () => {
    root.remove();
    try {
      localStorage.setItem('cartoteca-install-dismissed', String(Date.now()));
    } catch {}
  });
  root.querySelector('.install-app-action').addEventListener('click', async () => {
    if (!promptEvent) return instructions();
    promptEvent.prompt();
    await promptEvent.userChoice;
    promptEvent = null;
    root.remove();
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    promptEvent = event;
    root.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    root.remove();
    dialog.remove();
  });

  let dismissedAt = 0;
  try {
    dismissedAt = Number(localStorage.getItem('cartoteca-install-dismissed')) || 0;
  } catch {}
  if (Date.now() - dismissedAt < 14 * 24 * 60 * 60 * 1000) return;
  root.hidden = android && !embedded;
  document.body.append(root, dialog);
  if (android && !embedded) setTimeout(() => (root.hidden = false), 1800);
})();

if ('serviceWorker' in navigator && window.isSecureContext)
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'));
