// A finite, explicitly requested release of the already reviewed50→58 assistant changes.
// Hashes are the normal copySnapshot LF representation, never a broad assistant path grant.
const ASSISTANT_BEHAVIOR = Object.freeze({
  selectionMode: 'assistant-behavior-v1',
  id: 'assistant-audio-session-20261018-50',
  sourceHash: '10ce506ae19dc28fa1aaf04335ab133b356d49c50938b36705a41dd44ad85a10',
  imageId: 'sha256:ac7128cd15cd5fc194af7be569f1f7d643e2e737f379e85732b170b8557de292',
});
const BEHAVIOR_FILES = Object.freeze({
  ...require('./verification-assistant-behavior-runtime.json'),
  ...require('./verification-assistant-behavior-tests.json'),
});
const BEHAVIOR_CONTROL = new Set([
  'scripts/release.cjs',
  'scripts/release/prepare.cjs',
  'scripts/release/verification-profile.cjs',
  'scripts/release/scoped-evidence.cjs',
  'scripts/release/scoped-stand.cjs',
  'scripts/release/verification-assistant-behavior-policy.cjs',
  'scripts/release/verification-assistant-behavior.cjs',
  'scripts/release/verification-assistant-behavior-bridge.cjs',
  'scripts/release/verification-assistant-behavior-runtime.json',
  'scripts/release/verification-assistant-behavior-tests.json',
  'tests/helpers/release-stand-assistant-ui.py',
  'tests/helpers/release-stand-assistant-behavior.cjs',
  'tests/release-assistant-behavior.test.cjs',
  'tests/release-assistant-behavior-http.test.cjs',
  'tests/release-assistant-behavior-wiring.test.cjs',
  'tests/release-assistant-behavior-bridge.test.cjs',
  'tests/release-profile-cli.test.cjs',
  'tests/release-scoped-evidence.test.cjs',
  'tests/release-scoped-profile.test.cjs',
  'tests/release-scoped-stand.test.cjs',
]);
const BEHAVIOR_CORE = Object.freeze([
  'src/shared/appointment-time.cjs',
  'src/server/modules/cabinet/validation.cjs',
]);
const BEHAVIOR_TESTS = Object.freeze(
  [
    ...new Set([
      ...Object.keys(BEHAVIOR_FILES).filter((name) => name.endsWith('.test.cjs')),
      'tests/appointment-time.test.cjs',
      'tests/appointment-commands.test.cjs',
      'tests/assistant-appointment-save.test.cjs',
      'tests/assistant-executor-authority.test.cjs',
      'tests/assistant-production-autosave.test.cjs',
      'tests/assistant-outside-hours-confirmation.test.cjs',
      'tests/assistant-playback-browser.test.cjs',
      'tests/release-scoped-profile.test.cjs',
      'tests/release-scoped-evidence.test.cjs',
      'tests/release-scoped-stand.test.cjs',
      'tests/release-profile-cli.test.cjs',
      'tests/release-profile-status.test.cjs',
      'tests/release-image-base.test.cjs',
      'tests/release-flow-native.test.cjs',
      'tests/release-pipeline.test.cjs',
      'tests/release-publication-check.test.cjs',
      'tests/release-audio-session.test.cjs',
      'tests/release-audio-hotfix.test.cjs',
      'tests/release-deployment.test.cjs',
      'tests/release-assistant-behavior.test.cjs',
      'tests/release-assistant-behavior-http.test.cjs',
      'tests/release-assistant-behavior-wiring.test.cjs',
      'tests/release-assistant-behavior-bridge.test.cjs',
    ]),
  ].sort(),
);
// Fresh image checks are produced independently by the synthetic HTTP stand.
const ASSISTANT_BEHAVIOR_HTTP = Object.freeze([
  'structured-output-and-action-guard',
  'create-complete-and-idempotent',
  'create-clarifications-preserve-fields',
  'move-explicit-and-relative',
  'move-time-required-and-busy',
  'cancel-bound-confirmation-and-replay',
  'delete-alias-safe-cancellation',
  'client-card-visible-choice',
  'calendar-read-vs-edit',
  'rights-and-five-minute-guard',
]);
const BEHAVIOR_HTTP = ASSISTANT_BEHAVIOR_HTTP;
module.exports = {
  ASSISTANT_BEHAVIOR,
  BEHAVIOR_FILES,
  BEHAVIOR_CONTROL,
  BEHAVIOR_CORE,
  BEHAVIOR_TESTS,
  BEHAVIOR_HTTP,
  ASSISTANT_BEHAVIOR_HTTP,
};
