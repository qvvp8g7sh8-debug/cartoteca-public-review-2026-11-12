function createAdminVoiceProviders({ records }) {
  const { esc } = records,
    models = new Map(),
    speech = new Map(),
    bound = new WeakSet();
  const defaults = {
    demo: 'deepseek/deepseek-flash',
    timeweb: 'deepseek/deepseek-flash',
    codex: 'codex-default',
  };
  const stages = {
    stt: 'Распознавание речи',
    llm: 'Обработка команды',
    tts: 'Озвучивание ответа',
  };
  const speechModels = {
    stt: {
      'openai/gpt-4o-mini-transcribe': 'GPT-4o mini Transcribe',
      'openai/gpt-4o-transcribe': 'GPT-4o Transcribe',
    },
    tts: { 'openai/gpt-4o-mini-tts': 'GPT-4o mini TTS' },
  };
  const voices = Object.fromEntries(
    [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar',
    ].map((voice) => [voice, voice]),
  );
  function modelChoices(stage, provider) {
    return provider === 'local'
      ? stage === 'stt'
        ? { 'whisper-base': 'Whisper base (на этом компьютере)' }
        : { 'system-ru': 'Русский голос устройства' }
      : speechModels[stage];
  }
  function voiceChoices(provider) {
    return provider === 'local' ? { 'ru-local': 'Локальный русский голос' } : voices;
  }
  function localStatus(stage, available) {
    if (stage === 'stt')
      return available === true
        ? 'Whisper работает только на текущем компьютере, без отправки аудио в Timeweb.'
        : 'Локальный Whisper пока недоступен. Нужны локальный запуск и установленная модель на текущем компьютере.';
    return available === true
      ? 'Браузер проверит русский локальный голос перед записью. Доступно только на текущем компьютере, без сетевых голосов.'
      : 'Голос устройства доступен только в локальном запуске. Браузер отдельно проверит русский локальный голос перед записью.';
  }
  const modelAttributes =
    'minlength="2" maxlength="120" required pattern="[A-Za-z0-9][A-Za-z0-9._:\\/\\-]{1,119}"';
  function options(selected, entries) {
    return Object.entries(entries)
      .map(
        ([value, label]) =>
          '<option value="' +
          esc(value) +
          '"' +
          (selected === value ? ' selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  }
  function llmModel(data) {
    const codex = data.provider === 'codex';
    models.set(data.provider, data.model || defaults[data.provider]);
    return (
      '<label class="field" data-voice-llm-model="standard"' +
      (codex ? ' hidden' : '') +
      '><span data-voice-llm-model-label>' +
      (data.provider === 'timeweb' ? 'Модель Timeweb' : 'Модель') +
      '</span><input name="model.llm" value="' +
      esc(models.get(codex ? 'timeweb' : data.provider) || defaults.timeweb) +
      '" ' +
      modelAttributes +
      (codex ? ' disabled' : '') +
      '></label>' +
      '<label class="field" data-voice-llm-model="codex"' +
      (codex ? '' : ' hidden') +
      '>Модель локального Codex<input name="model.codex" value="' +
      esc(models.get('codex') || defaults.codex) +
      '" ' +
      modelAttributes +
      (codex ? '' : ' disabled') +
      '></label>'
    );
  }
  function billing(provider) {
    return provider === 'codex'
      ? 'Codex расходует лимиты подписки. Timeweb оплачивается отдельно для выбранных этапов.'
      : 'Распознавание и озвучивание настраиваются отдельно.';
  }
  function codexStatus(status) {
    if (status?.available === true) return 'Codex доступен. Авторизация проверяется при запросе.';
    if (status?.available === false)
      return 'Доступно только в локальном просмотре с установленным Codex.';
    return 'Состояние локального подключения Codex не получено.';
  }
  function provider(stage, data, status) {
    const providers = { demo: 'Демонстрационный', timeweb: 'Timeweb' };
    if (stage === 'llm') providers.codex = 'Локальный Codex';
    else {
      providers.local = stage === 'stt' ? 'Локально (Whisper)' : 'Локальный голос устройства';
      speech.set(stage + ':' + data.provider, {
        model: data.model,
        voice: data.voice,
      });
    }
    const model =
      stage === 'llm'
        ? llmModel(data)
        : '<label class="field">Модель<select name="model.' +
          stage +
          '">' +
          options(data.model, modelChoices(stage, data.provider)) +
          '</select></label>';
    return (
      '<section class="admin-voice-provider" data-voice-provider="' +
      stage +
      '" data-current-provider="' +
      esc(data.provider) +
      '" data-local-available="' +
      (status?.local?.[stage]?.available === true ? 'true' : 'false') +
      '"><h4>' +
      stages[stage] +
      '</h4><label class="field">Провайдер<select name="provider.' +
      stage +
      '">' +
      options(data.provider || 'demo', providers) +
      '</select></label>' +
      model +
      (stage === 'tts'
        ? '<label class="field">Голос<select name="voice.tts">' +
          options(data.voice, voiceChoices(data.provider)) +
          '</select></label>'
        : '') +
      (stage === 'llm'
        ? '<p data-voice-codex-status>' +
          esc(codexStatus(status?.codex)) +
          '</p><p data-voice-llm-billing>' +
          esc(billing(data.provider)) +
          '</p>'
        : '<p data-voice-local-status' +
          (data.provider === 'local' ? '' : ' hidden') +
          '>' +
          esc(localStatus(stage, status?.local?.[stage]?.available)) +
          '</p>') +
      '</section>'
    );
  }
  function render(data) {
    return Object.keys(stages)
      .map((stage) => provider(stage, data.providers[stage], data.providerStatus))
      .join('');
  }
  function remember(section, provider) {
    const input = section.querySelector(
      '[name="' + (provider === 'codex' ? 'model.codex' : 'model.llm') + '"]',
    );
    if (input) models.set(provider, input.value);
  }
  function switchProvider(section) {
    remember(section, section.dataset.currentProvider);
    const provider = section.querySelector('[name="provider.llm"]').value,
      codex = provider === 'codex';
    section.dataset.currentProvider = provider;
    for (const [kind, active] of [
      ['standard', !codex],
      ['codex', codex],
    ]) {
      const label = section.querySelector('[data-voice-llm-model="' + kind + '"]'),
        input = label.querySelector('input');
      label.hidden = !active;
      input.disabled = !active;
      if (active) input.value = models.get(provider) ?? defaults[provider];
    }
    section.querySelector('[data-voice-llm-model-label]').textContent =
      provider === 'timeweb' ? 'Модель Timeweb' : 'Модель';
    section.querySelector('[data-voice-llm-billing]').textContent = billing(provider);
  }
  function rememberSpeech(section) {
    const stage = section.dataset.voiceProvider;
    speech.set(stage + ':' + section.dataset.currentProvider, {
      model: section.querySelector('[name="model.' + stage + '"]').value,
      voice: section.querySelector('[name="voice.tts"]')?.value,
    });
  }
  function switchSpeech(section) {
    rememberSpeech(section);
    const stage = section.dataset.voiceProvider,
      provider = section.querySelector('[name="provider.' + stage + '"]').value,
      saved = speech.get(stage + ':' + provider);
    section.dataset.currentProvider = provider;
    section.querySelector('[name="model.' + stage + '"]').innerHTML = options(
      saved?.model,
      modelChoices(stage, provider),
    );
    if (stage === 'tts')
      section.querySelector('[name="voice.tts"]').innerHTML = options(
        saved?.voice,
        voiceChoices(provider),
      );
    const hint = section.querySelector('[data-voice-local-status]');
    hint.hidden = provider !== 'local';
    hint.textContent = localStatus(stage, section.dataset.localAvailable === 'true');
  }
  function bind(root) {
    if (bound.has(root)) return;
    bound.add(root);
    root.addEventListener('change', (event) => {
      if (event.target.name === 'provider.llm')
        switchProvider(event.target.closest('[data-voice-provider="llm"]'));
      else if (['provider.stt', 'provider.tts'].includes(event.target.name))
        switchSpeech(event.target.closest('[data-voice-provider]'));
      else if (['model.stt', 'model.tts', 'voice.tts'].includes(event.target.name))
        rememberSpeech(event.target.closest('[data-voice-provider]'));
      else if (['model.llm', 'model.codex'].includes(event.target.name))
        remember(
          event.target.closest('[data-voice-provider="llm"]'),
          event.target.closest('[data-voice-provider="llm"]').dataset.currentProvider,
        );
    });
    root.addEventListener('input', (event) => {
      if (!['model.llm', 'model.codex'].includes(event.target.name)) return;
      const section = event.target.closest('[data-voice-provider="llm"]');
      remember(section, section.dataset.currentProvider);
    });
  }
  return {
    render,
    bind,
    reset: () => {
      models.clear();
      speech.clear();
    },
  };
}
