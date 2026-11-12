const { fail } = require('../../../shared/errors.cjs');
const { bufferedRequest, assertTransport } = require('./buffered-request.cjs');
function behaviorVersion(url, key) {
  const value = url.searchParams.get(key);
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw fail(400, 'Укажите номер версии поведения.');
  return Number(value);
}
const routes = [
  {
    method: 'GET',
    path: '/api/admin/voice-assistant',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, c.platform.assistant.admin.view(c.current.accountId));
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/settings',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 32768);
      return c.json(c.res, 200, c.platform.assistant.admin.settings(c.current.accountId, body));
    },
  },
  {
    method: 'GET',
    path: '/api/admin/voice-assistant/member',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.member(
          c.current.accountId,
          c.url.searchParams.get('organizationId'),
          c.url.searchParams.get('accountId'),
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/member',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 4096);
      return c.json(c.res, 200, c.platform.assistant.admin.setMember(c.current.accountId, body));
    },
  },
  {
    method: 'GET',
    path: '/api/admin/voice-assistant/audit',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, c.platform.assistant.admin.audit(c.current.accountId));
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/restore',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 4096);
      return c.json(c.res, 200, c.platform.assistant.admin.restore(c.current.accountId, body));
    },
  },
  {
    method: 'GET',
    path: '/api/admin/voice-assistant/behavior',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, c.platform.assistant.admin.behavior.view(c.current.accountId));
    },
  },
  {
    method: 'GET',
    path: '/api/admin/voice-assistant/behavior/library',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.behavior.library(c.current.accountId, c.url.searchParams),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/voice-assistant/behavior/compare',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.behavior.compare(
          c.current.accountId,
          behaviorVersion(c.url, 'fromVersion'),
          behaviorVersion(c.url, 'toVersion'),
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/behavior/preview',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 128 * 1024);
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.behavior.preview(c.current.accountId, body),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/behavior/approve',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 128 * 1024);
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.behavior.approve(c.current.accountId, body),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/voice-assistant/behavior/restore',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req, 4096);
      return c.json(
        c.res,
        200,
        c.platform.assistant.admin.behavior.restore(c.current.accountId, body),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/assistant/scope',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, c.platform.assistant.currentScope(c));
    },
  },
  {
    method: 'POST',
    path: '/api/assistant/turn',
    access: 'organization',
    async handle(c) {
      return bufferedRequest(c, 16384, async (owned, body) => {
        const result = await owned.platform.assistant.turn(owned, body);
        assertTransport(owned);
        try {
          owned.recordAssistantPlayback?.(
            owned.current,
            body,
            owned.req?.headers?.['x-assistant-audio-summary'],
          );
        } catch {
          /* Optional numeric diagnostics never change a successful turn. */
        }
        return result;
      });
    },
  },
  {
    method: 'POST',
    path: '/api/assistant/execute',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req, 1024);
      // A clinical commit may finish after disconnect; its receipt is reconciled explicitly.
      const result = await c.platform.assistant.execute(c, body);
      if (!c.res.destroyed && !c.res.writableEnded) return c.json(c.res, 200, result);
    },
  },
  {
    method: 'POST',
    path: '/api/assistant/transcribe',
    access: 'organization',
    async handle(c) {
      return bufferedRequest(c, 5 * 1024 * 1024, (owned, body) =>
        owned.platform.assistant.transcribe(owned, body),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/assistant/speak-audio',
    access: 'organization',
    async handle(c) {
      return c.platform.assistant.speakAudio(c);
    },
  },
  {
    method: 'POST',
    path: '/api/assistant/speak-audio',
    access: 'organization',
    async handle(c) {
      // streamSpeech ends the response; bufferedRequest therefore sends no JSON.
      return bufferedRequest(c, 8192, (owned, body) =>
        owned.platform.assistant.speakPcm(owned, body),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/assistant/speak',
    access: 'organization',
    async handle(c) {
      return bufferedRequest(c, 8192, (owned, body) => owned.platform.assistant.speak(owned, body));
    },
  },
];
module.exports = { routes };
