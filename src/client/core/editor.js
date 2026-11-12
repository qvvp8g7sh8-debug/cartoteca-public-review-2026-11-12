function createEditor(state, actions) {
  let baseline = '',
    baselinePhotos = [],
    closing = false,
    touched = false,
    suspendedAppointment = null;
  function editorSnapshot() {
    const fields = [...actions.$('#form-content').querySelectorAll('input, select, textarea')]
      .filter((field) => !['button', 'submit'].includes(field.type))
      .map((field) => [
        field.dataset.creationField || field.name || field.id,
        field.value,
        field.checked,
        [...(field.files || [])].map((file) => [file.name, file.size, file.lastModified]),
      ]);
    return JSON.stringify([
      fields,
      state.editorMode?.serviceItems,
      (state.uploadItems || []).map((item) => [item.id, item.caption, item.name]),
    ]);
  }
  function editorHasChanges() {
    return Boolean(
      state.editorMode &&
      (baseline !== editorSnapshot() ||
        actions.photosPending() ||
        baselinePhotos.some((photo, i) => photo !== state.uploadItems[i])),
    );
  }
  async function requestEditorClose() {
    if (state.busy || closing) return;
    if (suspendedAppointment && actions.cabinetSaveStatus()) {
      actions.renderSaveRecovery();
      return;
    }
    const mode = state.editorMode;
    closing = true;
    try {
      if (
        editorHasChanges() &&
        !(await actions.confirmAction(
          'Закрыть форму?',
          'Несохранённые изменения будут потеряны.',
          'Закрыть без сохранения',
          'Продолжить',
          { preferCancel: true },
        ))
      )
        return;
      if (!state.busy && state.editorMode === mode && !restoreAppointmentEditor()) closeEditor();
    } finally {
      closing = false;
    }
  }
  function bindEditorCloseEvents() {
    const content = actions.$('#form-content');
    for (const type of ['input', 'change', 'click'])
      content.addEventListener(
        type,
        () => {
          touched = true;
        },
        true,
      );
    new window.MutationObserver(() => {
      if (state.editorMode && !touched) baseline = editorSnapshot();
    }).observe(content, { childList: true, subtree: true });
    actions.$('#editor').addEventListener('cancel', (event) => {
      event.preventDefault();
      void requestEditorClose();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!editorHasChanges() && !suspendedAppointment?.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
  function suspendAppointmentEditor() {
    if (state.busy || state.editorMode?.kind !== 'appointment' || suspendedAppointment)
      return false;
    const title = actions.$('#dialog-title'),
      save = actions.$('#save-editor'),
      tabs = actions.$('#calendar-creation-tabs');
    suspendedAppointment = {
      account: state.account,
      mode: state.editorMode,
      nodes: [...actions.$('#form-content').childNodes],
      title: title.textContent,
      titleHidden: title.hidden,
      closeHidden: actions.$('#close-editor').hidden,
      saveHidden: save.hidden,
      saveText: save.textContent,
      error: actions.$('#form-error').textContent,
      labelledBy: actions.$('#editor').getAttribute('aria-labelledby'),
      scrollTop: actions.$('#editor-form').scrollTop,
      tabs,
      baseline,
      baselinePhotos,
      touched,
      dirty: editorHasChanges(),
    };
    tabs?.remove();
    return true;
  }
  function restoreAppointmentEditor(createdId = '') {
    const saved = suspendedAppointment;
    if (!saved || state.editorMode?.kind !== 'service') return false;
    suspendedAppointment = null;
    if (saved.account !== state.account || !actions.$('#editor').open) return false;
    state.editorMode = saved.mode;
    const content = actions.$('#form-content'),
      title = actions.$('#dialog-title'),
      save = actions.$('#save-editor');
    content.replaceChildren(...saved.nodes);
    content.inert = false;
    title.textContent = saved.title;
    title.hidden = saved.titleHidden;
    if (saved.tabs) title.after(saved.tabs);
    actions.$('#close-editor').hidden = saved.closeHidden;
    save.hidden = saved.saveHidden;
    save.textContent = saved.saveText;
    actions.$('#form-error').textContent = saved.error;
    actions.$('#editor').dataset.editorKind = saved.mode.kind;
    actions.$('#editor').setAttribute('aria-labelledby', saved.labelledBy || 'dialog-title');
    actions.$('#editor-form').scrollTop = saved.scrollTop;
    baseline = saved.baseline;
    baselinePhotos = saved.baselinePhotos;
    touched = saved.touched;
    actions.mountAppointmentTimePicker?.();
    actions.refreshAppointmentServices(createdId);
    actions.updatePhotoSaveButton();
    return true;
  }
  function openDialog() {
    actions.cancelPhotoProcessing();
    actions.$('#form-error').textContent = '';
    actions.$('#form-content').inert = false;
    actions.$('#save-editor').hidden = [
      'appointmentOutcome',
      'appointmentActions',
      'patientMarkView',
    ].includes(state.editorMode?.kind);
    actions.mountServiceGroupControl();
    if (suspendedAppointment && state.editorMode?.kind === 'service') {
      actions.$('#dialog-title').hidden = false;
      actions.$('#close-editor').hidden = false;
      actions.$('#save-editor').textContent = 'Сохранить';
    } else {
      suspendedAppointment = null;
      actions.mountCalendarCreationTabs?.();
    }
    actions.mountAppointmentTimePicker?.();
    const d = actions.$('#editor');
    d.classList.toggle('editor-designed', Boolean(state.multiUser));
    d.dataset.editorKind = state.editorMode?.kind || '';
    d.setAttribute('aria-labelledby', 'dialog-title');
    if (!d.open) d.showModal();
    actions.renderSaveRecovery();
    actions.updatePhotoSaveButton();
    baseline = editorSnapshot();
    baselinePhotos = [...state.uploadItems];
    touched = false;
  }
  async function submit(e) {
    e.preventDefault();
    if (
      state.busy ||
      !state.editorMode ||
      ['appointmentOutcome', 'appointmentActions', 'patientMarkView'].includes(
        state.editorMode.kind,
      )
    )
      return;
    if (actions.photosPending()) {
      actions.$('#form-error').textContent = 'Дождитесь обработки фотографий перед сохранением.';
      return;
    }
    if (actions.cabinetSaveStatus()) {
      actions.renderSaveRecovery();
      return;
    }
    state.busy = true;
    actions.$('#save-editor').disabled = true;
    try {
      const f = new FormData(e.target),
        v = Object.fromEntries(f.entries());
      actions.$('#form-error').textContent = '';
      const commands = {
        workSchedule: actions.saveWorkScheduleForm,
        service: actions.saveServiceForm,
        appointment: actions.saveAppointmentForm,
        personalEvent: actions.savePersonalEventForm,
        patient: actions.savePatientForm,
        patientMark: actions.savePatientMarkForm,
        visit: actions.saveVisitForm,
      };
      const command = commands[state.editorMode.kind];
      if (!command) throw new Error('Неизвестный режим формы.');
      const task = command(v);
      // Synchronous validation must release the form before the next input event.
      if (task) await task;
    } catch (error) {
      actions.rollback();
      actions.$('#form-error').textContent = error.message;
      actions.renderSaveRecovery();
    } finally {
      state.busy = false;
      actions.updatePhotoSaveButton();
    }
  }
  function discardAssistantDraft() {
    const draft = state.assistantEditor;
    if (!draft) return;
    state.assistantEditor = null;
    if (state.editorMode === draft || suspendedAppointment?.mode === draft) closeEditor();
  }
  function closeEditor() {
    state.assistantEditor = null;
    suspendedAppointment = null;
    actions.cancelPhotoProcessing();
    const d = actions.$('#editor');
    if (d.open) d.close();
    actions.$('#save-editor').hidden = false;
    actions.$('#form-content').inert = false;
    state.editorMode = null;
    state.appointmentFromServices = false;
    state.uploadItems = [];
    actions.resetCalendarCreationTabs?.();
    baseline = '';
    baselinePhotos = [];
  }
  return {
    openDialog,
    submit,
    closeEditor,
    discardAssistantDraft,
    requestEditorClose,
    bindEditorCloseEvents,
    suspendAppointmentEditor,
    restoreAppointmentEditor,
  };
}
