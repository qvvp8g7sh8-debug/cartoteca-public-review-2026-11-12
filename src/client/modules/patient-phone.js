// Progressive phone mask for the client card editor; source data is changed only on save.
function createPatientPhone(state, actions) {
  function maskedPhone(value) {
    const raw = String(value || '').trim(),
      text = actions.normalizePatientPhoneText(raw);
    if (text === null) return { value: raw, added: 0 };
    const digits = text.replace(/\D/g, '');
    if (!digits) return { value: text.startsWith('+') ? '+' : '', added: 0 };
    if (text.startsWith('+') && !digits.startsWith('7')) return { value: text, added: 0 };
    const prefix = text.startsWith('+') || (/^[78]/.test(digits) && digits.length !== 10),
      national = prefix ? digits.slice(1) : digits,
      groups = [
        national.slice(0, 3),
        national.slice(3, 6),
        national.slice(6, 8),
        national.slice(8),
      ];
    return {
      value:
        '+7' +
        (groups[0] ? ' (' + groups[0] + (groups[0].length === 3 ? ')' : '') : '') +
        (groups[1] ? ' ' + groups[1] : '') +
        (groups[2] ? '-' + groups[2] : '') +
        (groups[3] ? '-' + groups[3] : ''),
      added: prefix ? 0 : 1,
    };
  }
  function bindPatientPhoneEvents() {
    const root = actions.$('#form-content'),
      isPhone = (input) => input?.matches?.('input[data-patient-phone]') && !input.disabled;
    function format(event) {
      const input = event.target;
      if (!isPhone(input) || event.isComposing) return;
      const raw = input.value,
        start = input.selectionStart ?? raw.length,
        end = input.selectionEnd ?? start,
        direction = input.selectionDirection || 'none',
        count = (position) => raw.slice(0, position).replace(/\D/g, '').length,
        formatted = maskedPhone(raw);
      if (formatted.value === raw) return;
      input.value = formatted.value;
      if (root.ownerDocument.activeElement !== input) return;
      const caret = (position) => {
        if (position === raw.length) return input.value.length;
        let remaining = count(position),
          index = 0;
        if (remaining) remaining += formatted.added;
        while (index < input.value.length && remaining > 0) {
          if (/\d/.test(input.value[index])) remaining--;
          index++;
        }
        return index;
      };
      input.setSelectionRange(caret(start), caret(end), direction);
    }
    function clearPrefix(event) {
      const input = event.target;
      if (isPhone(input) && /^\+7?$/.test(input.value.trim())) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    for (const type of ['input', 'change', 'compositionend']) root.addEventListener(type, format);
    root.addEventListener('focusout', clearPrefix);
    root.addEventListener('beforeinput', (event) => {
      const input = event.target;
      if (!isPhone(input) || event.isComposing || input.selectionStart !== input.selectionEnd)
        return;
      const backward = event.inputType === 'deleteContentBackward';
      if (!backward && event.inputType !== 'deleteContentForward') return;
      const caret = input.selectionStart,
        adjacent = backward ? caret - 1 : caret;
      if (input.value === '+7' && backward) {
        event.preventDefault();
        clearPrefix(event);
        return;
      }
      if (adjacent < 0 || adjacent >= input.value.length) return;
      let edge = adjacent;
      while (edge >= 0 && edge < input.value.length && !/\d/.test(input.value[edge]))
        edge += backward ? -1 : 1;
      // Keep the domestic country prefix while editing; select-all still clears the field.
      if (input.value.startsWith('+7') && edge <= 1) {
        event.preventDefault();
        const start = Math.min(4, input.value.length);
        input.setSelectionRange(start, start);
      } else if (edge >= 0 && edge < input.value.length && edge !== adjacent)
        input.setSelectionRange(backward ? edge : caret, backward ? caret : edge + 1);
    });
  }
  return { bindPatientPhoneEvents };
}
