const fs = require('node:fs/promises');
const path = require('node:path');
const { fail } = require('../../../../../shared/errors.cjs');
async function localSpeechArguments({
  platform,
  directory,
  model,
  input,
  output,
  threads,
  prompt,
}) {
  const windows = platform === 'win32';
  if (windows) {
    if ([model, input, output].some((value) => /[\u0000-\u001f\u007f-\u009f]/u.test(value)))
      throw fail(503, 'Путь локального распознавания содержит недопустимые символы.');
    // Pinned whisper-cli uses narrow Windows file APIs; UTF-8 fixes text, not arbitrary model paths.
    if (!/^[\x20-\x7e]+$/.test(model))
      throw fail(503, 'Для распознавания Windows установите модель в папку с латинским путём.');
    prompt = prompt.replace(/\s+/gu, ' ').trim();
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(prompt))
      throw fail(400, 'Словарь распознавания содержит недопустимые управляющие символы.');
  }
  const args = [
    '-m',
    model,
    '-f',
    windows ? 'input.wav' : input,
    '-l',
    'ru',
    '-t',
    String(threads),
    '-otxt',
    '-of',
    windows ? 'result' : output,
    '-np',
    '-nt',
    ...(prompt ? ['--prompt', prompt] : []),
  ];
  if (!windows) return args;
  // One literal UTF-8 argument per LF line: no BOM, shell escaping or quotes. The outer name is ASCII.
  await fs.writeFile(path.join(directory, 'arguments.rsp'), args.join('\n') + '\n', {
    flag: 'wx',
    mode: 0o600,
    encoding: 'utf8',
  });
  return ['@arguments.rsp'];
}
module.exports = { localSpeechArguments };
