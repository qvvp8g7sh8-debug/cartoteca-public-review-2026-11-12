// Adapt existing controls; the picker does not invent scheduling or availability rules.
function createTimePickerSources(state) {
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
  const disabled = (node) => node.disabled || node.readOnly || node.matches(':disabled');
  const options = (node) =>
    [...node.options].filter((item) => !item.disabled).map((item) => item.value);
  const number = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  function timePickerSource(source) {
    const paired = source.matches('[data-work-time]');
    const hour = paired && source.querySelector('[data-work-hour]');
    const minute = paired && source.querySelector('[data-work-minute]');
    const input = source.matches('input[type="time"]');
    if (!paired && !input && source.tagName !== 'SELECT') return null;
    if (paired && (!hour || !minute)) return null;
    // Seconds cannot be represented losslessly by two hour/minute wheels.
    const inputClock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const inputStep = () => {
      const step = Number(source.step || 60);
      return source.step === 'any' || !Number.isFinite(step) || step <= 0 ? 60 : step;
    };
    if (input && ((source.value && !inputClock.test(source.value)) || inputStep() % 60))
      return null;
    const fiveMinute =
      source.matches('select[name="time"]') &&
      ['appointment', 'personalEvent'].includes(state.editorMode?.kind);
    const valid = (value) => clock.test(value) && (!fiveMinute || Number(value.slice(3)) % 5 === 0);
    const nodes = paired ? [hour, minute] : [source];
    const value = () =>
      paired
        ? hour.value
          ? hour.value + ':' + (hour.value === '24' ? '00' : minute.value)
          : ''
        : source.value;
    function values(keepCurrent = false) {
      let result;
      if (paired) {
        const mins = options(minute);
        result = options(hour).flatMap((part) =>
          /^\d{2}$/.test(part) && Number(part) <= 24
            ? (part === '24' ? ['00'] : mins).map((m) => part + ':' + m)
            : [],
        );
      } else if (input) {
        const min = inputClock.test(source.min) ? number(source.min) : 0;
        const max = inputClock.test(source.max) ? number(source.max) : 1439;
        const step = inputStep();
        const base = inputClock.test(source.min)
          ? min
          : inputClock.test(source.getAttribute('value') || '')
            ? number(source.getAttribute('value'))
            : 0;
        result = Array.from({ length: 1440 }, (_, n) => n)
          .filter(
            (n) =>
              (min <= max ? n >= min && n <= max : n >= min || n <= max) &&
              step > 0 &&
              ((((n - base) * 60) % step) + step) % step === 0,
          )
          .map(
            (n) =>
              String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'),
          );
      } else result = options(source).filter(valid);
      const current = value();
      if (keepCurrent && valid(current) && !result.includes(current)) result.push(current);
      return result;
    }
    return {
      source,
      nodes,
      value,
      values,
      allowEmpty: input && !source.required,
      label: paired
        ? (hour.getAttribute('aria-label') || 'Время').replace('Часы', 'Время')
        : source.getAttribute('aria-label') || 'Время',
      connected: () => source.isConnected && nodes.every((node) => node.isConnected),
      enabled: () => !disabled(paired ? hour : source),
      set(next) {
        if (!paired) source.value = next;
        else {
          hour.value = next.slice(0, 2);
          minute.value = next.slice(3);
          source.querySelector('input').value = next;
        }
      },
      notify(previous) {
        const target = paired ? (previous.slice(0, 2) !== hour.value ? hour : minute) : source;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      },
    };
  }
  return { timePickerSource };
}
