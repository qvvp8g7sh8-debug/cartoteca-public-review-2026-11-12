const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fail } = require('../../../../../shared/errors.cjs');
const {
  localEnabled,
  findExecutable,
  childEnvironment,
  overrides,
  inferenceArgs,
} = require('./codex-config.cjs');
const { runProcess } = require('./codex-process.cjs');
const { createOutputParser } = require('./codex-output.cjs');
const { modelOutputContract } = require('../../interpretation/model-output-contract.cjs');

function temporaryDirectory() {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'cartoteca-codex-'));
  if (path.dirname(fs.realpathSync(directory)) !== parent)
    throw fail(503, 'Не удалось подготовить изолированную папку Codex.');
  return { parent, directory };
}
function cleanup(temp) {
  if (
    !temp ||
    path.dirname(temp.directory) !== temp.parent ||
    !path.basename(temp.directory).startsWith('cartoteca-codex-')
  )
    return;
  try {
    if (
      fs.lstatSync(temp.directory).isSymbolicLink() ||
      fs.realpathSync(temp.directory) !== temp.directory
    )
      return;
    fs.rmSync(temp.directory, { recursive: true, force: true });
  } catch {}
}
function configuredServers(text) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    throw fail(503, 'Не удалось определить изоляцию подключений Codex.');
  }
  if (!Array.isArray(entries) || entries.length > 100)
    throw fail(503, 'Не удалось определить изоляцию подключений Codex.');
  const names = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !entry.name.length ||
      entry.name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(entry.name)
    )
      throw fail(503, 'Конфигурация подключений Codex не поддерживается локальным помощником.');
    names.push(entry.name);
  }
  return names;
}
function createCodexRuntime(options = {}, dependencies = {}) {
  const env = childEnvironment(dependencies.env || process.env);
  const executable = localEnabled(options)
    ? (dependencies.findExecutable || findExecutable)(env)
    : null;
  const execute = dependencies.runProcess || runProcess;
  let busy = false,
    poisoned = false;
  return {
    // Installed/local eligibility only. Authentication is checked for each explicit command.
    get available() {
      return Boolean(executable && !poisoned);
    },
    async run({ payload, provider, timeoutMs, guard = () => {}, onOutbound = () => {} }) {
      if (!executable || poisoned)
        throw fail(503, 'Codex доступен только в разрешённом локальном режиме.');
      if (busy) throw fail(429, 'Codex уже обрабатывает команду. Дождитесь ответа.');
      if (
        !provider ||
        typeof provider.model !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,119}$/.test(provider.model)
      )
        throw fail(400, 'Укажите корректную модель Codex.');
      if (
        !Array.isArray(payload?.messages) ||
        payload.messages.length !== 2 ||
        payload.messages[0]?.role !== 'system' ||
        payload.messages[1]?.role !== 'user' ||
        payload.messages.some((message) => typeof message.content !== 'string')
      )
        throw fail(400, 'Некорректная команда для Codex.');
      const input = JSON.stringify({ messages: payload.messages }) + '\n';
      if (Buffer.byteLength(input) > 32768)
        throw fail(
          413,
          'Запрос Codex превышает 32 КБ. Сократите инструкции, словарь, примеры или текст команды.',
        );
      if (!Number.isInteger(timeoutMs) || timeoutMs < 3000 || timeoutMs > 30000)
        throw fail(400, 'Некорректное время ожидания Codex.');
      const outputContract = modelOutputContract(payload);
      busy = true;
      let temp,
        preserveTemp = false;
      const deadline = Date.now() + timeoutMs;
      try {
        guard();
        temp = temporaryDirectory();
        const base = { executable, cwd: temp.directory, env, deadline, guard };
        const version = await execute({
          ...base,
          args: ['--version'],
          stdoutLimit: 4096,
          stderrLimit: 4096,
        });
        const installedVersion = version.stdout.trim();
        if (
          !/^codex-cli 0\.154\.\d+$/.test(installedVersion) &&
          installedVersion !== 'codex-cli 0.162.0-alpha.17.2'
        )
          throw fail(
            503,
            'Установленная версия Codex CLI пока не поддержана локальным помощником.',
          );
        const config = overrides(temp.directory, env, [], installedVersion);
        let auth;
        try {
          auth = await execute({
            ...base,
            args: ['login', 'status', ...config],
            stdoutLimit: 8192,
          });
        } catch (error) {
          if (error.codexExitCode !== undefined)
            throw fail(503, 'Войдите в Codex CLI через ChatGPT на этом компьютере.');
          throw error;
        }
        if (!/^Logged in using ChatGPT\b/m.test(auth.stdout + '\n' + auth.stderr))
          throw fail(503, 'Войдите в Codex CLI через ChatGPT на этом компьютере.');
        // Listing configuration does not start MCP servers. Never log or return its transport data.
        const listing = await execute({
          ...base,
          args: ['mcp', 'list', '--json', ...config],
          stdoutLimit: 131072,
        });
        const servers = configuredServers(listing.stdout);
        fs.writeFileSync(
          path.join(temp.directory, 'response.schema.json'),
          JSON.stringify(outputContract.schema),
          { flag: 'wx', mode: 0o600 },
        );
        fs.writeFileSync(
          path.join(temp.directory, 'instructions.txt'),
          outputContract.instructions,
          {
            flag: 'wx',
            mode: 0o600,
          },
        );
        const parser = createOutputParser({
          installedVersion,
          parseResponse: outputContract.parseResponse,
        });
        guard();
        if (Date.now() >= deadline) throw fail(504, 'Истекло время ответа Codex.');
        const admitted = onOutbound();
        if (admitted && typeof admitted.then === 'function') await admitted;
        guard();
        if (Date.now() >= deadline) throw fail(504, 'Истекло время ответа Codex.');
        await execute({
          ...base,
          args: inferenceArgs(temp.directory, env, provider.model, servers, installedVersion),
          input,
          onStdout: (chunk) => parser.push(chunk),
        });
        guard();
        return parser.finish();
      } catch (error) {
        if (error.codexCleanupFailed) {
          poisoned = true;
          preserveTemp = true;
        }
        if (error.status) throw error;
        throw fail(502, 'Не удалось выполнить команду через локальный Codex.');
      } finally {
        if (!preserveTemp) cleanup(temp);
        busy = false;
      }
    },
  };
}
module.exports = { createCodexRuntime };
