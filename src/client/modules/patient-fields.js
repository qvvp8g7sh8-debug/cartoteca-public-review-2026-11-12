function createPatientFields(state, actions) {
  function patientFieldsHtml(patient = null, { appointment = false } = {}) {
    const parts = actions.patientNameParts(patient || {}),
      field = (key) => (appointment ? 'new' + key[0].toUpperCase() + key.slice(1) : key);
    const className = 'field' + (appointment ? ' appointment-new-field' : '');
    const attributes = appointment ? ' hidden' : '';
    const input = (label, key, value) =>
      [
        `<label class="${className}"${attributes}>${label}<input name="${field(key)}" `,
        `autocomplete="off" maxlength="${key === 'designation' ? 200 : 500}" ${key === 'designation' ? 'placeholder="Например: тренер по фитнесу, тётя" ' : ''}value="${actions.esc(value)}">`,
        `</label>`,
      ].join('');
    const hint =
      patient &&
      (patient.nameNeedsReview ||
        (!parts.structured &&
          String(patient.name || '')
            .trim()
            .split(/\s+/).length > 2))
        ? '<p class="form-hint full">Исходное ФИО сохранено без потерь. Уточните фамилию, имя и отчество, если они записаны вместе.</p>'
        : '';
    return (
      input('Фамилия', 'lastName', parts.last) +
      input('Имя', 'firstName', parts.first) +
      input('Отчество (необязательно)', 'middleName', parts.middle) +
      input('Обозначение (необязательно)', 'designation', patient?.designation || '') +
      hint
    );
  }
  function patientFormValues(values, { appointment = false } = {}) {
    const field = (key) => (appointment ? 'new' + key[0].toUpperCase() + key.slice(1) : key);
    const result = {
      firstName: String(values[field('firstName')] || '').trim(),
      lastName: String(values[field('lastName')] || '').trim(),
      middleName: String(values[field('middleName')] || '').trim(),
      designation: String(values[field('designation')] || '').trim(),
    };
    result.name = actions.patientFullName(result);
    result.nameNeedsReview = false;
    return result;
  }
  function patientDesignationHtml(patient) {
    return patient?.designation
      ? `<small class="patient-designation">${actions.esc(patient.designation)}</small>`
      : '';
  }
  return { patientFieldsHtml, patientFormValues, patientDesignationHtml };
}
