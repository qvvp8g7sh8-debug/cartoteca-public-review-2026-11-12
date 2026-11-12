const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const marker = 'VOICE-DAY-FLOW-20261016-01';
function profile() {
  const bytes = fs.readFileSync(path.join(root, 'tests/fixtures/assistant-names-120.json'));
  const prior = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  if (prior.synthetic !== true || prior.count !== 120 || prior.clients.length !== 120 ||
      prior.clients[69].firstName !== 'Гульнара' || prior.clients[69].lastName !== 'Хабибуллина')
    throw Error('Unexpected immutable synthetic base corpus');
  const clients = [...prior.clients, {
    firstName: 'Гульнара', lastName: 'Мухамедьянова', middleName: 'Рашидовна',
    designation: 'Тест ИИ 121',
    notes: marker + '/121. Искусственная карточка только изолированной временной fixture; не реальный клиент.',
  }];
  return { synthetic: true, marker, count: clients.length, clients,
    priorCorpusSha256: createHash('sha256').update(bytes).digest('hex'),
    profileSha256: createHash('sha256').update(JSON.stringify(clients)).digest('hex'),
    expectedBaseline: { clients: 121, appointments: 1 } };
}
module.exports = { root, marker, profile };
