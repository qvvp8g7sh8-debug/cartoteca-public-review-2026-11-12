// Initial reviewed bridge: only the published full41 proof can qualify this profile.
const BASELINE = Object.freeze({
  id: 'assistant-production-20261017-41',
  sourceHash: '5a76c8ebd9df8c9d2a95af8f6a0700a44a2c0f24f18937bd3f4ce9c493e97b28',
  imageId: 'sha256:a51df1ca7333ed653a6532594577a9367cb4d9a352268a400b202b9da472ede5',
});
const POLICY = 'assistant-ui-v1';
// Explicitly requested targeted correction of the currently published client audio path.
const AUDIO_HOTFIX = Object.freeze({
  selectionMode: 'client-audio-hotfix-v1',
  id: 'assistant-mobile-20261018-43',
  sourceHash: 'a522b10daa1887315c392778291786fced073a5c78f2646df01498157d821682',
  imageId: 'sha256:018094e72a666fa19f5068427057be2ebf340e9eac38d27c936746368e9d4980',
});
const AUDIO_HOTFIX_UI = new Set([
  'src/client/modules/assistant-audio.js',
  'src/client/modules/assistant-trigger.js',
  'app.js',
  'app-settings.js',
  'app-assistant.js',
]);
const AUDIO_HOTFIX_TESTS = Object.freeze(
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
    'tests/assistant-microphone-session.test.cjs',
    'tests/assistant-audio.test.cjs',
    'tests/assistant-audio-csp.test.cjs',
    'tests/assistant-barge-in.test.cjs',
    'tests/release-scoped-profile.test.cjs',
    'tests/release-scoped-evidence.test.cjs',
    'tests/release-scoped-stand.test.cjs',
    'tests/release-profile-cli.test.cjs',
    'tests/release-profile-status.test.cjs',
    'tests/release-image-base.test.cjs',
    'tests/release-flow-native.test.cjs',
    'tests/release-pipeline.test.cjs',
    'tests/release-audio-hotfix.test.cjs',
  ].sort(),
);

