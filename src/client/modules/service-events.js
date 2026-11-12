function createServiceEvents(state, actions) {
  function bindServiceEvents() {
    actions.$('#global-view').addEventListener('click', async (e) => {
      const toggle = e.target.closest('#toggle-service-edit');
      const categoryTab = e.target.closest('[data-service-category-tab]');
      const select = e.target.closest('[data-select-service]');
      const removeSelected = e.target.closest('[data-remove-selected-service]');
      const clear = e.target.closest('#clear-service-selection');
      const clearSearch = e.target.closest('#clear-service-search');
      const create = e.target.closest('#create-appointment-from-services');
      const preset = e.target.closest('[data-new-service-category]');
      const add = e.target.closest('#new-service');
      const edit = e.target.closest('[data-edit-service]');
      const remove = e.target.closest('[data-delete-service]');
      if (
        !toggle &&
        !categoryTab &&
        !select &&
        !removeSelected &&
        !clear &&
        !clearSearch &&
        !create &&
        !preset &&
        !add &&
        !edit &&
        !remove
      )
        return;
      e.stopPropagation();
      if (state.busy) return;
      try {
        if (toggle) {
          actions.configureServiceView({
            editing: !actions.serviceView().editing,
          });
          actions.setView('services');
          return;
        }
        if (categoryTab) {
          actions.configureServiceView({
            category: categoryTab.dataset.serviceCategoryTab,
          });
          actions.setView('services');
          return;
        }
        if (select && !actions.serviceView().editing) {
          actions.toggleServiceSelection(select.dataset.selectService);
          actions.setView('services');
          return;
        }
        if (removeSelected) {
          actions.removeServiceSelection(removeSelected.dataset.removeSelectedService);
          actions.setView('services');
          return;
        }
        if (clear) {
          actions.clearServiceSelection();
          actions.setView('services');
          return;
        }
        if (clearSearch) {
          actions.configureServiceView({ query: '' });
          actions.$('#service-search').value = '';
          actions.renderServiceResults();
          actions.$('#service-search').focus({ preventScroll: true });
          return;
        }
        if (create) {
          const chosen = actions.selectedServices();
          if (!chosen.length) return;
          actions.openAppointmentForm(
            {
              service: chosen.map((service) => service.name).join(' + '),
              serviceItems: chosen.map((service) => actions.serviceSnapshot(service)),
              staffId: actions.serviceView().staffId,
              duration: chosen.reduce(
                (sum, service) => sum + actions.durationMinutes(service.duration),
                0,
              ),
            },
            'services',
          );
          return;
        }
        if (preset) {
          actions.openServiceForm(null, preset.dataset.newServiceCategory);
          return;
        }
        if (add) {
          actions.openServiceForm();
          return;
        }
        if (edit) {
          if (!actions.serviceView().editing) {
            actions.toast('Сначала включите режим редактирования');
            return;
          }
          actions.openServiceForm(
            state.services.find((service) => service.id === edit.dataset.editService),
          );
          return;
        }
        if (remove) {
          if (!actions.serviceView().editing) {
            actions.toast('Сначала включите режим редактирования');
            return;
          }
          const service = state.services.find((item) => item.id === remove.dataset.deleteService);
          if (
            service &&
            window.confirm(`Удалить услугу «${service.name}»? Это не изменит уже созданные записи.`)
          ) {
            state.busy = true;
            state.services = state.services.filter((item) => item.id !== service.id);
            actions.removeServiceSelection(service.id);
            await actions.saveServices();
            actions.setView('services');
            actions.toast('Услуга удалена');
          }
        }
      } catch (error) {
        actions.rollback();
        actions.toast(error.message);
      } finally {
        state.busy = false;
      }
    });
    actions.$('#global-view').addEventListener('input', (e) => {
      if (e.target.id !== 'service-search') return;
      actions.configureServiceView({ query: e.target.value });
      actions.renderServiceResults();
    });
    actions.$('#global-view').addEventListener('change', (e) => {
      if (e.target.id === 'service-catalog-staff') {
        if (state.busy) {
          e.target.value = actions.serviceView().staffId;
          return;
        }
        actions.configureServiceView({ staffId: e.target.value });
        actions.setView('services');
        return;
      }
      if (e.target.id === 'service-category-select') {
        actions.configureServiceView({ category: e.target.value });
        actions.renderServiceResults();
        document.querySelectorAll('[data-service-category-tab]').forEach((tab) => {
          const active = tab.dataset.serviceCategoryTab === actions.serviceView().category;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-pressed', String(active));
        });
        // Keep the native select mounted; refocusing a replacement can reopen the phone picker.
        if (state.mobileScreen?.matches) e.target.blur();
        return;
      }
    });
  }
  return { bindServiceEvents };
}
