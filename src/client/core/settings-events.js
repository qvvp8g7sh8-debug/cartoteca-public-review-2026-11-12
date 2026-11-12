function createSettingsEvents(state, actions) {
  function bindSettingsEvents() {
    actions.bindOnlineBookingSettingsEvents();
    actions.bindClientNotificationSettingsEvents();
    actions.bindSupportEvents();
    actions.bindImprovementEvents();
    actions.bindProfileEvents();
    actions.bindProfileOverviewEvents();
    actions.bindSettingsPageEvents();
    actions.bindStaffBookingRulesEvents();
    actions.bindTeamEvents();
    actions.bindOrganizationTimeZoneEvents();
    actions.bindPaidServicesEvents();
    actions.bindTelegramSettingsEvents();
    actions.bindWorkspaceSettingsEvents();
  }
  return { bindSettingsEvents };
}
