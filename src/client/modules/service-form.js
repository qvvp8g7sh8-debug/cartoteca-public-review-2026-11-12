function createServiceForm(state, actions) {
  function openServiceForm(s = null, presetCategory = '', presetStaffId = '') {
    if (!actions.canEditServices()) {
      actions.toast('Изменять услуги может владелец или администратор');
      return;
    }
    const category = s ? actions.serviceCategory(s) : presetCategory || 'other';
    state.editorMode = {
      kind: 'service',
      id: s?.id || null,
      staffId: s ? actions.serviceOwnerId(s) : presetStaffId || actions.serviceStaffId(),
    };
    actions.$('#dialog-title').textContent = s ? 'Изменить услугу' : 'Новая услуга';
    actions.$('#form-content').innerHTML = [
      state.multiUser
        ? `<p class="form-hint">Каталог: <strong>${actions.esc(actions.serviceStaffLabel(state.editorMode.staffId))}</strong></p>`
        : '',
      `<div class="form-grid">
      <label class="field full">Название услуги<input name="name" required value="${actions.esc(s?.name || '')}" `,
      `placeholder="Например, консультация">`,
      `</label>
      <label class="field full">Группа (необязательно)<select name="category">${actions.categoryOptions(category)}</select>`,
      `</label>
      <label class="field full">Описание (необязательно)<textarea name="description" maxlength="2000">${actions.esc(s?.description || '')}</textarea></label>
      <label class="field">Длительность, минут<input name="duration" `,
      `type="number" `,
      `min="5" max="1440" `,
      `step="5" required value="${actions.esc(s ? actions.durationMinutes(s.duration) : 60)}">`,
      `</label>
      <label class="field">Стоимость, ₽<input name="price" `,
      `type="number" `,
      `min="0" `,
      `step="any" `,
      `inputmode="decimal" required value="${actions.esc(s?.price ?? '')}" `,
      `placeholder="Например, 3500">`,
      `</label>
      </div>`,
      `<p class="form-hint">Длительность используется при создании записи. При изменении существующей услуги приложение попросит подтвердить сохранение.</p>`,
    ].join('');
    actions.openDialog();
  }
  return { openServiceForm };
}
