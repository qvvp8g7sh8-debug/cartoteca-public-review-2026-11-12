function createPatientMark(state, actions) {
  const marks = {
    none: [
      'Убрать метку',
      '<circle class="mark-surface" cx="12" cy="12" r="5.5"/><path class="mark-highlight" d="M9 9.5a4 4 0 0 1 5-.5"/>',
    ],
    star: [
      'Важный клиент',
      '<path class="mark-surface" d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z"/><path class="mark-shade" d="m12 12 5.8 8.7-1.1-6.5 4.7-4.6-6.5-.9Z"/><path class="mark-highlight" d="m11.3 6.2-1.7 3.4-3.8.6"/>',
    ],
    attention: [
      'Обратить внимание',
      '<circle class="mark-surface" cx="12" cy="12" r="9"/><path class="mark-shade" d="M19.2 6.6A9 9 0 0 1 5.6 18.3 10.5 10.5 0 0 0 19.2 6.6Z"/><path class="mark-highlight" d="M6.6 8.2a6.4 6.4 0 0 1 6.7-2.5"/><path class="mark-glyph" d="M12 7v6"/><circle class="mark-symbol" cx="12" cy="16.8" r="1.2"/>',
    ],
    flag: [
      'Особая пометка',
      '<path class="mark-surface" d="M6.5 4.2c4.3-2.8 8.2 2.8 13 0v9c-4.8 2.8-8.7-2.8-13 0Z"/><path class="mark-shade" d="M13 5.1c2.2.7 4.2.7 6.5-.9v9c-2.3 1.6-4.3 1.6-6.5.9Z"/><path class="mark-highlight" d="M8.5 5.5c1.1-.2 2.1.1 3.1.5"/><path class="mark-glyph" d="M6.5 3v18m-2 0h4"/>',
    ],
  };
  let opened = null;
  const scope = (id) => JSON.stringify([state.account?.id, state.account?.organizationId, id]);
  const markOf = (patient) =>
    Object.hasOwn(marks, patient.clientMark) ? patient.clientMark : 'none';
  const icon = (mark) =>
    '<svg class="patient-mark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    marks[mark][1] +
    '</svg>';
  function patientMarkHtml(patient) {
    const mark = markOf(patient),
      label = mark === 'none' ? 'Метка не установлена' : marks[mark][0],
      note = mark === 'none' ? '' : String(patient.clientMarkNote || '').trim(),
      hint =
        label +
        (note ? ': ' + note : '') +
        '. ' +
        (actions.canEditPatient() ? 'Выбрать метку' : 'Посмотреть метку');
    return `<button type="button" class="patient-mark-button" data-patient-mark="${mark}" aria-label="${actions.esc(hint)}" title="${actions.esc(hint)}">${icon(mark)}</button>`;
  }
  function openPatientMark() {
    const patient = actions.patient();
    if (!patient || state.busy || state.editorMode) return;
    const editable = actions.canEditPatient(),
      mark = markOf(patient),
      note = String(patient.clientMarkNote || '');
    state.editorMode = {
      kind: editable ? 'patientMark' : 'patientMarkView',
      patientId: patient.id,
    };
    state.uploadItems = [];
    opened = { mode: state.editorMode, scope: scope(patient.id), mark, note };
    actions.$('#dialog-title').textContent = 'Метка клиента';
    actions.$('#form-content').innerHTML = editable
      ? '<fieldset class="patient-mark-picker"><legend>Выберите значок</legend><div class="patient-mark-options">' +
        Object.entries(marks)
          .map(
            ([value, [label]]) =>
              `<label class="patient-mark-option" data-mark-option="${value}" title="${label}"><input type="radio" name="clientMark" value="${value}" aria-label="${label}"${mark === value ? ' checked' : ''}><span>${icon(value)}</span></label>`,
          )
          .join('') +
        '</div><p class="form-hint" id="patient-mark-label">' +
        actions.esc(mark === 'none' ? 'Метка не установлена' : marks[mark][0]) +
        '</p></fieldset>' +
        '<label class="field">Короткое пояснение <span class="form-hint">Необязательно, до 200 символов</span>' +
        `<textarea name="clientMarkNote" maxlength="200" rows="3" placeholder="Например, предпочитает общение сообщениями"${mark === 'none' ? ' disabled' : ''}>${actions.esc(note)}</textarea></label>` +
        '<p class="form-hint">Метка видна только в карточке и не меняет записи или уведомления.</p>'
      : `<div class="patient-mark-readonly" data-mark-option="${mark}">${icon(mark)}<strong>${actions.esc(mark === 'none' ? 'Метка не установлена' : marks[mark][0])}</strong></div><p class="patient-mark-note">${actions.esc(mark === 'none' ? '' : note || 'Без пояснения')}</p><p class="form-hint">Метки изменяет владелец или администратор.</p>`;
    actions.openDialog();
  }
  function savePatientMarkForm(values) {
    if (
      !opened ||
      state.editorMode !== opened.mode ||
      state.editorMode.kind !== 'patientMark' ||
      scope(state.editorMode.patientId) !== opened.scope ||
      !actions.canEditPatient()
    ) {
      actions.$('#form-error').textContent =
        'Карточка или доступ изменились. Откройте метку заново.';
      return;
    }
    const patient = actions.patient();
    if (
      !patient ||
      patient.id !== state.editorMode.patientId ||
      markOf(patient) !== opened.mark ||
      String(patient.clientMarkNote || '') !== opened.note
    ) {
      actions.$('#form-error').textContent = 'Метка уже изменилась. Откройте карточку заново.';
      return;
    }
    const mark = String(values.clientMark || ''),
      note = String(values.clientMarkNote || '').trim();
    if (!Object.hasOwn(marks, mark) || note.length > 200) {
      actions.$('#form-error').textContent =
        'Выберите метку и сократите пояснение до 200 символов.';
      return;
    }
    return persistPatientMark(patient, mark, mark === 'none' ? '' : note);
  }
  async function persistPatientMark(patient, mark, note) {
    const expected = opened;
    patient.clientMark = mark;
    patient.clientMarkNote = note;
    await actions.save();
    if (state.editorMode !== expected.mode || scope(patient.id) !== expected.scope) return;
    actions.closeEditor();
    actions.renderDetail();
    actions.$('.patient-header [data-patient-mark]')?.focus({ preventScroll: true });
    actions.toast(mark === 'none' ? 'Метка убрана' : 'Метка сохранена');
  }
  function bindPatientMarkEvents() {
    document.addEventListener('click', (event) => {
      if (event.target.closest('.patient-header [data-patient-mark]')) openPatientMark();
    });
    document.addEventListener('change', (event) => {
      const input = event.target;
      if (
        state.busy ||
        state.editorMode?.kind !== 'patientMark' ||
        !input.matches('#form-content [name="clientMark"]')
      )
        return;
      if (!Object.hasOwn(marks, input.value)) return;
      actions.$('#form-content [name="clientMarkNote"]').disabled = input.value === 'none';
      actions.$('#patient-mark-label').textContent =
        input.value === 'none' ? 'Метка не установлена' : marks[input.value][0];
    });
  }
  return { patientMarkHtml, openPatientMark, savePatientMarkForm, bindPatientMarkEvents };
}
