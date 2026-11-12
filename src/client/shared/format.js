function createFormat(state, actions) {
  const $ = (s, root = document) => root.querySelector(s);
  const esc = (v = '') =>
    String(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const formatDate = (v) =>
    v
      ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(
          new Date(v + 'T00:00:00'),
        )
      : '—';
  function formatPhone(value) {
    const original = String(value || '').trim(),
      raw = actions.normalizePatientPhoneText(original);
    if (raw === null) return original;
    const digits = raw.replace(/\D/g, ''),
      national =
        digits.length === 11 &&
        (digits.startsWith('7') || (digits.startsWith('8') && !raw.startsWith('+')))
          ? digits.slice(1)
          : digits.length === 10 && !raw.startsWith('+')
            ? digits
            : '';
    return national
      ? `+7 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`
      : raw;
  }
  const isoDate = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const parseDate = (v) => new Date(`${v}T00:00:00`);
  const monthTitle = (d) =>
    new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
      .format(d)
      .replace(/^./, (c) => c.toUpperCase());
  const weekStart = (d) => {
    const x = new Date(d);
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const timeLabel = (minutes) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const initials = (name) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0])
      .join('')
      .toUpperCase();
  function plural(n, a, b, c) {
    const x = n % 100;
    return x >= 11 && x <= 14 ? c : n % 10 === 1 ? a : n % 10 >= 2 && n % 10 <= 4 ? b : c;
  }
  function toast(msg) {
    const t = actions.$('#toast');
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 4000);
  }
  return {
    $,
    esc,
    formatDate,
    formatPhone,
    isoDate,
    parseDate,
    monthTitle,
    weekStart,
    timeLabel,
    initials,
    plural,
    toast,
  };
}
