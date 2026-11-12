const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');
const { createMultiServer } = require('../../multi-server.cjs');
const { createSyntheticSeed } = require('../helpers/synthetic-seed.cjs');

async function prepareBrowserData(dir) {
  // No real runtime, environment file, credentials, mail or Telegram adapters.
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const email = 'owner@browser.test',
    password = 'Synthetic-browser-password-2026';
  let storage;
  const dates = Array.from({ length: 4 }, (_, index) => {
    const value = new Date(Date.now() + index * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
    }).format(value);
  });
  try {
    const owner = await platform.registerOwner({
      email,
      password,
      displayName: 'Тестовый специалист',
      organizationName: 'Тестовая организация',
      city: 'Тестовый город',
    });
    platform.verifyEmail(owner.verificationToken);
    const token = (await platform.login(email, password)).token;
    platform.createServiceGroup(token, {
      id: 'care',
      title: 'Основные услуги',
      revision: platform.serviceGroups(owner.organizationId).revision,
    });
    const services = [
      {
        id: 's1',
        name: 'Первичная консультация и подбор программы',
        category: 'care',
        duration: '30 минут',
        price: 1234.5,
      },
      {
        id: 's2',
        name: 'Комплексная индивидуальная процедура',
        category: 'care',
        duration: '45 минут',
        price: 2500,
      },
      {
        id: 's3',
        name: 'Повторная консультация',
        category: 'other',
        duration: '15 минут',
        price: 800,
      },
    ];
    storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
    storage.write({
      revision: 0,
      services,
      patients: [
        {
          id: 'p',
          name: 'Тестовая Клиентка',
          firstName: 'Тестовая',
          lastName: 'Клиентка',
          middleName: '',
          designation: 'Тестовая пометка',
          phone: '+79990000001',
          createdBy: owner.accountId,
          visits: [
            {
              id: 'v',
              date: '2020-01-01',
              procedure: 'Тестовая услуга',
              staffId: owner.accountId,
              photos: [],
            },
          ],
          appointments: [
            {
              id: 'plan',
              date: dates[1],
              time: '14:00',
              duration: 30,
              service: services[0].name,
              staffId: owner.accountId,
              serviceItems: [{ ...services[0], duration: 30 }],
            },
          ],
        },
      ],
    });
    platform.workSchedules.save(
      token,
      {
        staffId: owner.accountId,
        dates,
        status: 'working',
        intervals: [['00:00', '24:00']],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      storage,
    );
    platform.bookingPublication.save(token, {
      enabled: true,
      revision: platform.bookingPublication.view(token).revision,
    });
    // The template has no reusable authenticated session. Each case logs in over HTTP.
    platform.logout(token);
    return { email, password, dates, organizationId: owner.organizationId };
  } finally {
    try {
      storage?.close();
    } finally {
      platform.close();
    }
  }
}

function createBrowserSeed() {
  let preparationDurationMs = 0;
  const seed = createSyntheticSeed({
    name: 'browser',
    async prepare(dir) {
      const started = performance.now();
      try {
        return await prepareBrowserData(dir);
      } finally {
        preparationDurationMs = Math.round(performance.now() - started);
      }
    },
  });
  return {
    clone: () => seed.clone(),
    close: () => seed.close(),
    get preparationDurationMs() {
      return preparationDurationMs;
    },
  };
}

async function closeResources(server, copy, ownedSeed) {
  const errors = [];
  for (const close of [
    async () => {
      if (!server) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        }),
      );
    },
    () => copy?.close(),
    () => ownedSeed?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Synthetic browser fixture cleanup failed');
}

async function createFixture({ seed } = {}) {
  const ownedSeed = seed ? null : createBrowserSeed();
  let copy, server;
  try {
    copy = await (seed || ownedSeed).clone();
    server = createMultiServer({
      dataDir: copy.dir,
      production: false,
      origin: '',
      telegramBot: null,
      supportBot: null,
      sendMail: null,
      telegramAutostart: false,
      supportAutostart: false,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    let closing;
    return {
      base: 'http://127.0.0.1:' + server.address().port,
      directory: copy.dir,
      ...copy.data,
      close() {
        // Concurrent/repeated cleanup must not close a different case's stores.
        return (closing ||= closeResources(server, copy, ownedSeed));
      },
    };
  } catch (error) {
    try {
      await closeResources(server, copy, ownedSeed);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Synthetic browser fixture startup failed');
    }
    throw error;
  }
}
module.exports = { createFixture, createBrowserSeed };
