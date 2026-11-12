const path = require('node:path');
const os = require('node:os');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');
// Explicit fixture setup, never an HTTP interception or validation bypass.
async function workingDays(directory, email, password, dates, staffIds) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('cartoteca-')) throw Error('Synthetic directory required');
  const platform = createPlatformStore(path.join(directory, 'platform'));
  let storage, token;
  try {
    token = (await platform.login(email, password)).token;
    const session = platform.session(token);
    storage = createStorage(path.join(directory, 'tenants', session.organizationId));
    for (const staffId of staffIds || [session.accountId])
      for (const date of dates) {
        const view = platform.workSchedules.view(token, staffId, date, date);
        platform.workSchedules.save(token, { staffId, dates: [date], status: 'working',
          intervals: [['00:00', '24:00']], revision: view.revision,
          expectedTimeZone: view.timeZone }, storage);
      }
  } finally { if (token) platform.logout(token); storage?.close(); platform.close(); }
}
module.exports = { workingDays };
