function createAssistantPcmTransport() {
  let lease = null;
  const failed = () =>
    Object.assign(Error('Не удалось воспроизвести ответ.'), {
      code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
    });
  const fresh = (current) => {
    try {
      return current() === true;
    } catch {
      return false;
    }
  };
  function release(owner) {
    if (!lease || lease.owner !== owner) return;
    const prior = lease;
    lease = null;
    prior.entry?.cancel();
    clearTimeout(prior.timer);
    prior.readyResolve(false);
    prior.worker.onmessage = prior.worker.onerror = prior.worker.onmessageerror = null;
    prior.worker.terminate();
  }
  function acquire(owner) {
    if (lease?.owner === owner) return lease;
    if (lease) release(lease.owner);
    if (typeof window.Worker !== 'function' || typeof window.MessageChannel !== 'function')
      return null;
    const build = document.querySelector?.('meta[name="cartoteca-build"]')?.content;
    if (typeof build !== 'string' || !/^[a-f0-9]{16}$/.test(build)) return null;
    let worker;
    try {
      worker = new window.Worker('/assistant-pcm-pump.js?v=' + build);
    } catch {
      return null;
    }
    let readyResolve;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const token = { owner, worker, ready, readyResolve, entry: null, timer: null };
    lease = token;
    token.timer = setTimeout(() => {
      if (lease === token) release(owner);
    }, 3000);
    worker.onmessage = ({ data }) => {
      if (lease !== token) return;
      if (data?.type === 'ready') {
        if (data.protocol !== 1) {
          release(owner);
          return;
        }
        clearTimeout(token.timer);
        readyResolve(true);
      } else token.entry?.message(data);
    };
    worker.onerror = worker.onmessageerror = () => {
      if (lease !== token) return;
      token.entry?.fail(failed());
      release(owner);
    };
    return token;
  }
  async function prepare(owner, options) {
    if (
      !owner ||
      !options ||
      !Number.isSafeInteger(options.id) ||
      options.id < 1 ||
      typeof options.node?.port?.postMessage !== 'function' ||
      typeof options.current !== 'function' ||
      typeof options.onHeaders !== 'function' ||
      !fresh(options.current)
    )
      return null;
    const token = acquire(owner);
    if (!token || !(await token.ready) || lease !== token || !fresh(options.current)) return null;
    token.entry?.cancel();
    let preparedResolve,
      doneResolve,
      doneReject,
      started = false,
      settled = false,
      closed = false;
    const prepared = new Promise((resolve) => {
      preparedResolve = resolve;
    });
    const done = new Promise((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    void done.catch(() => {});
    const send = (data) => token.worker.postMessage({ id: options.id, ...data });
    const current = () =>
      lease === token && token.entry === entry && !closed && fresh(options.current);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        send({ type: 'cancel' });
      } catch {}
      try {
        options.node.port.postMessage({ type: 'transport-cancel', id: options.id });
      } catch {}
      if (token.entry === entry) token.entry = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      preparedResolve(false);
      doneReject(error);
      close();
    };
    const entry = {
      fail,
      cancel() {
        if (settled) close();
        else fail(failed());
      },
      async message(data) {
        if (data?.id !== options.id || !current()) return;
        if (data.type === 'prepared' && !started) {
          if (data.protocol !== 1) {
            fail(failed());
            release(owner);
            return;
          }
          clearTimeout(timer);
          preparedResolve(true);
        } else if (data.type === 'headers' && started) {
          try {
            const m = data.meta;
            if (
              !m ||
              !Number.isInteger(m.status) ||
              m.status < 100 ||
              m.status > 599 ||
              typeof m.ok !== 'boolean' ||
              ['contentType', 'sampleRate', 'channels', 'sampleFormat', 'serverTiming'].some(
                (key) =>
                  typeof m[key] !== 'string' ||
                  m[key].length > (key === 'serverTiming' ? 2048 : 128),
              )
            )
              throw failed();
            await options.onHeaders(m);
            if (!current()) throw failed();
            send({ type: 'accept' });
          } catch (error) {
            fail(error);
          }
        } else if (data.type === 'firstByte' && started) {
          try {
            options.onFirstByte?.();
          } catch (error) {
            fail(error);
          }
        } else if (data.type === 'end' && started) {
          // The direct worklet channel may not have consumed END yet.
          entry.readComplete = true;
        } else if (data.type === 'error') fail(failed());
      },
    };
    token.entry = entry;
    const timer = setTimeout(() => fail(failed()), 3000);
    try {
      const channel = new window.MessageChannel();
      token.worker.postMessage(
        { type: 'prepare', protocol: 1, id: options.id, port: channel.port2 },
        [channel.port2],
      );
      options.node.port.postMessage(
        { type: 'transport', protocol: 1, id: options.id, port: channel.port1 },
        [channel.port1],
      );
    } catch {
      fail(failed());
    }
    if (!(await prepared) || !current()) {
      close();
      return null;
    }
    return {
      start(request) {
        if (started || !current()) return Promise.reject(failed());
        started = true;
        try {
          send({ type: 'start', url: request?.url, accountContext: request?.accountContext });
        } catch {
          fail(failed());
        }
        return done;
      },
      eof() {
        // Only the guarded main-port worklet EOF receipt proves delivery.
        if (!started || settled || !current()) return;
        settled = true;
        doneResolve();
      },
      cancel() {
        if (!settled) fail(failed());
        else close();
      },
    };
  }
  const api = { prepare, release };
  return { assistantPcmTransport: () => api };
}
