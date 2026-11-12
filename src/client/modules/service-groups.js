function createServiceGroupControls(state, actions) {
  let nameDialog = null;
  function askServiceGroupName() {
    if (nameDialog) return Promise.resolve(null);
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'service-group-dialog';
    dialog.className = 'action-confirmation';
    dialog.setAttribute('aria-labelledby', 'service-group-dialog-title');
    dialog.innerHTML = [
      '<form><h3 id="service-group-dialog-title">Создать группу услуг</h3>',
      '<label class="field">Название группы<input name="groupTitle" required maxlength="100" autocomplete="off" autofocus></label>',
      '<div class="action-confirmation-buttons"><button type="button" class="secondary" data-group-cancel>Отмена</button>',
      '<button type="submit" class="primary">Создать группу</button></div></form>',
    ].join('');
    document.body.append(dialog);
    nameDialog = dialog;
    return new Promise((resolve) => {
      dialog.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = dialog.querySelector('input');
        input.setCustomValidity(input.value.trim() ? '' : 'Укажите название группы');
        if (input.reportValidity()) dialog.close('create');
      });
      dialog.querySelector('input').addEventListener('input', (event) => {
        event.target.setCustomValidity('');
      });
      dialog.querySelector('[data-group-cancel]').addEventListener('click', () => {
        dialog.close('cancelled');
      });
      dialog.addEventListener(
        'close',
        () => {
          const name = dialog.returnValue === 'create' ? dialog.querySelector('input').value : null;
          dialog.remove();
          nameDialog = null;
          if (opener?.isConnected) opener.focus({ preventScroll: true });
          resolve(name);
        },
        { once: true },
      );
      dialog.showModal();
    });
  }
  function applyServiceGroups(result) {
    state.SERVICE_CATEGORIES = result.groups.map((g) => ({
      id: g.id,
      title: g.id === 'other' ? 'Без группы' : g.title,
    }));
    state.serviceGroupRevision = result.revision;
  }
  function removableServiceGroup(id) {
    if (!id || id === 'all' || id === 'other') return null;
    return state.SERVICE_CATEGORIES.find((group) => group.id === id) || null;
  }
  function serviceGroupControlHtml(categoryId) {
    if (!state.multiUser || !actions.canEditServices()) return '';
    const create =
      '<button type="button" class="text-btn" data-add-service-group>+ Создать группу</button>';
    return removableServiceGroup(categoryId)
      ? create +
          '<button type="button" class="text-btn danger" data-delete-service-group>Удалить группу</button>'
      : create;
  }
  function mountServiceGroupControl() {
    if (!state.multiUser || state.editorMode?.kind !== 'service') return;
    const label = actions.$('#form-content [name="category"]')?.closest('label');
    if (label && !label.querySelector('[data-add-service-group]'))
      label.insertAdjacentHTML('beforeend', serviceGroupControlHtml());
  }
  async function deleteServiceGroup(button) {
    const selected = () => actions.$('#service-category-select')?.value;
    const group = removableServiceGroup(selected());
    const account = state.account;
    if (!state.multiUser || !account || state.currentView !== 'services' || !group) return;
    const { id, title } = group;
    const { id: accountId, organizationId } = account;
    const revision = state.serviceGroupRevision;
    const currentSession = () =>
      state.multiUser &&
      state.account === account &&
      account.id === accountId &&
      account.organizationId === organizationId;
    const confirmed = await actions.confirmAction(
      `Удалить группу «${title}»?`,
      'Удалить можно только пустую группу. Если в ней есть услуги, перенесите их в другую группу или выберите «Без группы».',
      'Удалить группу',
      'Отмена',
      { preferCancel: true },
    );
    if (
      !confirmed ||
      !currentSession() ||
      state.busy ||
      !button.isConnected ||
      !actions.canEditServices() ||
      state.currentView !== 'services' ||
      selected() !== id
    )
      return;
    if (revision !== state.serviceGroupRevision || !removableServiceGroup(id)) {
      actions.toast('Список групп изменился. Выберите группу заново.');
      return;
    }
    state.busy = true;
    button.disabled = true;
    try {
      const result = await actions.request('/api/service-groups', {
        method: 'DELETE',
        body: JSON.stringify({ id, revision }),
      });
      if (!currentSession()) return;
      if (result.revision >= state.serviceGroupRevision) applyServiceGroups(result);
      if (state.currentView === 'services') {
        actions.configureServiceView({ category: 'all' });
        await actions.setView('services', { redraw: true });
        if (currentSession() && state.currentView === 'services')
          actions.$('#toggle-service-edit')?.focus({ preventScroll: true });
      }
      if (currentSession()) actions.toast('Группа удалена');
    } catch (error) {
      if (!currentSession()) return;
      actions.toast(
        error.status && error.message
          ? error.message
          : 'Не удалось удалить группу. Повторите попытку.',
      );
      if (error.status === 409)
        try {
          const fresh = await actions.request('/api/service-groups');
          if (currentSession() && fresh.revision > state.serviceGroupRevision) {
            applyServiceGroups(fresh);
            if (state.currentView === 'services')
              await actions.setView('services', { redraw: true });
          }
        } catch {}
    } finally {
      if (currentSession()) state.busy = false;
      if (button.isConnected) button.disabled = false;
    }
  }
  function bindServiceGroupEvents() {
    document.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-add-service-group]');
      const remove = button ? null : e.target.closest('[data-delete-service-group]');
      if (!button && !remove) return;
      e.stopImmediatePropagation();
      if (state.busy || !actions.canEditServices()) return;
      if (remove) {
        await deleteServiceGroup(remove);
        return;
      }
      const key = [state.account?.id, state.account?.organizationId].join(':');
      const name = await askServiceGroupName();
      if (name === null) return;
      if (
        state.busy ||
        !button.isConnected ||
        !actions.canEditServices() ||
        key !== [state.account?.id, state.account?.organizationId].join(':')
      )
        return;
      if (!name.trim() || name.length > 100) {
        actions.toast('Укажите название группы — до 100 символов');
        return;
      }
      state.busy = true;
      button.disabled = true;
      try {
        const result = await actions.request('/api/service-groups', {
          method: 'POST',
          body: JSON.stringify({ title: name.trim(), revision: state.serviceGroupRevision }),
        });
        if (key !== [state.account?.id, state.account?.organizationId].join(':')) return;
        applyServiceGroups(result);
        const select = actions.$('#editor[open] select[name="category"]');
        if (select) select.innerHTML = actions.categoryOptions(result.createdId);
        else if (state.currentView === 'services') {
          actions.configureServiceView({ category: result.createdId });
          actions.setView('services');
        }
        actions.toast('Группа создана');
      } catch (error) {
        actions.toast(error.message);
        if (error.status === 409)
          try {
            const fresh = await actions.request('/api/service-groups');
            if (key === [state.account?.id, state.account?.organizationId].join(':')) {
              applyServiceGroups(fresh);
              const select = actions.$('#editor[open] select[name="category"]');
              if (select) select.innerHTML = actions.categoryOptions(select.value);
              else if (state.currentView === 'services') actions.setView('services');
            }
          } catch {}
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return {
    applyServiceGroups,
    serviceGroupControlHtml,
    mountServiceGroupControl,
    bindServiceGroupEvents,
  };
}
