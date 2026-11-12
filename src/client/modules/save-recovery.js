function createSaveRecovery(state, actions) {
  function openSaveRecovery() {
    if (!actions.cabinetSaveStatus() || actions.$('#editor').open) return;
    state.editorMode = { kind: 'saveRecovery' };
    actions.$('#dialog-title').textContent = 'Проверка сохранения';
    actions.$('#form-content').textContent =
      'Проверьте результат предыдущего сохранения перед новым изменением. После обновления страницы сохраняется только номер операции, без содержимого формы.';
    actions.openDialog();
  }
  function renderSaveRecovery() {
    const stage = actions.cabinetSaveStatus();
    if (!stage) return;
    const root = actions.$('#form-error');
    root.textContent =
      stage === 'retry'
        ? 'Сервер пока не подтвердил сохранение. Повторная отправка использует первоначальные данные и тот же номер операции.'
        : stage === 'review'
          ? 'Результат требует проверки. Загрузите актуальные сведения перед следующим изменением.'
          : 'Ответ на сохранение не получен. Сначала проверьте результат — повторная отправка автоматически не выполняется.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset.saveRecovery = stage;
    button.textContent =
      stage === 'retry'
        ? 'Повторить сохранение'
        : stage === 'review'
          ? 'Загрузить актуальные данные'
          : 'Проверить сохранение';
    root.append(document.createElement('br'), button);
    actions.$('#form-content').inert = true;
    actions.$('#save-editor').disabled = true;
  }
  function bindSaveRecoveryEvents() {
    const dialog = actions.$('#editor');
    dialog.addEventListener('close', () => {
      if (state.editorMode && !dialog.open) actions.closeEditor();
    });
    document.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-save-recovery]');
      if (!button) return;
      e.stopImmediatePropagation();
      if (state.busy) return;
      const acceptCurrent = button.dataset.saveRecovery === 'review';
      if (
        acceptCurrent &&
        !window.confirm(
          'Закрыть сохранённый черновик и загрузить актуальные данные с сервера? Проверьте результат перед новым изменением.',
        )
      )
        return;
      const account = state.account,
        editor = state.editorMode;
      state.busy = true;
      button.disabled = true;
      try {
        const result = await actions.recoverCabinetSave({
          retry: button.dataset.saveRecovery === 'retry',
          acceptCurrent,
        });
        if (state.account !== account || state.editorMode !== editor) return;
        if (result.reload) {
          window.location.reload();
          return;
        }
        if (result.status === 'saved' || (acceptCurrent && result.status === 'review')) {
          if (!actions.restoreAppointmentEditor()) {
            actions.closeEditor();
            actions.setView(state.currentView);
          }
          actions.toast(
            result.status === 'saved'
              ? 'Сохранение подтверждено'
              : 'Актуальные данные загружены. Проверьте результат.',
          );
        } else actions.renderSaveRecovery();
      } catch (error) {
        if (state.account === account && state.editorMode === editor) {
          actions.renderSaveRecovery();
          const message = document.createElement('span');
          message.textContent = ' ' + error.message;
          actions.$('#form-error').append(message);
        }
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
        actions.updatePhotoSaveButton();
      }
    });
  }
  return { renderSaveRecovery, bindSaveRecoveryEvents, openSaveRecovery };
}
