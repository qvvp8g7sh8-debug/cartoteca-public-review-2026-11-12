const { fail } = require('../../../../../shared/errors.cjs');
const { parseModelIntent } = require('../../interpretation/intents.cjs');

const disabledCodeModeNotice =
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

function createOutputParser({ installedVersion = '', parseResponse = parseModelIntent } = {}) {
  let pending = '',
    text = '',
    completed = false,
    usage = null,
    threadStarted = false,
    turnStarted = false,
    startupNoticeSeen = false;
  function line(value) {
    if (!value.trim()) return;
    let event;
    try {
      event = JSON.parse(value);
    } catch {
      throw fail(502, 'Codex вернул неподдерживаемый ответ.');
    }
    if (completed) throw fail(502, 'Codex вернул лишние события после ответа.');
    if (event.type === 'thread.started') {
      threadStarted = true;
      return;
    }
    if (event.type === 'turn.started') {
      turnStarted = true;
      return;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      const candidate = event.usage;
      if (
        candidate &&
        Number.isSafeInteger(candidate.input_tokens) &&
        candidate.input_tokens >= 0 &&
        Number.isSafeInteger(candidate.output_tokens) &&
        candidate.output_tokens >= 0
      )
        usage = { input_tokens: candidate.input_tokens, output_tokens: candidate.output_tokens };
      return;
    }
    if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
      if (event.item?.type === 'error') {
        if (
          installedVersion === 'codex-cli 0.162.0-alpha.17.2' &&
          event.type === 'item.completed' &&
          threadStarted &&
          !turnStarted &&
          !startupNoticeSeen &&
          event.item.message === disabledCodeModeNotice
        ) {
          startupNoticeSeen = true;
          return;
        }
        throw fail(502, 'Не удалось выполнить команду через локальный Codex.');
      }
      if (!event.item || !['agent_message', 'reasoning'].includes(event.item.type))
        throw fail(502, 'Codex попытался вызвать инструмент. Команда остановлена.');
      turnStarted = true;
      if (event.item.type === 'agent_message' && event.type === 'item.completed') {
        if (typeof event.item.text !== 'string' || Buffer.byteLength(event.item.text) > 16384)
          throw fail(502, 'Ответ Codex превышает ограничение.');
        text = event.item.text;
      }
      return;
    }
    throw fail(502, 'Codex не завершил команду. Проверьте доступ и лимиты подписки.');
  }
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, index);
        pending = pending.slice(index + 1);
        line(value);
      }
      if (Buffer.byteLength(pending) > 65536) throw fail(502, 'Ответ Codex превышает ограничение.');
    },
    finish() {
      if (pending.trim()) line(pending);
      if (!completed || !text) throw fail(502, 'Codex не завершил команду.');
      const intent = parseResponse(text);
      return { text: JSON.stringify(intent), usage };
    },
  };
}
module.exports = { createOutputParser };
