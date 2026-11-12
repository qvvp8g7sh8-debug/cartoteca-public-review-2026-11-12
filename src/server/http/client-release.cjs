const fs = require('node:fs'),
  path = require('node:path'),
  { createHash } = require('node:crypto');
// Only public interface files contribute. Never inspect tenant data or configuration.
const releaseFiles = [
  'product.html',
  'product.css',
  'product-content.css',
  'robots.txt',
  'sitemap.xml',
  'privacy.html',
  'consent.html',
  'legal.css',
  'legal.js',
  'booking.html',
  'booking.js',
  'booking.css',
  'index.html',
  'login.html',
  'admin.html',
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'assistant-capture-worklet.js',
  'assistant-playback-worklet.js',
  'assistant-pcm-pump.js',
  'assistant-echo-train.js',
  'login.js',
  'admin.js',
  'security.js',
  'style.css',
  'ui-extra.css',
  'auth.css',
  'admin.css',
  'manifest.webmanifest',
  'service-worker.js',
  'install-app.js',
  'install-app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/contact-call-gloss-v1.png',
  'icons/contact-message-gloss-v1.png',
];
const releases = new Map(),
  pendingReleases = new Map(),
  pinnedReleases = new Map();
// Serving owns one coherent resource snapshot until process restart.
function pinClientRelease(root, version) {
  pinnedReleases.set(root, version);
}
async function clientRelease(root) {
  if (pinnedReleases.has(root)) return pinnedReleases.get(root);
  const stats = await Promise.all(
    releaseFiles.map((file) => fs.promises.stat(path.join(root, file))),
  );
  const signature = stats.map((s) => s.size + ':' + s.mtimeMs + ':' + s.ctimeMs).join('|'),
    cached = releases.get(root);
  if (pinnedReleases.has(root)) return pinnedReleases.get(root);
  if (cached?.signature === signature) return cached.version;
  const prior = pendingReleases.get(root);
  if (prior?.signature === signature) return prior.promise;
  const entry = { signature, promise: null };
  // Metadata is checked separately for every caller. Share only the expensive
  // content/hash pass for this root and its freshly observed signature.
  entry.promise = Promise.resolve().then(async () => {
    try {
      const contents = await Promise.all(
        releaseFiles.map((file) => fs.promises.readFile(path.join(root, file))),
      );
      const hash = createHash('sha256');
      releaseFiles.forEach((file, i) => {
        hash.update(file + '\0');
        hash.update(contents[i]);
      });
      const version = hash.digest('hex').slice(0, 16);
      if (pendingReleases.get(root) === entry) releases.set(root, { signature, version });
      return pinnedReleases.get(root) || version;
    } finally {
      // A superseded completion or rejection must not replace/clear new work.
      if (pendingReleases.get(root) === entry) pendingReleases.delete(root);
    }
  });
  pendingReleases.set(root, entry);
  return entry.promise;
}
function versionedHtml(html, version, resources = {}) {
  const metadata = ['app-settings', 'app-assistant']
    .filter((name) => resources[name + '.js'])
    .map(
      (name) =>
        '<meta name="cartoteca-resource-' + name + '" content="' + resources[name + '.js'] + '">',
    )
    .join('');
  return html
    .replace(
      '</head>',
      '<meta name="cartoteca-build" content="' + version + '">' + metadata + '</head>',
    )
    .replace(/\b(src|href)="(\/?[a-z-]+\.(?:js|css))(?:\?[^"\s]*)?"/g, (match, attribute, file) =>
      releaseFiles.includes(file.replace(/^\//, ''))
        ? attribute + '="' + file + '?v=' + (resources[file.replace(/^\//, '')] || version) + '"'
        : match,
    );
}
function supportTelegram(value = '') {
  const username = String(value)
    .trim()
    .replace(/^https:\/\/t\.me\//, '')
    .replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ? 'https://t.me/' + username : '';
}
module.exports = { clientRelease, versionedHtml, supportTelegram, releaseFiles, pinClientRelease };
