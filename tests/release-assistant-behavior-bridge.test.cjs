const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { objectHash } = require('../scripts/release/files.cjs');
const { BASELINE, NAMES } = require('../scripts/release/verification-profile-policy.cjs');
const {
  ASSISTANT_BEHAVIOR,
} = require('../scripts/release/verification-assistant-behavior-policy.cjs');
const bridge = require('../scripts/release/verification-assistant-behavior-bridge.cjs');

function fixture() {
  const origin = {
    candidate: BASELINE.id,
    sourceHash: BASELINE.sourceHash,
    imageId: BASELINE.imageId,
    reportSha256: 'a'.repeat(64),
  };
  const fullStand = {
    scenarios: NAMES.map((scenario, index) => ({ scenario, passed: true, value: index })),
  };
  const body = {
    version: 1,
    profile: 'assistant-ui',
    selectionMode: 'assistant-audio-session-v1',
    candidate: ASSISTANT_BEHAVIOR.id,
    sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
    baseline: { id: BASELINE.id, sourceHash: BASELINE.sourceHash, imageId: BASELINE.imageId },
    inheritedStand: {
      file: 'verification-baseline/stand-report.json',
      sha256: origin.reportSha256,
    },
    fingerprints: { protected: 'b'.repeat(64) },
  };
  const profile = { ...body, profileHash: objectHash(body) };
  const stand = {
    kind: 'assistant-ui-scoped-stand',
    candidate: ASSISTANT_BEHAVIOR.id,
    sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
    imageId: ASSISTANT_BEHAVIOR.imageId,
    profile: 'assistant-ui',
    profileHash: profile.profileHash,
    selectionMode: profile.selectionMode,
    scope: 'targeted',
    fullVerification: false,
    passed: true,
    scenarios: fullStand.scenarios.map((row, index) => ({
      ...row,
      execution: index < 33 ? 'inherited' : 'fresh',
      origin:
        index < 33
          ? origin
          : {
              candidate: ASSISTANT_BEHAVIOR.id,
              sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
              imageId: 'sha256:' + 'd'.repeat(64),
            },
    })),
    provenance: {
      inherited: { ...origin, scenarios: 33, protectedHash: profile.fingerprints.protected },
      fresh: {
        binding: {
          candidate: ASSISTANT_BEHAVIOR.id,
          sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
          profileHash: profile.profileHash,
          requestedImageId: ASSISTANT_BEHAVIOR.imageId,
          innerImageId: 'sha256:' + 'd'.repeat(64),
        },
      },
    },
  };
  return { stand, profile, fullStand, origin };
}
const check = ({ stand, profile, fullStand, origin }) =>
  bridge.validatePublishedInheritance(stand, profile, fullStand, origin);

test('published50 inheritance preserves all33 exact full41 payloads and origins', () => {
  assert.equal(check(fixture()), true);
  for (let index = 0; index < 33; index++) {
    const f = fixture();
    f.stand.scenarios[index].value++;
    assert.throws(() => check(f), /core payload/);
  }
});
test('bridge rejects changed source/image/profile, missing provenance and false fresh inheritance', () => {
  for (const mutate of [
    (f) => {
      f.stand.sourceHash = 'c'.repeat(64);
    },
    (f) => {
      f.stand.imageId = 'sha256:' + 'c'.repeat(64);
    },
    (f) => {
      f.profile.sourceHash = 'c'.repeat(64);
    },
    (f) => {
      delete f.stand.provenance;
    },
    (f) => {
      f.stand.scenarios[0].execution = 'fresh';
    },
    (f) => {
      f.stand.scenarios[0].origin = { ...f.origin, candidate: ASSISTANT_BEHAVIOR.id };
    },
    (f) => {
      f.stand.scenarios[36].passed = false;
    },
    (f) => {
      f.stand.scenarios[36].execution = 'inherited';
    },
    (f) => {
      f.stand.scenarios.pop();
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f));
  }
});
test('raw production proof pins reject same-size substitutions and missing sidecars', () => {
  const pin = bridge.PUBLISHED.stand;
  assert.throws(() => bridge.pinned(Buffer.alloc(pin.bytes), pin), /evidence changed/);
  assert.throws(() => bridge.pinned(Buffer.from('{}'), pin), /size changed/);
  assert.equal(bridge.PROFILE_HASH.length, 64);
  assert.notEqual(bridge.PUBLISHED.profile.sha256, bridge.PUBLISHED.stand.sha256);
});
test('production wrapper rechecks candidate and protected core before cached evidence', (t) => {
  const behavior = require('../scripts/release/verification-assistant-behavior.cjs');
  let checked = false;
  t.mock.method(behavior, 'assertBehaviorBase', () => true);
  t.mock.method(behavior, 'assertBehaviorInputs', () => {
    checked = true;
    throw Error('PROTECTED_CORE_CHANGED');
  });
  assert.throws(
    () => bridge.validateBehaviorBridge({ data: {} }, {}, {}, {}),
    /PROTECTED_CORE_CHANGED/,
  );
  assert.equal(checked, true);
});
test('fresh preparation refuses unpinned production50 report without overwriting any receipt', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-bridge-pins-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const published = path.join(temp, 'published'),
    target = path.join(temp, 'candidate');
  fs.mkdirSync(path.join(published, 'stand'), { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(
    path.join(published, 'stand/stand-report.json'),
    Buffer.alloc(bridge.PUBLISHED.stand.bytes),
  );
  assert.throws(
    () => bridge.prepareBehaviorBridge(temp, { directory: target }, () => published),
    /evidence changed/,
  );
  assert.deepEqual(fs.readdirSync(target), []);
});
