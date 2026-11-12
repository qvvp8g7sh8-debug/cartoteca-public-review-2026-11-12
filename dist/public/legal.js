// Generated from src/client/legal/page.js. Edit the source file.
(() => {
  const selectPurpose = () => {
    const purpose = location.hash.slice(1);
    for (const section of document.querySelectorAll('[data-consent-purpose]'))
      section.hidden =
        ['registration', 'booking'].includes(purpose) && section.dataset.consentPurpose !== purpose;
  };
  window.addEventListener('hashchange', selectPurpose);
  selectPurpose();
  const organizationId = new URLSearchParams(location.search).get('organization');
  if (!organizationId || !/^[a-f0-9-]{36}$/.test(organizationId)) return;
  fetch('/api/public-booking/info?organization=' + encodeURIComponent(organizationId), {
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) throw Error();
      const info = await response.json();
      document.getElementById('consent-organization').textContent =
        info.organization.name + (info.organization.city ? ' · ' + info.organization.city : '');
    })
    .catch(() => {
      document.getElementById('consent-organization-status').textContent =
        'Не удалось загрузить название получателя. Проверьте организацию в исходной форме онлайн-записи.';
    });
})();
