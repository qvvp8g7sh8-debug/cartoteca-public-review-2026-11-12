function createVideoConsent(state, actions) {
  let pending = false;
  function videoConsentHtml(patient) {
    const status = patient.videoConsent || 'unknown';
    return [
      `<section class="patient-video-consent" `,
      `aria-label="Согласие на видеосъёмку услуг">`,
      `<div class="video-consent-main"><div class="video-consent-label-row"><label class="checkbox-hit-area">`,
      `<input type="checkbox" `,
      `id="patient-video-consent" aria-label="Согласен на видеосъёмку услуг" ${status === 'granted' ? 'checked' : ''}></label><span id="video-consent-label">Контент</span>`,
      actions.settingsHelpHtml(
        'Согласие на видеосъёмку',
        'Внутренняя отметка для сотрудника: можно ли снимать фото и видео во время услуг. Эта отметка не заменяет юридическое согласие на съёмку, публикацию или рекламное использование материалов.',
      ),
      `</div></div></section>`,
    ].join('');
  }
  async function saveVideoConsent(status) {
    if (state.busy || !actions.patient()) return;
    state.busy = true;
    const id = state.selectedId;
    try {
      actions.patient().videoConsent = status;
      await actions.save();
      if (state.selectedId === id) actions.renderDetail();
      actions.toast('Отметка видеосъёмки сохранена');
    } catch (error) {
      actions.rollback();
      if (state.selectedId === id) actions.renderDetail();
      actions.toast(error.message);
    } finally {
      state.busy = false;
    }
  }
  function bindVideoConsentEvents() {
    document.addEventListener('change', async (e) => {
      if (e.target.id !== 'patient-video-consent') return;
      const patient = actions.patient();
      if (!patient) return;
      const granted = e.target.checked,
        status = patient.videoConsent || 'unknown';
      e.target.checked = status === 'granted';
      if (pending || state.busy) return;
      const scope = JSON.stringify([state.account?.id, state.account?.organizationId, patient.id]);
      pending = true;
      try {
        const accepted = await actions.confirmAction(
          granted ? 'Отметить согласие на видеосъёмку?' : 'Снять отметку видеосъёмки?',
          `${patient.name || 'Клиент'}\n${granted ? 'Сотрудник уточнил согласие на съёмку во время услуг.' : 'Отметка согласия будет снята.'}\nЭта внутренняя отметка не заменяет юридическое согласие.`,
          granted ? 'Отметить согласие' : 'Снять отметку',
        );
        if (
          accepted &&
          !state.busy &&
          (actions.patient()?.videoConsent || 'unknown') === status &&
          scope ===
            JSON.stringify([
              state.account?.id,
              state.account?.organizationId,
              actions.patient()?.id,
            ])
        )
          await saveVideoConsent(granted ? 'granted' : 'refused');
      } finally {
        pending = false;
      }
    });
  }
  return { videoConsentHtml, saveVideoConsent, bindVideoConsentEvents };
}
