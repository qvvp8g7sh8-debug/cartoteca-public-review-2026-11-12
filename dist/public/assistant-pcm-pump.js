// Dedicated protected-GET PCM producer. No UI state, content diagnostics or retries.
let active = null,
  lastId = 0;
const MAX_BYTES = 4 * 1024 * 1024,
  CAPACITY = 48000;
function live(entry) {
  return active === entry && !entry.cancelled;
}
function cancel(entry) {
  if (!entry || entry.cancelled) return;
  entry.cancelled = true;
  clearTimeout(entry.timer);
  entry.controller.abort();
  void entry.reader?.cancel().catch(() => {});
  if (!entry.reader) void entry.response?.body?.cancel?.().catch(() => {});
  entry.acceptReject?.(Error('cancelled'));
  entry.roomReject?.(Error('cancelled'));
  entry.port.onmessage = entry.port.onmessageerror = null;
  entry.port.close();
  if (active === entry) active = null;
}
function failure(entry) {
  if (!live(entry)) return;
  self.postMessage({ type: 'error', id: entry.id });
  cancel(entry);
}
function requestUrl(request) {
  const context = request.accountContext;
  if (
    !context ||
    typeof context.accountId !== 'string' ||
    typeof context.organizationId !== 'string' ||
    !context.accountId ||
    !context.organizationId ||
    context.accountId.length > 200 ||
    context.organizationId.length > 200 ||
    typeof request.url !== 'string' ||
    request.url.length > 2048
  )
    throw Error('invalid');
  const url = new URL(request.url, self.location.origin);
  if (
    url.origin !== self.location.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/api/assistant/speak-audio' ||
    [...url.searchParams.keys()].length !== 3 ||
    ['ticket', 'accountContext', 'organizationContext'].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('ticket') || '') ||
    url.searchParams.get('accountContext') !== context.accountId ||
    url.searchParams.get('organizationContext') !== context.organizationId
  )
    throw Error('invalid');
  return url.href;
}
async function pump(entry, request) {
  try {
    const url = requestUrl(request);
    entry.timer = setTimeout(() => failure(entry), 150000);
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: entry.controller.signal,
      headers: {
        'X-Cartoteca-Account-Id': request.accountContext.accountId,
        'X-Cartoteca-Organization-Id': request.accountContext.organizationId,
      },
    });
    entry.response = response;
    if (!live(entry)) {
      void response.body?.cancel?.().catch(() => {});
      return;
    }
    const header = (name, maximum = 128) => {
      const value = response.headers.get(name) || '';
      if (value.length > maximum) throw Error('invalid');
      return value;
    };
    const meta = {
      status: response.status,
      ok: response.ok,
      contentType: header('content-type'),
      sampleRate: header('x-audio-sample-rate'),
      channels: header('x-audio-channels'),
      sampleFormat: header('x-audio-sample-format'),
      serverTiming: header('server-timing', 2048),
    };
    const accepted = new Promise((resolve, reject) => {
      entry.acceptResolve = resolve;
      entry.acceptReject = reject;
    });
    self.postMessage({ type: 'headers', id: entry.id, meta });
    await accepted;
    entry.acceptResolve = entry.acceptReject = null;
    if (!live(entry)) return;
    if (
      !response.ok ||
      meta.contentType.split(';')[0].trim() !== 'audio/pcm' ||
      meta.sampleRate !== '24000' ||
      meta.channels !== '1' ||
      meta.sampleFormat !== 's16le' ||
      !response.body?.getReader
    )
      throw Error('invalid');
    entry.reader = response.body.getReader();
    let remainder = null,
      bytes = 0,
      arrivalGroup = 0;
    while (live(entry)) {
      const { value, done } = await entry.reader.read();
      if (!live(entry)) return;
      if (done) {
        if (remainder !== null || !bytes) throw Error('invalid');
        entry.port.postMessage({ type: 'end', id: entry.id });
        self.postMessage({ type: 'end', id: entry.id });
        clearTimeout(entry.timer);
        return;
      }
      if (!(value instanceof Uint8Array) || !value.length) throw Error('invalid');
      arrivalGroup++;
      if (!bytes) self.postMessage({ type: 'firstByte', id: entry.id });
      bytes += value.length;
      if (bytes > MAX_BYTES) throw Error('invalid');
      const input = new Uint8Array(value.length + (remainder === null ? 0 : 1));
      if (remainder !== null) input[0] = remainder;
      input.set(value, remainder === null ? 0 : 1);
      const length = input.length - (input.length % 2),
        view = new DataView(input.buffer);
      remainder = input.length % 2 ? input[input.length - 1] : null;
      for (let offset = 0; offset < length;) {
        const count = Math.min(4096, (length - offset) / 2);
        while (live(entry) && entry.sent - entry.consumed + count > CAPACITY)
          await new Promise((resolve, reject) => {
            entry.roomResolve = resolve;
            entry.roomReject = reject;
          });
        entry.roomResolve = entry.roomReject = null;
        if (!live(entry)) return;
        const samples = new Int16Array(count);
        for (let i = 0; i < count; i++) samples[i] = view.getInt16(offset + i * 2, true);
        entry.sent += count;
        entry.port.postMessage({ type: 'buffer', id: entry.id, arrivalGroup, samples }, [
          samples.buffer,
        ]);
        offset += count * 2;
      }
    }
  } catch {
    failure(entry);
  }
}
self.onmessage = ({ data }) => {
  if (data?.type === 'prepare') {
    if (
      data.protocol !== 1 ||
      !Number.isSafeInteger(data.id) ||
      data.id <= lastId ||
      !data.port?.postMessage
    )
      return;
    cancel(active);
    lastId = data.id;
    const entry = {
      id: data.id,
      port: data.port,
      controller: new AbortController(),
      cancelled: false,
      started: false,
      ready: false,
      sent: 0,
      consumed: 0,
      timer: null,
      reader: null,
      response: null,
      acceptResolve: null,
      acceptReject: null,
      roomResolve: null,
      roomReject: null,
    };
    active = entry;
    entry.port.onmessage = ({ data: message }) => {
      if (!live(entry) || message?.id !== entry.id) return;
      if (message.type === 'ready' && !entry.ready) {
        if (message.protocol !== 1) {
          failure(entry);
          return;
        }
        entry.ready = true;
        self.postMessage({ type: 'prepared', protocol: 1, id: entry.id });
      } else if (message.type === 'progress') {
        if (
          !Number.isSafeInteger(message.consumed) ||
          message.consumed < entry.consumed ||
          message.consumed > entry.sent
        ) {
          failure(entry);
          return;
        }
        entry.consumed = message.consumed;
        entry.roomResolve?.();
      } else if (message.type === 'error') failure(entry);
    };
    entry.port.onmessageerror = () => failure(entry);
    entry.port.start?.();
  } else {
    const entry = active;
    if (!entry || data?.id !== entry.id) return;
    if (data.type === 'cancel') cancel(entry);
    else if (data.type === 'accept' && entry.started) entry.acceptResolve?.();
    else if (data.type === 'start') {
      if (!entry.ready || entry.started) {
        failure(entry);
        return;
      }
      entry.started = true;
      void pump(entry, data);
    }
  }
};
self.postMessage({ type: 'ready', protocol: 1 });
