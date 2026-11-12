const { fail } = require('../../../../../shared/errors.cjs');
const localModels = Object.freeze({ stt: 'whisper-base', tts: 'system-ru' });
function providerAllowed(kind, provider) {
  return (
    ['demo', 'timeweb'].includes(provider) ||
    (kind === 'llm' && provider === 'codex') ||
    (kind !== 'llm' && Object.hasOwn(localModels, kind) && provider === 'local')
  );
}
function providerSettings(kind, options, previous, models) {
  const provider = options.provider ?? previous.provider;
  if (!providerAllowed(kind, provider)) throw fail(400, 'Провайдер не поддерживается.');
  const switching =
    provider !== previous.provider &&
    [provider, previous.provider].some((name) => ['codex', 'local'].includes(name));
  let model =
    options.model ??
    (switching
      ? provider === 'codex'
        ? 'codex-default'
        : provider === 'local'
          ? localModels[kind]
          : models[kind]
      : previous.model);
  if (
    (kind === 'llm' && provider !== 'codex' && model === 'codex-default') ||
    (provider !== 'local' && model === localModels[kind])
  )
    model = models[kind];
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,119}$/.test(model))
    throw fail(400, 'Некорректное имя модели.');
  if (
    kind === 'stt' &&
    (provider === 'local'
      ? model !== localModels.stt
      : !['openai/gpt-4o-mini-transcribe', 'openai/gpt-4o-transcribe'].includes(model))
  )
    throw fail(400, 'Выберите поддерживаемую модель распознавания.');
  if (kind === 'tts' && model !== (provider === 'local' ? localModels.tts : models.tts))
    throw fail(400, 'Выберите поддерживаемую модель голоса.');
  if (kind !== 'tts') return { provider, model };
  const voice =
    options.voice ?? (switching ? (provider === 'local' ? 'ru-local' : 'alloy') : previous.voice);
  const voices =
    provider === 'local'
      ? ['ru-local']
      : [
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
        ];
  if (!voices.includes(voice)) throw fail(400, 'Выберите поддерживаемый голос.');
  return { provider, model, voice };
}
module.exports = { localModels, providerAllowed, providerSettings };
