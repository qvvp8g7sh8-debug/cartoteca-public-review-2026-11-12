function createSettingsHelp(state, actions) {
  let opener = null;

  function settingsHelpHtml(title, text) {
    return [
      '<button type="button" class="settings-help-trigger" data-settings-help ',
      `data-help-title="${actions.esc(title)}" data-help-text="${actions.esc(text)}" `,
      `aria-label="Пояснение: ${actions.esc(title)}" `,
      'aria-haspopup="dialog" aria-controls="settings-help-dialog">',
      '<span aria-hidden="true">?</span></button>',
    ].join('');
  }

  function settingsHelpDialogHtml() {
    return [
      '<dialog id="settings-help-dialog" aria-labelledby="settings-help-title" ',
      'aria-describedby="settings-help-text">',
      '<div class="settings-help-heading"><h3 id="settings-help-title"></h3>',
      '<button type="button" class="settings-help-close" data-settings-help-close ',
      'aria-label="Закрыть пояснение" autofocus>×</button></div>',
      '<p id="settings-help-text"></p></dialog>',
    ].join('');
  }

  function settingsHelpDialog() {
    let dialog = actions.$('#settings-help-dialog');
    if (!dialog) {
      document.body.insertAdjacentHTML('beforeend', settingsHelpDialogHtml());
      dialog = actions.$('#settings-help-dialog');
    }
    return dialog;
  }

  function bindSettingsHelpEvents() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-settings-help]');
      if (button) {
        const dialog = settingsHelpDialog();
        opener = button;
        dialog.querySelector('#settings-help-title').textContent = button.dataset.helpTitle;
        dialog.querySelector('#settings-help-text').textContent = button.dataset.helpText;
        if (!dialog.open) dialog.showModal();
        return;
      }
      const dialog = actions.$('#settings-help-dialog');
      if (!dialog) return;
      if (event.target.closest('[data-settings-help-close]')) {
        dialog.close();
        return;
      }
    });
    // Native dialog handles Escape and traps focus; restore it after all close methods.
    document.addEventListener(
      'close',
      (event) => {
        if (event.target.id !== 'settings-help-dialog') return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        opener = null;
      },
      true,
    );
  }

  return { settingsHelpHtml, settingsHelpDialogHtml, bindSettingsHelpEvents };
}
