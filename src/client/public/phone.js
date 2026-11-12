// Domestic numbers use +7; an explicit foreign country code is kept intact.
function formatPublicBookingPhone(value) {
  const raw = String(value).trim(),
    digits = raw.replace(/\D/g, '');
  if (!digits) return { value: raw.startsWith('+') ? '+' : '', added: 0 };
  if (raw.startsWith('+') && !digits.startsWith('7')) return { value: '+' + digits, added: 0 };
  const prefix = raw.startsWith('+') || (/^[78]/.test(digits) && digits.length !== 10);
  const national = prefix ? digits.slice(1) : digits;
  const groups = [
    national.slice(0, 3),
    national.slice(3, 6),
    national.slice(6, 8),
    national.slice(8),
  ];
  return {
    value:
      '+7' +
      (groups[0] ? ' ' + groups[0] : '') +
      (groups[1] ? ' ' + groups[1] : '') +
      (groups[2] ? '-' + groups[2] : '') +
      (groups[3] ? '-' + groups[3] : ''),
    added: prefix ? 0 : 1,
  };
}

function bindPublicBookingPhone(root) {
  const isPhone = (target) => target?.matches?.('#booking-contact-form input[name="phone"]');
  function format(event) {
    const input = event.target;
    if (!isPhone(input) || input.disabled || event.isComposing) return;
    const position = input.selectionStart ?? input.value.length;
    const count = input.value.slice(0, position).replace(/\D/g, '').length;
    const formatted = formatPublicBookingPhone(input.value);
    input.value = formatted.value;
    if (root.ownerDocument.activeElement === input) {
      let remaining = count + formatted.added,
        caret = 0;
      while (caret < input.value.length && remaining > 0) {
        if (/\d/.test(input.value[caret])) remaining--;
        caret++;
      }
      input.setSelectionRange(caret, caret);
    }
    const digits = input.value.replace(/\D/g, '');
    const valid = input.value.startsWith('+7') ? digits.length === 11 : /^\d{10,15}$/.test(digits);
    input.setCustomValidity(
      !input.value || valid ? '' : 'Введите номер полностью, например +7 999 123-45-67.',
    );
  }
  root.addEventListener('input', format);
  root.addEventListener('change', format); // Autofill may emit change rather than input.
  root.addEventListener('beforeinput', (event) => {
    const input = event.target;
    if (!isPhone(input) || input.disabled || input.selectionStart !== input.selectionEnd) return;
    const backward = event.inputType === 'deleteContentBackward';
    if (!backward && event.inputType !== 'deleteContentForward') return;
    const caret = input.selectionStart;
    const adjacent = backward ? caret - 1 : caret;
    if (adjacent < 0 || adjacent >= input.value.length || /\d/.test(input.value[adjacent])) return;
    let edge = adjacent;
    while (edge >= 0 && edge < input.value.length && !/\d/.test(input.value[edge]))
      edge += backward ? -1 : 1;
    if (edge >= 0 && edge < input.value.length)
      input.setSelectionRange(backward ? edge : caret, backward ? caret : edge + 1);
  });
}
