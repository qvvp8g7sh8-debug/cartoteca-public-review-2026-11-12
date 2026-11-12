// Separate from the historical client-only hotfix. Every omission remains explicit.
const { CONTROLLER } = require('./verification-profile-policy.cjs');
const AUDIO_SESSION = Object.freeze({
  selectionMode: 'assistant-audio-session-v1',
  id: 'assistant-mobile-20261018-45',
  sourceHash: 'd0da17ff9ca7cf8092befd3a00c2bebc06d25c65905954e2abae4c0db6b26ba9',
  imageId: 'sha256:16407ec8a8b47fa6e2ef6acd8afb1f43250b22f5389a989186c4e9b574b3b331',
});
const AUDIO_SESSION_CLIENT = new Set([
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'assistant-playback-worklet.js',
  'src/client/manifest.json',
  'src/client/contracts/assistant.d.ts',
  'src/client/contracts/ports.d.ts',
  'src/client/worklets/assistant-playback-worklet.js',
  ...[
    'assistant-playback',
    'assistant-audio',
    'assistant-speech',
    'assistant-barge-in',
    'assistant-presentation',
    'voice-assistant',
  ].map((name) => 'src/client/modules/' + name + '.js'),
]);
const AUDIO_SESSION_SERVER = new Set([
  ...['speech-service', 'speech-tickets', 'speech-cache', 'timeweb-speech-stream', 'pcm-audio'].map(
    (name) => 'src/server/modules/assistant/' + name + '.cjs',
  ),
  'src/server/http/static-files.cjs',
  'src/server/http/client-release.cjs',
]);
// The text of each bridge is pinned to45 and checked for only the exact worklet addition.
const AUDIO_SESSION_BRIDGES = Object.freeze(
  [
    'Dockerfile',
    'scripts/build-client.cjs',
    'scripts/check-architecture.cjs',
    'scripts/release/files.cjs',
    'scripts/release/publication-check.cjs',
    'scripts/release/remote/probe.cjs',
    'src/server/http/client-release.cjs',
    'src/server/http/static-files.cjs',
  ].sort(),
);
const AUDIO_SESSION_INPUTS = Object.freeze(
  ['src/client/manifest.json', ...AUDIO_SESSION_BRIDGES].sort(),
);
const AUDIO_SESSION_CONTROL = new Set([
  ...CONTROLLER,
  'scripts/release/verification-audio-session-policy.cjs',
  'scripts/release/verification-audio-session.cjs',
  'tests/helpers/release-stand-audio-session.cjs',
]);
const AUDIO_SESSION_TESTS = Object.freeze(
  [
    'tests/assistant-mobile-playback.test.cjs',
    'tests/assistant-client-idle-work.test.cjs',
    'tests/voice-assistant-ui.test.cjs',
    'tests/assistant-audio-barge.test.cjs',
    'tests/assistant-audio-preload.test.cjs',
    'tests/assistant-audio-resume-identity.test.cjs',
    'tests/assistant-choice-presentation.test.cjs',
    'tests/assistant-choice-voice-continuation.test.cjs',
    'tests/assistant-inactive-lifecycle.test.cjs',
    'tests/assistant-speech.test.cjs',
    'tests/assistant-speech-text.test.cjs',
    'tests/assistant-microphone-session.test.cjs',
    'tests/assistant-audio.test.cjs',
    'tests/assistant-audio-csp.test.cjs',
    'tests/assistant-barge-in.test.cjs',
    'tests/assistant-pcm-playback.test.cjs',
    'tests/assistant-playback-browser.test.cjs',
    'tests/assistant-pcm-audio.test.cjs',
    'tests/assistant-pcm-stream.test.cjs',
    'tests/assistant-mp3-audio.test.cjs',
    'tests/assistant-speech-stream.test.cjs',
    'tests/assistant-speech-tickets-cache.test.cjs',
    'tests/assistant-speech-stream-handoff.test.cjs',
    'tests/assistant-stream-shared-cancellation.test.cjs',
    'tests/static-interface-cache.test.cjs',
    'tests/client-contracts.test.cjs',
    'tests/release-scoped-profile.test.cjs',
    'tests/release-scoped-evidence.test.cjs',
    'tests/release-scoped-stand.test.cjs',
    'tests/release-profile-cli.test.cjs',
    'tests/release-profile-status.test.cjs',
    'tests/release-image-base.test.cjs',
    'tests/release-flow-native.test.cjs',
    'tests/release-pipeline.test.cjs',
    'tests/release-publication-check.test.cjs',
    'tests/release-audio-hotfix.test.cjs',
    'tests/release-audio-session.test.cjs',
  ].sort(),
);
const AUDIO_SESSION_HTTP = Object.freeze([
  'worklet-auth-and-version',
  'pcm-http-stream',
  'mp3-compatibility',
  'ticket-one-use-and-scope',
  'invalid-pcm-not-forwarded',
  'disconnect-cancels-upstream',
  'format-separated-cache',
  'timeweb-pcm-mislabeled-mime',
]);
module.exports = {
  AUDIO_SESSION,
  AUDIO_SESSION_CLIENT,
  AUDIO_SESSION_SERVER,
  AUDIO_SESSION_BRIDGES,
  AUDIO_SESSION_INPUTS,
  AUDIO_SESSION_CONTROL,
  AUDIO_SESSION_TESTS,
  AUDIO_SESSION_HTTP,
};