const UI = new Set([
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'ui-extra.css',
  'src/client/manifest.json',
  'src/client/contracts/assistant.d.ts',
  'src/client/contracts/ports.d.ts',
  'src/client/styles/voice-assistant.css',
  ...[
    'assistant-audio',
    'assistant-barge-in',
    'assistant-presentation',
    'assistant-speech',
    'assistant-trigger',
    'voice-assistant',
  ].map((name) => 'src/client/modules/' + name + '.js'),
]);
// These are freshly qualified control-plane changes, never inherited executor changes.
const CONTROLLER = new Set([
  'scripts/release.cjs',
  'scripts/release/prepare.cjs',
  'scripts/release/plan.cjs',
  'scripts/release/status.cjs',
  'scripts/release/runner.cjs',
  'scripts/release/package.cjs',
  'scripts/release/deployment-plan.cjs',
  'scripts/release/files.cjs',
  'scripts/release/verification-profile-policy.cjs',
  'scripts/release/verification-profile.cjs',
  'scripts/release/scoped-evidence.cjs',
  'scripts/release/scoped-stand.cjs',
  'scripts/release/scoped-image.cjs',
  'scripts/release/scoped-tests.cjs',
  'scripts/release/image-base.cjs',
  'tests/helpers/release-stand-assistant-ui.py',
]);
const EXTRA_TESTS = new Set([
  'ui.test.cjs',
  'admin-ui.test.cjs',
  'tests/browser-separation.test.cjs',
  'tests/static-interface-cache.test.cjs',
  'tests/support-cache.test.cjs',
  'tests/deferred-settings.test.cjs',
  'tests/deferred-settings-http.test.cjs',
  'tests/client-contracts.test.cjs',
]);
function freshTest(name) {
  return (
    EXTRA_TESTS.has(name) ||
    /^tests\/(?:assistant-|voice-assistant|release-)[\w-]*\.test\.cjs$/.test(name)
  );
}
function documentation(name) {
  return (
    (name.startsWith('docs/') && name.endsWith('.md')) ||
    ['AGENTS.md', 'ARCHITECTURE.md', 'DEPLOYMENT.md', 'release-baseline.json'].includes(name)
  );
}
const PINS = Object.freeze({
  'image-oci.json': [
    'image-oci.json',
    16356,
    '4a42b6eb683211c0d68ae7f19ebbaacca290e4ec195c67738b92f0410be4aa38',
  ],
  'windows-report.json': [
    'reports/windows/report.json',
    33119,
    '88afb72888481753c45165fbaed22eeff64b1dec569a3a4fcfd438ffaf90a4b3',
  ],
  'windows-unit.jsonl': [
    'reports/windows/attempt-1792248008674-b2b6bfd7-cb91-48b2-bece-ae4178b03ed8/unit.jsonl',
    1763314,
    '27fe96ecc3b6163ffc32a4578a119f9e74044702918f10499d57c1ba7b10e845',
  ],
  'linux-report.json': [
    'reports/linux/report.json',
    36677,
    '49cb646528735089a7ff747059794c32fe850b17aa59cb5ba69171c7a8b49e3a',
  ],
  'linux-unit.jsonl': [
    'reports/linux/attempt-1792248050815-566625a5-f7ab-44fe-8a3e-d03fa6b4e4b0/unit.jsonl',
    1690515,
    'fe209657a0767a88a7fbea87612000fbf61bc25c32910514b1b2ab79293db145',
  ],
  'stand-report.json': [
    'stand/stand-report.json',
    80769,
    'f609194b9b532b28aba834ef0b880892199563969a4a1379beb9c46165ed14e4',
  ],
  'image.json': [
    'image-1792249507213/image.json',
    1198,
    '726427e9eb279fd29b0d91643102966f8846a9fee45a99eae6c6377109cc89e0',
  ],
});
const NAMES = Object.freeze([
  'success-after-disconnect-and-duplicate-launch',
  'damaged-archive',
  'backup-failed-before-switch',
  'concurrent-release-lock',
  'startup-failure-rolls-back',
  'schema-15-without-migration',
  'staff-max-15-to-16-after-disconnect',
  'schema-16-without-migration',
  'staff-max-preparation-failure-keeps-schema15',
  'staff-max-gated-startup-failure-returns-schema15',
  'staff-max-activation-failure-keeps-new-data',
  'staff-max-directory-key-15-to-16',
  'staff-push-16-to-17-after-disconnect',
  'schema-17-without-migration',
  'staff-push-preparation-failure-keeps-schema16',
  'staff-push-gated-startup-failure-returns-schema16',
  'staff-push-activation-failure-keeps-new-data',
  'staff-push-directory-key-16-to-17',
  'structural-17-to-18-after-disconnect',
  'schema-18-without-migration',
  'structural-preparation-failure-keeps-schema17',
  'structural-gated-startup-failure-returns-schema17',
  'structural-activation-failure-keeps-new-data',
  'read-budget-17-after-disconnect',
  'read-budget-17-without-migration',
  'read-budget-preparation-failure-keeps-schema17',
  'read-budget-gated-startup-failure-returns-schema17',
  'read-budget-activation-failure-keeps-new-data',
  'booking-links-17-after-disconnect',
  'booking-links-17-without-migration',
  'booking-links-preparation-failure-keeps-schema17',
  'booking-links-gated-startup-failure-returns-schema17',
  'booking-links-activation-failure-keeps-new-data',
  'publication-gate-after-disconnect',
  'publication-gate-without-migration',
  'publication-gate-startup-failure-returns-current',
  'publication-gate-activation-failure-keeps-current-data',
]);
module.exports = {
  BASELINE,
  POLICY,
  UI,
  CONTROLLER,
  PINS,
  NAMES,
  freshTest,
  documentation,
  AUDIO_HOTFIX,
  AUDIO_HOTFIX_UI,
  AUDIO_HOTFIX_TESTS,
};
