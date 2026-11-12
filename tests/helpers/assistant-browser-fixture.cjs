const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createBrowserSeed, createFixture } = require('../browser/fixture.cjs');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');

// Only copied, temporary browser data is changed. All assistant providers are demo;
// real HTTP authentication, ACL, availability and dialogue code remain in use.
async function configureAssistant(copy) {
  const directory = path.resolve(copy.dir);
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('cartoteca-browser-case-')
  )
    throw Error('Assistant browser setup requires a temporary synthetic browser clone');
  const platform = createPlatformStore(path.join(directory, 'platform'));
  let storage;
  try {
    const login = await platform.login(copy.data.email, copy.data.password);
    const owner = platform.session(login.token);
    if (!owner || owner.organizationId !== copy.data.organizationId)
      throw Error('Synthetic browser owner scope mismatch');
    const admin = await platform.bootstrapGlobalAdmin({
      email: 'assistant-operator@browser.test',
      password: 'Synthetic-assistant-operator-2026',
      displayName: 'Тестовый оператор помощника',
    });
    const api = platform.assistant.admin;
    const command = (revision, values) => ({
      expectedRevision: revision,
      requestId: randomUUID(),
      reason: 'Синтетическая браузерная проверка помощника',
      ...values,
    });
    const configured = api.settings(
      admin.accountId,
      command(api.view(admin.accountId).revision, {
        policy: {
          mode: 'selected',
          commands: { calendar: true, clients: true, prepareAppointment: true },
          limits: { dailyRequests: 1000 },
        },
        providers: {
          stt: { provider: 'demo' },
          llm: { provider: 'demo' },
          tts: { provider: 'demo' },
        },
      }),
    );
    api.setMember(
      admin.accountId,
      command(configured.revision, {
        organizationId: owner.organizationId,
        accountId: owner.accountId,
        enabled: true,
      }),
    );
    storage = createStorage(path.join(directory, 'tenants', owner.organizationId));
    const cabinet = storage.read();
    const original = cabinet.patients[0];
    if (!original) throw Error('Synthetic browser client missing');
    const clients = [
      {
        ...original,
        id: randomUUID(),
        name: 'Анна Семёнова',
        firstName: 'Анна',
        lastName: 'Семёнова',
        middleName: '',
      },
      {
        ...original,
        id: randomUUID(),
        name: 'Ольга Семёнова',
        firstName: 'Ольга',
        lastName: 'Семёнова',
        middleName: '',
        phone: '+79990000002',
        visits: [],
        appointments: [],
      },
    ];
    storage.write({ ...cabinet, patients: clients });
    copy.data.assistantClients = clients.map(({ id, name, firstName, lastName }) => ({
      id,
      name,
      firstName,
      lastName,
    }));
    copy.data.assistantStaff = { id: owner.accountId, name: 'Тестовый специалист' };
    copy.data.assistantServices = cabinet.services.map(({ id, name }) => ({ id, name }));
    platform.logout(login.token);
  } finally {
    try {
      storage?.close();
    } finally {
      platform.close();
    }
  }
}

async function createAssistantBrowserFixture() {
  const seed = createBrowserSeed();
  let fixture;
  try {
    fixture = await createFixture({
      seed: {
        async clone() {
          const copy = await seed.clone();
          try {
            await configureAssistant(copy);
            return copy;
          } catch (error) {
            copy.close();
            throw error;
          }
        },
      },
    });
    let closing;
    return {
      ...fixture,
      close() {
        return (closing ||= (async () => {
          try {
            await fixture.close();
          } finally {
            await seed.close();
          }
        })());
      },
    };
  } catch (error) {
    await seed.close();
    throw error;
  }
}
module.exports = { createAssistantBrowserFixture };
