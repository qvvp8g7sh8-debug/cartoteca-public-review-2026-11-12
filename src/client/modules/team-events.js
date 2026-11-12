function createTeamEvents(state, actions) {
  function bindTeamEvents() {
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        for (const menu of document.querySelectorAll('.team-member-menu[open]'))
          if (!menu.contains(e.target)) menu.open = false;
      },
      true,
    );
    function closeInvitation(panel, returnFocus = false) {
      if (!panel || state.busy) return;
      panel.open = false;
      if (returnFocus) panel.querySelector('summary')?.focus({ preventScroll: true });
    }
    actions.$('#global-view').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const panel = e.target.closest('.team-invite-panel[open]');
      if (!panel || state.busy) return;
      e.preventDefault();
      closeInvitation(panel, true);
    });
    actions.$('#global-view').addEventListener('change', async (e) => {
      const role = e.target.closest('[data-member-role]');
      if (!role || state.busy) return;
      const member = state.teamAccess?.members.find(
        (item) => item.accountId === role.dataset.memberRole,
      );
      if (!member) return;
      const value = role.value,
        account = state.account;
      role.value = member.role;
      if (
        value === member.role ||
        !(await actions.confirmAction(
          'Изменить роль сотрудника?',
          `${member.displayName || member.email}\nНовая роль: ${state.roleNames[value] || value}.\n${value === 'salon_admin' ? 'Администратор получает расширенные права управления организацией.' : 'Доступ будет ограничен правами сотрудника.'}`,
          'Изменить роль',
        ))
      )
        return;
      if (state.busy || state.account !== account || !role.isConnected) return;
      state.busy = true;
      actions
        .request('/api/organization/members', {
          method: 'POST',
          body: JSON.stringify({
            accountId: member.accountId,
            role: value,
            status: member.status,
          }),
        })
        .then((result) => {
          state.teamAccess = result;
          actions.renderTeamAccess();
          actions.toast('Роль сотрудника изменена');
        })
        .catch((error) => {
          actions.renderTeamAccess();
          actions.toast(error.message);
        })
        .finally(() => {
          state.busy = false;
        });
    });
    actions.$('#global-view').addEventListener('submit', async (e) => {
      const specialtyForm = e.target.closest('[data-member-specialty]');
      if (specialtyForm) {
        e.preventDefault();
        if (state.busy) return;
        const member = state.teamAccess?.members.find(
          (m) => m.accountId === specialtyForm.dataset.memberSpecialty,
        );
        if (!member) return;
        state.busy = true;
        const button = specialtyForm.querySelector('button');
        button.disabled = true;
        try {
          state.teamAccess = await actions.request('/api/organization/specialty', {
            method: 'POST',
            body: JSON.stringify({
              accountId: member.accountId,
              specialty: new FormData(specialtyForm).get('specialty'),
              expectedSpecialty: member.specialty || '',
            }),
          });
          actions.renderTeamAccess();
          actions.toast('Специальность сохранена');
        } catch (error) {
          actions.toast(error.message);
        } finally {
          state.busy = false;
          if (button.isConnected) button.disabled = false;
        }
        return;
      }
      if (e.target.id !== 'invite-member-form') return;
      e.preventDefault();
      if (state.busy) return;
      const invitationValues = Object.fromEntries(new FormData(e.target).entries()),
        account = state.account;
      if (
        invitationValues.role === 'salon_admin' &&
        !(await actions.confirmAction(
          'Пригласить администратора?',
          `${invitationValues.email}\nАдминистратор получит расширенный доступ к управлению организацией после принятия приглашения.`,
          'Пригласить администратора',
        ))
      )
        return;
      if (state.busy || state.account !== account || !e.target.isConnected) return;
      state.busy = true;
      const form = e.target,
        button = form.querySelector('button[type="submit"]'),
        message = actions.$('#team-message');
      const buttonText = button.textContent;
      const cancelButton = form.querySelector('[data-invite-cancel]');
      button.disabled = true;
      if (cancelButton) cancelButton.disabled = true;
      button.textContent = 'Отправляем…';
      if (message) message.textContent = '';
      try {
        const values = invitationValues;
        const result = await actions.request('/api/organization/invitations', {
          method: 'POST',
          body: JSON.stringify(values),
          timeoutMs: 45000,
        });
        if (state.account !== account) return;
        form.reset();
        const panel = form.closest('.team-invite-panel');
        if (panel) panel.open = false;
        state.teamAccess = result.access;
        actions.renderTeamAccess();
        const resultMessage = actions.$('#team-message');
        if (resultMessage) resultMessage.textContent = result.message;
        if (state.currentView === 'settings')
          actions
            .$('#invite-member-form')
            ?.closest('.team-invite-panel')
            ?.querySelector('summary')
            ?.focus({ preventScroll: true });
        actions.toast('Приглашение отправлено на почту');
      } catch (error) {
        if (state.account !== account) return;
        if (form.isConnected) form.closest('.team-invite-panel').open = true;
        if (message) message.textContent = error.message;
        if (error.outcomeUnknown) {
          await actions.loadTeamAccess();
          if (state.account !== account) return;
          const restored = actions.$('#invite-member-form');
          if (restored) {
            restored.elements.email.value = invitationValues.email;
            if (
              [...restored.elements.role.options].some(
                (option) => option.value === invitationValues.role,
              )
            )
              restored.elements.role.value = invitationValues.role;
            restored.closest('.team-invite-panel').open = true;
          }
          const freshMessage = actions.$('#team-message');
          if (freshMessage)
            freshMessage.textContent =
              'Проверьте статус приглашения в списке перед повторной отправкой.';
        }
      } finally {
        state.busy = false;
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = buttonText;
        }
        if (cancelButton?.isConnected) cancelButton.disabled = false;
      }
    });
    actions.$('#global-view').addEventListener('click', async (e) => {
      const cancel = e.target.closest('[data-invite-cancel]');
      const openInvitation = actions.$('.team-invite-panel[open]');
      if (cancel) {
        closeInvitation(cancel.closest('.team-invite-panel'), true);
        return;
      }
      if (openInvitation && !openInvitation.contains(e.target)) closeInvitation(openInvitation);
      const status = e.target.closest('[data-member-status]');
      const invitation = e.target.closest('[data-invitation-action]');
      if (invitation) {
        if (state.busy) return;
        const action = invitation.dataset.invitationAction;
        if (
          action === 'revoke' &&
          !window.confirm('Отозвать приглашение? Его ссылкой больше нельзя будет воспользоваться.')
        )
          return;
        state.busy = true;
        invitation.disabled = true;
        try {
          const result = await actions.request('/api/organization/invitations/' + action, {
            method: 'POST',
            timeoutMs: 45000,
            body: JSON.stringify({ invitationId: invitation.dataset.invitationId }),
          });
          state.teamAccess = result.access;
          actions.renderTeamAccess();
          actions.$('#team-message').textContent = result.message;
        } catch (error) {
          await actions.loadTeamAccess();
          const message = actions.$('#team-message');
          if (message)
            message.textContent =
              action === 'revoke' &&
              error.status === 404 &&
              !state.teamAccess?.invitations?.some(
                (item) => item.id === invitation.dataset.invitationId,
              )
                ? 'Приглашение уже удалено.'
                : error.message;
        } finally {
          state.busy = false;
          if (invitation.isConnected) invitation.disabled = false;
        }
        return;
      }
      if (!status || state.busy) return;
      const member = state.teamAccess?.members.find(
        (item) => item.accountId === status.dataset.memberStatus,
      );
      if (!member) return;
      const action = status.dataset.nextStatus === 'suspended' ? 'выключить' : 'включить';
      if (
        !window.confirm(
          `${action[0].toUpperCase() + action.slice(1)} доступ сотруднику «${member.displayName}»?`,
        )
      )
        return;
      state.busy = true;
      try {
        state.teamAccess = await actions.request('/api/organization/members', {
          method: 'POST',
          body: JSON.stringify({
            accountId: member.accountId,
            role: member.role,
            status: status.dataset.nextStatus,
          }),
        });
        actions.renderTeamAccess();
        actions.toast('Доступ сотрудника обновлён');
      } catch (error) {
        actions.toast(error.message);
      } finally {
        state.busy = false;
      }
    });
  }
  return { bindTeamEvents };
}
