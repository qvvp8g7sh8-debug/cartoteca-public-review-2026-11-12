function createVisitForm(state, actions) {
  function openVisitForm(v = null, appointment = null) {
    const p = actions.patient();
    if (!p) return;
    if (v?.id && !actions.canEditRecord(v)) {
      actions.toast('Сотрудник может изменять только свои посещения');
      return;
    }
    state.editorMode = {
      kind: 'visit',
      patientId: p.id,
      id: v?.id || null,
      appointmentId: appointment?.id || v?.appointmentId || null,
    };
    state.uploadItems = (v?.photos || []).map((x) => ({ ...x }));
    actions.$('#dialog-title').textContent = v?.id
      ? 'Изменить посещение'
      : appointment
        ? 'Оформить проведённое посещение'
        : 'Проведённое посещение без записи';
    actions.$('#form-content').innerHTML = [
      `<div class="form-grid visit-form-grid">${actions.staffField(appointment?.staffId || v?.staffId, Boolean(appointment || v?.appointmentId))}<label class="field">Дата<input name="date" `,
      `type="date" required value="${actions.esc(v?.date || actions.cabinetToday())}">`,
      `</label>`,
      `<label class="field">Время<input name="time" `,
      `type="time" `,
      `step="300" `,
      `value="${actions.esc(v?.time || '')}">`,
      `</label>`,
      `<label class="field visit-duration-field">Длительность, мин.<input name="duration" `,
      `type="number" `,
      `min="5" `,
      `max="1440" `,
      `step="5" `,
      `value="${actions.esc(v?.duration || '')}">`,
      `</label>`,
      `<div id="visit-procedures-field" `,
      `class="field full visit-procedures">`,
      `</div>`,
      `<label class="field full">Результат и заметки<textarea name="notes" `,
      `placeholder="Что важно помнить к следующему визиту">${actions.esc(v?.notes || '')}</textarea>`,
      `</label>`,
      `<label class="field full">Рекомендации<textarea name="recommendations" maxlength="20000">${actions.esc(v?.recommendations || '')}</textarea></label>`,
      `</div>`,
      `<section class="form-section visit-photo-section visit-photos" aria-labelledby="visit-photos-title">`,
      `<div class="visit-photos-heading"><div class="visit-photos-title">`,
      `<h3 id="visit-photos-title">Фотографии</h3><span id="photo-upload-count" aria-live="polite" aria-atomic="true"></span>`,
      `</div><label class="upload-label visit-photos-add">`,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">`,
      `<path d="M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8M3 16l5-5 5 5 3-3 4 4M19 2v6m-3-3h6"/>`,
      `<circle cx="8" cy="7" r="1"/></svg><span>Добавить фото</span><input id="photo-input" `,
      `type="file" `,
      `accept="image/jpeg,image/png,image/webp" multiple aria-label="Добавить фотографии" aria-describedby="photo-upload-help photo-upload-status">`,
      `</label></div>`,
      `<div id="photo-upload-empty" class="visit-photos-empty">`,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">`,
      `<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg>`,
      `<span>Фото до и после посещения</span></div>`,
      `<label class="visit-photos-batch" hidden><span>Все новые фото</span>`,
      `<select id="photo-batch-caption" aria-label="Отметка для всех новых фотографий">`,
      `<option value="" disabled selected>Выбрать отметку</option><option>До</option><option>После</option><option>Контроль</option>`,
      `</select></label>`,
      `<div id="upload-list" `,
      `class="upload-list" aria-label="Фотографии посещения"></div>`,
      `<p id="photo-upload-help" class="visit-photos-help">Можно выбрать несколько фото сразу. JPEG, PNG или WebP · до 10 МБ · не более 6 фото</p>`,
      `<p id="photo-upload-status" class="visit-photos-status" role="status" aria-live="polite" hidden></p>`,
      `</section>`,
    ].join('');
    actions.mountVisitProcedures(v, appointment);
    actions.renderUploads();
    actions.openDialog();
  }
  return { openVisitForm };
}
