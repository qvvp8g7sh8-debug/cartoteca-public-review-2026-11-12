function createStaffChannelIcons() {
  function staffChannelIconHtml(channel) {
    if (channel === 'max') return '<span class="connection-max-mark" aria-hidden="true">MAX</span>';
    const path =
      channel === 'telegram'
        ? 'M21.7 3.4 18.5 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6 13.8l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.2 3c.9-.3 1.7.2 1.5.4Z'
        : 'M12 2a2 2 0 0 0-2 2v.3A6 6 0 0 0 6 10v5l-2 3v1h16v-1l-2-3v-5a6 6 0 0 0-4-5.7V4a2 2 0 0 0-2-2Zm-3 18a3 3 0 0 0 6 0Z';
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  }
  return { staffChannelIconHtml };
}
