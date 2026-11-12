function markPublicBookingEntry(browser) {
  try {
    const navigation = browser.navigation;
    if (!navigation?.updateCurrentEntry || !navigation.currentEntry?.getState) return;
    const state = navigation.currentEntry.getState();
    if (state != null && (typeof state !== 'object' || Array.isArray(state))) return;
    navigation.updateCurrentEntry({ state: { ...state, cartotecaPublicBooking: true } });
  } catch {
    // Optional enhancement; the form must work in browsers without Navigation API.
  }
}
function publicBookingReturnOffset(browser) {
  const isBooking = (url) =>
    /\/booking(?:-reply)?\.html$/i.test(url.pathname) || /^\/b\/[a-z0-9]{8}$/.test(url.pathname);
  const isReturnShim = (url) => url.hostname.toLowerCase() === 'l.instagram.com';
  const destination = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  };
  try {
    const navigation = browser.navigation,
      index = navigation?.currentEntry?.index;
    if (Number.isInteger(index) && typeof navigation.entries === 'function') {
      const previous = navigation
        .entries()
        .filter((entry) => entry.index < index)
        .reverse();
      for (const entry of previous) {
        if (entry.getState?.()?.cartotecaPublicBooking === true) continue;
        // A hidden URL needs an external referrer as evidence of a return path.
        if (entry.url === null) {
          const referrer = destination(browser.document?.referrer);
          return referrer && !isBooking(referrer) && !isReturnShim(referrer)
            ? entry.index - index
            : 0;
        }
        const url = destination(entry.url);
        if (!url) return 0;
        if (!isBooking(url) && !isReturnShim(url)) return entry.index - index;
      }
      if (previous.length) return 0;
    }
  } catch {
    // Older/embedded browsers may not expose Navigation history entries.
  }
  // Referrer is only evidence for Back, never a URL to redirect to or persist.
  const referrer = destination(browser.document?.referrer);
  return browser.history?.length > 1 && referrer && !isBooking(referrer) && !isReturnShim(referrer)
    ? -1
    : 0;
}
function leavePublicBookingPage(browser = window) {
  const offset = publicBookingReturnOffset(browser);
  function close() {
    // noopener tabs can still be script-closable. Always attempt actual closing.
    try {
      browser.close();
    } catch {
      // A browser/WebView may forbid closing its tab.
    }
  }
  // A real opener identifies a separate window; otherwise prefer known Back.
  if (!browser.opener && offset) {
    try {
      browser.history.go(offset);
      return;
    } catch {
      // Fall through when the embedded browser denies traversal.
    }
  }
  close();
}
function createPublicBookingFlow(root) {
  markPublicBookingEntry(window);
  const $ = (selector) => root.querySelector(selector);
  let step = 1,
    exited = false;
  window.addEventListener('pagehide', () => {
    exited = true;
  });
  const sections = [
    '#booking-services-section',
    '#booking-date-section',
    '#booking-contact-section',
  ];
  function show(value = step, focus = false) {
    step = value;
    sections.forEach((selector, index) => {
      const section = $(selector);
      if (section) section.hidden = step !== index + 1;
    });
    root.querySelectorAll('[data-booking-progress]').forEach((item) => {
      if (Number(item.dataset.bookingProgress) === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    if (focus && !exited) {
      const heading = $(sections[step - 1] + ' h2');
      heading?.focus({ preventScroll: true });
      root.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }
  function sync(selected, staffId, time) {
    const services = $('[data-booking-next="2"]'),
      date = $('[data-booking-next="3"]');
    if (services) services.disabled = !selected.length || !staffId;
    if (date) date.disabled = !time;
    if (step === 3 && !time) show(2);
    else show();
  }
  function close() {
    leavePublicBookingPage();
  }
  function resume() {
    exited = false;
    const result = $('#booking-result');
    if (result && !result.hidden) result.focus();
    else if ($('#booking-flow')) show(step, true);
    else $('[data-booking-retry]')?.focus();
  }
  return {
    show,
    sync,
    close,
    resume,
    canExit: () => Boolean(window.opener) || publicBookingReturnOffset(window) < 0,
    closed: () => exited,
  };
}
