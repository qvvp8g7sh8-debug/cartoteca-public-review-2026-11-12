const path = require('node:path');

// Public URLs stay stable; handwritten browser sources live beside other client sources.
const staticSources = Object.freeze({
  'product.html': 'src/client/static/product.html',
  'product.css': 'src/client/static/product.css',
  'product-content.css': 'src/client/static/product-content.css',
  'robots.txt': 'src/client/static/robots.txt',
  'sitemap.xml': 'src/client/static/sitemap.xml',
  'index.html': 'src/client/static/index.html',
  'style.css': 'src/client/static/style.css',
  'auth.css': 'src/client/static/auth.css',
  'admin.html': 'src/client/static/admin.html',
  'admin.css': 'src/client/static/admin.css',
  'concept-clients.html': 'src/client/static/concept-clients.html',
  'concept-card.html': 'src/client/static/concept-card.html',
  'concept.css': 'src/client/static/concept.css',
  'concept-links.css': 'src/client/static/concept-links.css',
  'concept-card.js': 'src/client/static/concept-card.js',
  'icons/icon-192.png': 'src/client/static/icons/icon-192.png',
  'icons/icon-512.png': 'src/client/static/icons/icon-512.png',
  'icons/icon-maskable-512.png': 'src/client/static/icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png': 'src/client/static/icons/apple-touch-icon.png',
  'icons/contact-call-gloss-v1.png': 'src/client/static/icons/contact-call-gloss-v1.png',
  'icons/contact-message-gloss-v1.png': 'src/client/static/icons/contact-message-gloss-v1.png',
});
const generatedFiles = Object.freeze([
  'ui-extra.css',
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'login.html',
  'privacy.html',
  'consent.html',
  'legal.css',
  'legal.js',
  'booking.html',
  'booking.css',
  'booking.js',
  'login.js',
  'install-app.js',
  'install-app.css',
  'admin.js',
  'security.js',
  'assistant-capture-worklet.js',
  'assistant-playback-worklet.js',
  'assistant-pcm-pump.js',
  'assistant-echo-train.js',
  'manifest.webmanifest',
  'service-worker.js',
]);
const files = Object.freeze([...Object.keys(staticSources), ...generatedFiles]);
const publicAssetRoot = (projectRoot) => path.join(projectRoot, 'dist', 'public');
// Served only by the temporary loopback MAX setup tool, never by the main website.
const setupSources = Object.freeze({
  'max-setup.html': 'src/client/setup/max-setup.html',
  'max-setup.js': 'src/client/setup/max-setup.js',
  'max-setup.css': 'src/client/setup/max-setup.css',
});
const setupAssetRoot = (projectRoot) => path.join(projectRoot, 'dist', 'setup');

module.exports = {
  files,
  staticSources,
  generatedFiles,
  publicAssetRoot,
  setupSources,
  setupAssetRoot,
};
