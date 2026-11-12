function createServiceCatalog(state, actions) {
  let selectedStaff = '',
    selectedScope = '';
  function catalogMembers() {
    if (!state.multiUser) return [];
    if (!actions.canManageTeam())
      return [
        {
          accountId: actions.accountId(),
          displayName: state.account?.displayName,
          role: state.account?.role,
        },
      ];
    return (state.teamAccess?.members || state.workspace?.members || []).filter(
      (member) => member.status === 'active' && ['owner', 'cosmetologist'].includes(member.role),
    );
  }
  function serviceOwnerId(service) {
    return service?.staffId || state.serviceCatalogOwnerId || actions.accountId();
  }
  function serviceStaffId() {
    const scope = JSON.stringify([state.account?.id, state.account?.organizationId]);
    if (selectedScope !== scope) {
      selectedScope = scope;
      selectedStaff = actions.accountId();
    }
    const members = catalogMembers();
    if (members.length && !members.some((member) => member.accountId === selectedStaff))
      selectedStaff = members[0].accountId;
    return selectedStaff;
  }
  function selectServiceStaff(staffId) {
    serviceStaffId();
    if (catalogMembers().some((member) => member.accountId === staffId)) selectedStaff = staffId;
  }
  function servicesForStaff(staffId = '') {
    if (!state.multiUser) return state.services;
    const selected =
      staffId || actions.$('#form-content [name="staffId"]')?.value || serviceStaffId();
    return state.services.filter((service) => serviceOwnerId(service) === selected);
  }
  function serviceStaffLabel(staffId = '') {
    const id = staffId || serviceStaffId();
    return (
      catalogMembers().find((member) => member.accountId === id)?.displayName ||
      (id === actions.accountId() ? state.account?.displayName : '') ||
      'Сотрудник'
    );
  }
  function serviceStaffHtml() {
    if (!state.multiUser) return '';
    const members = catalogMembers(),
      id = serviceStaffId();
    if (members.length < 2)
      return `<div class="work-schedule-person service-catalog-person"><strong>${actions.esc(serviceStaffLabel(id))}</strong></div>`;
    return (
      '<div class="work-schedule-toolbar service-catalog-person"><label class="field">' +
      '<select id="service-catalog-staff" aria-label="Сотрудник — каталог услуг">' +
      members
        .map(
          (member) =>
            `<option value="${actions.esc(member.accountId)}" ${member.accountId === id ? 'selected' : ''}>${actions.esc(member.displayName || state.roleNames[member.role])}</option>`,
        )
        .join('') +
      '</select></label></div>'
    );
  }
  function serviceOptions(current = '', serviceId = '', staffId = '') {
    const services = servicesForStaff(staffId);
    serviceId = serviceId || services.find((s) => s.name === current)?.id;
    const custom =
      current && !services.some((s) => s.name === current)
        ? `<option value="${actions.esc(current)}" selected>${actions.esc(current)} (введено ранее)</option>`
        : '';
    return `<option value="">Выберите услугу</option>${custom}${state.SERVICE_CATEGORIES.map(
      (category) =>
        `<optgroup label="${actions.esc(category.title)}">${services
          .filter((s) => actions.serviceCategory(s) === category.id)
          .map((s) =>
            [
              `<option value="${actions.esc(s.name)}" `,
              `data-service-id="${actions.esc(s.id)}" `,
              `data-duration="${actions.durationMinutes(s.duration)}" ${s.name === current && s.id === serviceId ? 'selected' : ''}>${actions.esc(s.name)} · ${actions.esc(actions.formatPrice(s.price))}</option>`,
            ].join(''),
          )
          .join('')}</optgroup>`,
    ).join('')}`;
  }
  function serviceDuration(name, staffId = '') {
    const service = servicesForStaff(staffId).find((s) => s.name === name);
    return service ? actions.durationMinutes(service.duration) : 60;
  }

  return {
    serviceOptions,
    serviceDuration,
    serviceOwnerId,
    serviceStaffId,
    selectServiceStaff,
    servicesForStaff,
    serviceStaffLabel,
    serviceStaffHtml,
  };
}
