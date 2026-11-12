// Pure validation: no DOM, storage writes or changes to the editor state.
/** @param {unknown} state
 * @param {{hasPatientIdentity(values: import('../contracts/domain').FormValues): boolean}} actions */
function createFormValidation(state, actions) {
  /** @param {import('../contracts/domain').FormValues} values */
  function validateServiceValues(values) {
    if (!values.name.trim()) return 'Укажите название услуги.';
    const duration = Number(values.duration);
    if (!Number.isSafeInteger(duration) || duration < 5 || duration > 1440 || duration % 5)
      return 'Укажите длительность от 5 до 1440 минут с шагом 5 минут.';
    const price = Number(values.price);
    if (!Number.isFinite(price) || price < 0) return 'Укажите корректную стоимость.';
    return '';
  }
  /** @param {import('../contracts/domain').FormValues} values */
  function validateAppointmentValues(values) {
    if (!values.date || !/^([01]\d|2[0-3]):[0-5][05]$/.test(values.time))
      return 'Укажите другую дату и время записи с шагом 5 минут.';
    if (!values.service) return 'Выберите услугу.';
    const duration = Number(values.duration);
    if (!Number.isSafeInteger(duration) || duration > 1440 || duration < 5 || duration % 5)
      return 'Выберите длительность от 5 до 1440 минут с шагом 5 минут.';
    return '';
  }
  /** @param {import('../contracts/domain').FormValues} values */
  function validatePatientValues(values) {
    return actions.hasPatientIdentity(values)
      ? ''
      : 'Укажите ФИО, обозначение или полный номер телефона клиента.';
  }
  /** @param {import('../contracts/domain').FormValues} values */
  function validateVisitDuration(values) {
    const duration = Number(values.duration);
    if (
      values.duration &&
      (!Number.isSafeInteger(duration) || duration > 1440 || duration < 5 || duration % 5)
    )
      return 'Укажите длительность от 5 до 1440 минут с шагом 5 минут.';
    return '';
  }
  return {
    validateServiceValues,
    validateAppointmentValues,
    validatePatientValues,
    validateVisitDuration,
  };
}
