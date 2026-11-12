const { configuredTelegram } = require('../notifications/telegram-adapter.cjs');
const nodemailer = require('nodemailer');
function configuredSupportDelivery(env = process.env) {
  const token = env.CARTOTECA_SUPPORT_BOT_TOKEN || '',
    chat = env.CARTOTECA_SUPPORT_CHAT_ID || '';
  if (
    !token ||
    token === env.TELEGRAM_BOT_TOKEN ||
    !/^\d+:[A-Za-z0-9_-]{20,150}$/.test(token) ||
    !/^[1-9]\d{0,15}$/.test(chat)
  )
    return { telegram: null, email: null };
  const bot = configuredTelegram({ token }),
    username = env.CARTOTECA_SUPPORT_BOT_USERNAME || 'CartotecaExampleBot';
  const telegram = {
    async initialize() {
      const info = await bot.initialize();
      if (info.username.toLowerCase() !== username.toLowerCase()) throw Error('Wrong support bot.');
    },
    send: (text, signal) => bot.send(chat, text, null, signal),
  };
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, CARTOTECA_SUPPORT_EMAIL } =
    env;
  let email = null;
  if (
    SMTP_HOST &&
    SMTP_USER &&
    SMTP_PASSWORD &&
    SMTP_FROM &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(CARTOTECA_SUPPORT_EMAIL || '')
  ) {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: (Number(SMTP_PORT) || 465) === 465,
      requireTLS: true,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      connectionTimeout: 15000,
      socketTimeout: 20000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    email = (text, job) =>
      transport.sendMail({
        from: SMTP_FROM,
        to: CARTOTECA_SUPPORT_EMAIL,
        replyTo: job.payload.email,
        subject: 'Картотека — обращение ' + job.request_id,
        text,
        messageId: '<support-' + job.request_id + '@cartoteca.invalid>',
      });
  }
  return { telegram, email };
}
function supportMessage(job, origin = '') {
  const p = job.payload,
    d = p.diagnostics;
  return [
    'Картотека — обращение в поддержку',
    '№ ' + job.request_id,
    origin
      ? 'Открыть обращение: ' + origin + '/admin.html#case=' + encodeURIComponent(job.request_id)
      : '',
    'От: ' + p.displayName,
    'Ответить: ' + p.email,
    p.organization ? 'Организация: ' + p.organization : '',
    '',
    p.description,
    ...(d
      ? [
          '',
          'Версия: ' + (d.version || 'не определена'),
          'Раздел: ' + d.view,
          'Экран: ' + d.width + ' × ' + d.height,
          'Связь устройства: ' + (d.online ? 'есть сеть' : 'нет сети'),
        ]
      : []),
  ]
    .filter((line) => line !== null)
    .join('\n');
}
function createSupportRuntime({
  store,
  telegram = null,
  email = null,
  clock = Date.now,
  origin = '',
  canRun = () => true,
  runBackgroundWork = (callback) => callback(),
}) {
  let connected = false,
    busy = false,
    timer = null,
    controller = null,
    running = false,
    epoch = 0,
    lastInitialize = 0;
  const status = () => ({ available: Boolean(telegram), emailEnabled: Boolean(email), connected });
  async function tick() {
    if (busy || !telegram || !canRun()) return;
    busy = true;
    const signal = controller?.signal,
      generation = epoch;
    const active = () => generation === epoch && !signal?.aborted && canRun();
    try {
      if (!connected && clock() - lastInitialize >= 60000) {
        lastInitialize = clock();
        try {
          await telegram.initialize();
          if (active()) connected = true;
        } catch {
          connected = false;
        }
      }
      for (const [channel, send] of [
        ['telegram', connected ? (text, job) => telegram.send(text, signal) : null],
        ['email', email],
      ]) {
        if (!send) continue;
        for (let i = 0; i < 5 && active(); i++) {
          const job = await runBackgroundWork(
            () => {
              if (active()) return store.claim(channel, clock());
            },
            '',
            active,
          );
          if (!job) break;
          if (!active()) break;
          try {
            await send(supportMessage(job, origin), job);
          } catch (e) {
            if (!active()) break;
            const failed = job.attempts >= 5 || e.providerCode === 403;
            store.finish(
              job,
              failed ? 'failed' : 'pending',
              clock() +
                Math.max(Math.min(3600, 30 * 2 ** job.attempts), Number(e.retryAfter) || 0) * 1000,
            );
            continue;
          }
          // A successful provider response remains known after stop. Do not
          // turn a settlement DB failure into an explicit transport retry.
          store.finish(job, 'sent', clock());
        }
      }
    } catch {
      /* Transient database/transport failure: the durable queue is retried on the next tick. */
    } finally {
      busy = false;
    }
  }
  function start() {
    if (running) return;
    running = true;
    controller = new AbortController();
    void tick();
    timer = setInterval(() => {
      void tick();
    }, 20000);
    timer.unref?.();
  }
  function stop() {
    epoch++;
    running = false;
    controller?.abort();
    clearInterval(timer);
  }
  return { status, tick, start, stop };
}
module.exports = { configuredSupportDelivery, createSupportRuntime, supportMessage };
