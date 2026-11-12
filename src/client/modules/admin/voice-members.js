function createAdminVoiceMembers({ $, request, records, canLeave, onSelect }) {
  const organizations = new Map(),
    memberships = new Map();
  let visibleOrganizations = [],
    next = null,
    query = '',
    searchGeneration = 0,
    organizationGeneration = 0;
  let committed = { organizationId: '', accountId: '' };
  const target = () => ({
    organizationId: $('#admin-voice-organization').value,
    accountId: $('#admin-voice-account').value,
  });
  const key = (item) => item.organizationId + '|' + item.accountId;
  const identity = () => memberships.get(key(target()));
  function options(items, placeholder) {
    return (
      '<option value="">' +
      records.esc(placeholder) +
      '</option>' +
      items
        .map(
          ([value, label]) =>
            '<option value="' + records.esc(value) + '">' + records.esc(label) + '</option>',
        )
        .join('')
    );
  }
  function renderOrganizations(organizationId = '') {
    const ids = [...visibleOrganizations];
    if (organizationId && organizations.has(organizationId) && !ids.includes(organizationId))
      ids.unshift(organizationId);
    $('#admin-voice-organization').innerHTML = options(
      ids.map((id) => [id, organizations.get(id)]),
      'Выберите организацию',
    );
    if (organizations.has(organizationId)) $('#admin-voice-organization').value = organizationId;
  }
  function renderMembers(accountId = '') {
    const organizationId = $('#admin-voice-organization').value;
    const members = [...memberships.values()].filter(
      (item) => item.organizationId === organizationId,
    );
    $('#admin-voice-account').innerHTML = options(
      members.map((item) => [
        item.accountId,
        item.displayName +
          ' · ' +
          (records.roles[item.role] || item.role) +
          (item.status === 'active' ? '' : ' · доступ приостановлен'),
      ]),
      'Выберите пользователя',
    );
    $('#admin-voice-account').disabled = !organizationId;
    if (members.some((item) => item.accountId === accountId))
      $('#admin-voice-account').value = accountId;
  }
  function seed(items, truncated) {
    const selected = target();
    for (const item of items || []) {
      organizations.set(item.organizationId, item.organizationName);
      memberships.set(key(item), item);
    }
    if (!visibleOrganizations.length) visibleOrganizations = [...organizations.keys()];
    renderOrganizations(selected.organizationId);
    renderMembers(selected.accountId);
    committed = target();
    $('#admin-voice-search-status').textContent = truncated
      ? 'Чтобы найти другую организацию, используйте поиск по названию, городу или владельцу.'
      : '';
  }
  async function search(more = false) {
    const serial = ++searchGeneration;
    if (!more) {
      query = $('#admin-voice-org-search').value.trim();
      next = null;
      $('#admin-voice-org-more').hidden = true;
    }
    const parameters = { q: query };
    if (more && next) parameters.cursor = next;
    $('#admin-voice-org-more').disabled = true;
    $('#admin-voice-search-status').textContent = 'Ищем организации…';
    try {
      const data = await request('/api/admin/organizations?' + new URLSearchParams(parameters));
      if (serial !== searchGeneration) return;
      const selected = target();
      if (!more) visibleOrganizations = [];
      for (const item of data.items) {
        organizations.set(item.id, item.name);
        if (!visibleOrganizations.includes(item.id)) visibleOrganizations.push(item.id);
      }
      next = data.nextCursor || null;
      renderOrganizations(selected.organizationId);
      $('#admin-voice-org-more').hidden = !next;
      $('#admin-voice-search-status').textContent =
        'Найдено: ' + data.total + '. В списке показано: ' + visibleOrganizations.length + '.';
    } catch (error) {
      if (serial === searchGeneration) $('#admin-voice-search-status').textContent = error.message;
    } finally {
      if (serial === searchGeneration) $('#admin-voice-org-more').disabled = false;
    }
  }
  async function refresh() {
    const selected = target(),
      serial = ++organizationGeneration;
    if (!selected.organizationId) {
      await onSelect();
      return;
    }
    $('#admin-voice-account').disabled = true;
    $('#admin-voice-search-status').textContent = 'Загружаем пользователей организации…';
    try {
      const data = await request(
        '/api/admin/organization?id=' + encodeURIComponent(selected.organizationId),
      );
      if (serial !== organizationGeneration || target().organizationId !== selected.organizationId)
        return;
      organizations.set(data.id, data.name);
      for (const [id, item] of memberships)
        if (item.organizationId === selected.organizationId) memberships.delete(id);
      for (const item of data.members) {
        const member = { ...item, organizationId: data.id, organizationName: data.name };
        memberships.set(key(member), member);
      }
      renderMembers(selected.accountId);
      committed = target();
      $('#admin-voice-search-status').textContent = 'Выберите пользователя выбранной организации.';
      await onSelect();
    } catch (error) {
      if (serial === organizationGeneration) {
        $('#admin-voice-account').innerHTML = options([], 'Не удалось загрузить пользователей');
        committed = target();
        $('#admin-voice-search-status').textContent = error.message;
        await onSelect();
      }
    }
  }
  function restoreSelection() {
    renderOrganizations(committed.organizationId);
    renderMembers(committed.accountId);
  }
  function bind() {
    $('#admin-voice-org-search-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void search();
    });
    $('#admin-voice-org-more').addEventListener('click', () => {
      void search(true);
    });
    $('#admin-voice-organization').addEventListener('change', () => {
      if (!canLeave()) {
        restoreSelection();
        return;
      }
      $('#admin-voice-account').innerHTML = options([], 'Загружаем пользователей…');
      $('#admin-voice-account').disabled = true;
      committed = target();
      void onSelect();
      void refresh();
    });
    $('#admin-voice-account').addEventListener('change', () => {
      if (!canLeave()) {
        restoreSelection();
        return;
      }
      committed = target();
      void onSelect();
    });
  }
  return { seed, target, identity, refresh, bind };
}
