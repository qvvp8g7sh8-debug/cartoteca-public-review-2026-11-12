const nodemailer = require('nodemailer');
const { emailMessage } = require('./email-message.cjs');
function configuredMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) return null;
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
  return (to, url, metadata = {}) =>
    transport.sendMail({
      from: SMTP_FROM,
      to: { address: to },
      ...emailMessage(url, metadata),
    });
}
module.exports = { configuredMailer };
