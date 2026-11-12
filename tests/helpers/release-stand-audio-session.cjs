// Runs mounted read-only inside the exact image. Only temporary synthetic data and loopback HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const CASES = [
  'worklet-auth-and-version',
  'pcm-http-stream',
  'mp3-compatibility',
  'ticket-one-use-and-scope',
  'invalid-pcm-not-forwarded',
  'disconnect-cancels-upstream',
  'format-separated-cache',
  'timeweb-pcm-mislabeled-mime',
];
const PCM = Buffer.from([0, 0, 255, 127, 0, 128, 255, 255]);
const MP3 = Buffer.alloc(417);
Buffer.from([255, 251, 144, 100]).copy(MP3);

function identity(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'candidate',
    'helperSha256',
    'imageId',
    'profileHash',
    'sourceHash',
  ]);
  assert.match(value.candidate, /^[a-z0-9][a-z0-9-]{0,79}$/);
  for (const field of ['sourceHash', 'profileHash', 'helperSha256'])
    assert.match(value[field], /^[a-f0-9]{64}$/);
  assert.match(value.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    value.helperSha256,
  );
  return value;
}
async function main(input) {
  const verified = identity(input),
    root = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-audio-image-'));
  const originalFetch = globalThis.fetch;
  const cases = [],
    providerCalls = [],
    rejectedOutbounds = [];
  let store, server, origin, ownerSession, otherSession, revision, releaseProvider;
  let providerMode = 'pcm',
    providerAborted = false;
  const command = (expectedRevision, values) => ({
    expectedRevision,
    requestId: randomUUID(),
    reason: 'Synthetic image audio acceptance',
    ...values,
  });
  const provider = async (url, options) => {
    if (url !== 'https://api.timeweb.ai/v1/audio/speech') {
      rejectedOutbounds.push(true);
      throw Error('UNEXPECTED_OUTBOUND');
    }
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.ok(['mp3', 'pcm'].includes(body.response_format));
    if (body.response_format === 'pcm') assert.equal(body.speed, 1.4);
    else assert.equal(body.speed, undefined);
    providerCalls.push({ format: body.response_format });
    if (providerMode === 'invalid')
      return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
    if (providerMode === 'mislabeled') {
      const bytes = Buffer.concat([PCM, PCM, PCM, PCM]);
      let ended = false;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 3));
          controller.enqueue(bytes.subarray(3, 15));
          controller.enqueue(bytes.subarray(15, 17));
          releaseProvider = () => {
            if (ended) return;
            ended = true;
            controller.enqueue(bytes.subarray(17));
            controller.close();
          };
        },
      });
      return new Response(stream, { headers: { 'content-type': 'audio/mpeg' } });
    }
    if (providerMode === 'progressive' || providerMode === 'cancel') {
      providerAborted = false;
      let controller,
        ended = false;
      const stop = () => {
        if (ended) return;
        ended = true;
        providerAborted = true;
        try {
          controller.error(Error('SYNTHETIC_PROVIDER_CANCELLED'));
        } catch {}
      };
      options.signal.addEventListener('abort', stop, { once: true });
      const stream = new ReadableStream({
        start(value) {
          controller = value;
          controller.enqueue(PCM.subarray(0, 3));
          releaseProvider = () => {
            if (ended) return;
            ended = true;
            options.signal.removeEventListener('abort', stop);
            controller.enqueue(PCM.subarray(3));
            controller.close();
          };
        },
        cancel() {
          providerAborted = true;
          ended = true;
          options.signal.removeEventListener('abort', stop);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'audio/pcm' } });
    }
    return new Response(body.response_format === 'pcm' ? PCM : MP3, {
      headers: { 'content-type': body.response_format === 'pcm' ? 'audio/pcm' : 'audio/mpeg' },
    });
  };
  function request(route, { body, session = ownerSession, onData, cancel = false } = {}) {
    return new Promise((resolve, reject) => {
      const raw = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        origin + route,
        {
          method: raw === null ? 'GET' : 'POST',
          agent: false,
          headers: {
            ...(session
              ? {
                  Cookie: 'cartoteca_v2_session=' + session.token,
                  'X-Cartoteca-Account-Id': session.account.id,
                  'X-Cartoteca-Organization-Id': session.organizationId || '',
                }
              : {}),
            Origin: origin,
            'X-Cartoteca-Request': '1',
            'Content-Type': 'application/json',
            ...(raw === null ? {} : { 'Content-Length': Buffer.byteLength(raw) }),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0,
            settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) });
          };
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              req.destroy(Error('OVERSIZED_SYNTHETIC_HTTP'));
              return;
            }
            chunks.push(chunk);
            try {
              onData?.(chunk);
            } catch (error) {
              req.destroy(error);
              reject(error);
              return;
            }
            if (cancel) {
              res.destroy();
              req.destroy();
              finish();
            }
          });
          res.on('end', finish);
          res.on('error', (error) => {
            if (!cancel) reject(error);
          });
        },
      );
      req.setTimeout(8000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT')));
      req.on('error', (error) => {
        if (!cancel) reject(error);
      });
      if (raw !== null) req.write(raw);
      req.end();
    });
  }
  const parsed = (response) => JSON.parse(response.bytes.toString('utf8'));
  async function ticket(format, text) {
    const response = await request('/api/assistant/speak', {
      body: { policyVersion: revision, text, format, stream: true },
    });
    assert.equal(response.status, 200);
    const result = parsed(response);
    assert.match(result.streamUrl, /^\/api\/assistant\/speak-audio\?ticket=[A-Za-z0-9_-]{43}$/);
    return result;
  }
  try {
    globalThis.fetch = provider;
    const { createPlatformStore } = require(path.join(root, 'platform-store.cjs'));
    store = createPlatformStore(path.join(directory, 'platform'));
    const password = 'Synthetic-audio-image-password-2026';
    const owner = await store.registerOwner({
      email: 'audio-owner@synthetic.test',
      password,
      displayName: 'Синтетический владелец',
      organizationName: 'Синтетический стенд',
      city: 'Казань',
    });
    store.verifyEmail(owner.verificationToken);
    const other = await store.registerOwner({
      email: 'audio-other@synthetic.test',
      password,
      displayName: 'Другой владелец',
      organizationName: 'Другая синтетическая организация',
      city: 'Казань',
    });
    store.verifyEmail(other.verificationToken);
    const admin = await store.bootstrapGlobalAdmin({
      email: 'audio-operator@synthetic.test',
      password,
      displayName: 'Синтетический оператор',
    });
    ownerSession = await store.login('audio-owner@synthetic.test', password);
    otherSession = await store.login('audio-other@synthetic.test', password);
    const settings = store.assistant.admin;
    let view = settings.settings(
      admin.accountId,
      command(settings.view(admin.accountId).revision, {
        policy: { mode: 'selected', limits: { dailyRequests: 1000 } },
        providers: {
          tts: { provider: 'timeweb', model: 'openai/gpt-4o-mini-tts', voice: 'alloy' },
        },
        timewebApiKey: 'synthetic-audio-image-provider-key',
      }),
    );
    settings.setMember(
      admin.accountId,
      command(view.revision, {
        organizationId: owner.organizationId,
        accountId: owner.accountId,
        enabled: true,
      }),
    );
    server = require(path.join(root, 'multi-server.cjs')).createMultiServer({
      dataDir: directory,
      host: '127.0.0.1',
      port: 0,
      production: false,
      origin: '',
      additionalOrigins: [],
      trustedProxies: [],
      processRole: 'web',
      releaseGate: false,
      sendMail: null,
      telegramBot: null,
      supportBot: null,
      supportDelivery: { telegram: null, email: null },
      telegramAutostart: false,
      telegramIdentityAutostart: false,
      maxAutostart: false,
      pushAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
      commonNotificationsEnabled: false,
      scheduledNotifications: false,
      maxEnabled: false,
      maxConnectionsEnabled: false,
      pushEnabled: false,
      assistantAppointmentSavingEnabled: false,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = 'http://127.0.0.1:' + server.address().port;
    const scope = await request('/api/assistant/scope');
    assert.equal(scope.status, 200);
    assert.equal(parsed(scope).enabled, true);
    revision = parsed(scope).policyVersion;
    for (const name of CASES) {
      try {
        if (name === 'worklet-auth-and-version') {
          const build = await require(
            path.join(root, 'src/server/http/client-release.cjs'),
          ).clientRelease(root);
          const route = '/assistant-playback-worklet.js?v=' + build;
          assert.equal((await request(route, { session: null })).status, 401);
          const current = await request(route);
          assert.equal(current.status, 200);
          assert.match(current.headers['content-type'], /^text\/javascript/);
          assert.equal(
            createHash('sha256').update(current.bytes).digest('hex'),
            createHash('sha256')
              .update(fs.readFileSync(path.join(root, 'dist/public/assistant-playback-worklet.js')))
              .digest('hex'),
          );
          assert.equal((await request('/assistant-playback-worklet.js?v=stale')).status, 409);
        } else if (name === 'pcm-http-stream') {
          providerMode = 'progressive';
          const result = await ticket('pcm', 'Синтетический потоковый ответ.');
          assert.deepEqual(
            [
              result.mimeType,
              result.sampleRate,
              result.channels,
              result.sampleFormat,
              result.playbackRate,
            ],
            ['audio/pcm', 24000, 1, 's16le', 1],
          );
          let first = true;
          const audio = await request(result.streamUrl, {
            onData(chunk) {
              if (!first) return;
              first = false;
              assert.equal(chunk.length, 2);
              assert.equal(providerAborted, false);
              releaseProvider();
            },
          });
          assert.equal(first, false);
          assert.equal(audio.status, 200);
          assert.equal(audio.headers['content-type'], 'audio/pcm');
          assert.equal(audio.headers['x-audio-sample-rate'], '24000');
          assert.equal(audio.headers['x-audio-channels'], '1');
          assert.equal(audio.headers['x-audio-sample-format'], 's16le');
          assert.equal(audio.headers['cache-control'], 'no-store');
          assert.deepEqual(audio.bytes, PCM);
          providerMode = 'pcm';
        } else if (name === 'mp3-compatibility') {
          const response = await request('/api/assistant/speak', {
            body: { text: 'Синтетический MP3 ответ.', policyVersion: revision, stream: true },
          });
          assert.equal(response.status, 200);
          const audio = await request(parsed(response).streamUrl);
          assert.equal(audio.headers['content-type'], 'audio/mpeg');
          assert.deepEqual(audio.bytes, MP3);
        } else if (name === 'ticket-one-use-and-scope') {
          const result = await ticket('pcm', 'Синтетический одноразовый билет.');
          assert.equal((await request(result.streamUrl, { session: otherSession })).status, 428);
          const foreign = new URL(result.streamUrl, 'http://synthetic.invalid');
          foreign.searchParams.set('accountContext', otherSession.account.id);
          foreign.searchParams.set('organizationContext', otherSession.organizationId || '');
          assert.equal(
            (await request(foreign.pathname + foreign.search, { session: otherSession })).status,
            403,
          );
          assert.equal((await request(result.streamUrl)).status, 200);
          assert.equal((await request(result.streamUrl)).status, 410);
          assert.equal(
            (
              await request('/api/assistant/speak', {
                body: {
                  text: 'Синтетическая устаревшая версия.',
                  stream: true,
                  format: 'pcm',
                  policyVersion: revision - 1,
                },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request('/api/assistant/speak', {
                body: {
                  text: 'Синтетический неверный формат.',
                  stream: true,
                  format: 'wav',
                  policyVersion: revision,
                },
              })
            ).status,
            400,
          );
          const revoked = await ticket('pcm', 'Синтетический отзыв доступа.');
          view = settings.setMember(
            admin.accountId,
            command(settings.view(admin.accountId).revision, {
              organizationId: owner.organizationId,
              accountId: owner.accountId,
              enabled: false,
            }),
          );
          assert.equal((await request(revoked.streamUrl)).status, 403);
          settings.setMember(
            admin.accountId,
            command(view.revision, {
              organizationId: owner.organizationId,
              accountId: owner.accountId,
              enabled: true,
            }),
          );
          revision = parsed(await request('/api/assistant/scope')).policyVersion;
        } else if (name === 'invalid-pcm-not-forwarded') {
          providerMode = 'invalid';
          const result = await ticket('pcm', 'Синтетический неверный поток.');
          const response = await request(result.streamUrl);
          assert.equal(response.status, 502);
          assert.match(response.headers['content-type'], /^application\/json/);
          assert.equal(response.bytes.includes(MP3), false);
          providerMode = 'pcm';
        } else if (name === 'disconnect-cancels-upstream') {
          providerMode = 'cancel';
          const result = await ticket('pcm', 'Синтетическая отмена потока.');
          await request(result.streamUrl, { cancel: true });
          const deadline = Date.now() + 1500;
          while (!providerAborted && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(providerAborted, true);
          providerMode = 'pcm';
        } else if (name === 'format-separated-cache') {
          const before = providerCalls.length;
          for (const format of ['mp3', 'pcm', 'mp3', 'pcm']) {
            const result = await ticket(format, 'Во сколько записать?'),
              audio = await request(result.streamUrl);
            assert.equal(audio.status, 200);
            assert.deepEqual(audio.bytes, format === 'pcm' ? PCM : MP3);
          }
          assert.deepEqual(
            providerCalls.slice(before).map((row) => row.format),
            ['mp3', 'pcm'],
          );
        } else if (name === 'timeweb-pcm-mislabeled-mime') {
          providerMode = 'mislabeled';
          const result = await ticket('pcm', 'Синтетический ответ с ошибочной маркировкой шлюза.');
          let first = true;
          const audio = await request(result.streamUrl, {
            onData(chunk) {
              if (!first) return;
              first = false;
              assert.equal(chunk.length, 16);
              releaseProvider();
            },
          });
          assert.equal(first, false);
          assert.equal(audio.status, 200);
          assert.equal(audio.headers['content-type'], 'audio/pcm');
          assert.equal(audio.headers['x-audio-sample-rate'], '24000');
          assert.deepEqual(audio.bytes, Buffer.concat([PCM, PCM, PCM, PCM]));
          providerMode = 'pcm';
        }
        cases.push({ case: name, passed: true });
      } catch (error) {
        releaseProvider?.();
        providerMode = 'pcm';
        cases.push({ case: name, passed: false });
        console.error(
          JSON.stringify({ case: name, reason: error.code || error.name || 'CASE_FAILED' }),
        );
      }
    }
    assert.equal(rejectedOutbounds.length, 0);
  } finally {
    releaseProvider?.();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    store?.close();
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-audio-image-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const result = {
    version: 1,
    ...verified,
    syntheticOnly: true,
    externalProviderRequests: 0,
    passed: cases.length === CASES.length && cases.every((row) => row.passed),
    cases,
  };
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
  return result;
}
module.exports = { main, CASES };
if (require.main === module)
  main(JSON.parse(process.argv[2])).catch((error) => {
    console.error(
      JSON.stringify({ reason: error.code || error.name || 'AUDIO_HTTP_STAND_FAILED' }),
    );
    process.exitCode = 1;
  });
