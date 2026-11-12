function createTimePickerView() {
  function timePickerFieldHtml(allowEmpty = false) {
    return [
      '<button type="button" class="time-picker-trigger" data-time-dropdown aria-haspopup="dialog" aria-expanded="false"><span data-time-value>—</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 4 3 3 3-3"/></svg></button>',
      allowEmpty
        ? '<button type="button" class="time-picker-clear" data-time-picker-clear aria-label="Не указывать время" title="Не указывать время"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>'
        : '',
      '<div class="time-picker-popup" data-time-popup popover="manual" role="dialog" tabindex="-1" hidden>',
      '<div class="time-picker-options" data-time-options role="listbox" tabindex="0" aria-label="Время"></div>',
      '<p class="time-picker-empty" data-time-empty role="status" hidden>Нет доступного времени</p></div>',
    ].join('');
  }
  return { timePickerFieldHtml };
}
