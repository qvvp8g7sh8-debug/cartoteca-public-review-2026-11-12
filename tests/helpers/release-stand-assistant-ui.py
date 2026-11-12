"""Fresh assistant-ui image delivery checks; inherited backend evidence is composed separately.

Invokes the unchanged release-stand.py scenario function for the four ordinary
publication-gate cases. This raw report attests only those four executions.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_stand_original', HERE / 'release-stand.py')
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
fixture, command, scenario = original.fixture, original.command, original.scenario
FRESH = [
    'publication-gate-after-disconnect',
    'publication-gate-without-migration',
    'publication-gate-startup-failure-returns-current',
    'publication-gate-activation-failure-keeps-current-data',
]
VERIFY = """const path=require('node:path');
const source=path.resolve(process.argv[1]),root=path.resolve(source,'../../../..');
const candidate=require(source+'/scripts/release/state.cjs').readCandidate(root,process.argv[2]);
if(candidate.source!==source)throw Error('Candidate source differs');
const profile=require(source+'/scripts/release/verification-profile.cjs').verifyProfile(root,candidate);
if(!profile||profile.profile!=='assistant-ui')throw Error('Explicit assistant-ui profile required');
console.log(JSON.stringify({profileHash:profile.profileHash,selectionMode:profile.selectionMode,standPartition:profile.standPartition}));"""


def main():
    if len(sys.argv) != 4:
        raise ValueError('Expected source, immutable image ID and fresh report path')
    source, image, report = Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3]).absolute()
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'Immutable image required'
    assert report.parent == source.parent / 'stand' and not report.is_symlink(), 'Fresh candidate stand directory required'
    candidate = json.loads((source.parent / 'candidate.json').read_text())
    assert candidate['profile'] == 'assistant-ui'
    verified = json.loads(command('node', '--max-old-space-size=192', '-e', VERIFY, str(source), candidate['id'], timeout=90))
    assert verified['standPartition']['fresh'] == FRESH, 'Fresh stand partition differs'
    assert len(verified['standPartition']['inherited']) == 33
    assert verified['profileHash'] == candidate['profileHash']
    identity = dict(candidate=candidate['id'], sourceHash=candidate['sourceHash'],
                    profile='assistant-ui', profileHash=verified['profileHash'], imageId=image)
    with report.open('x') as output:
        json.dump(dict(identity, passed=False, scenarios=[], stage='setup'), output)
    report_identity = (report.stat().st_dev, report.stat().st_ino)
    stand = None
    audio_http = None
    behavior_http = None
    behavior = verified.get('selectionMode') == 'assistant-behavior-v1'
    session = verified.get('selectionMode') == 'assistant-audio-session-v1' or behavior
    try:
        if session:
            helper = source / 'tests/helpers/release-stand-audio-session.cjs'
            assert helper.is_file() and not helper.is_symlink()
            helper_sha = hashlib.sha256(helper.read_bytes()).hexdigest()
            assert helper_sha == candidate['files']['tests/helpers/release-stand-audio-session.cjs']['sha256']
            audio_identity = dict(candidate=identity['candidate'], sourceHash=identity['sourceHash'], profileHash=identity['profileHash'], imageId=identity['imageId'], helperSha256=helper_sha)
            audio_http = json.loads(command('docker', 'run', '--rm', '--network', 'none',
                '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
                '--mount', 'type=bind,source='+str(helper)+',target=/stand/audio-session.cjs,readonly',
                '--entrypoint', 'node', image, '/stand/audio-session.cjs',
                json.dumps(audio_identity, separators=(',', ':')), timeout=120))
            assert audio_http.get('passed') is True, 'Fresh audio HTTP checks failed'
        if behavior:
            helper = source / 'tests/helpers/release-stand-assistant-behavior.cjs'
            assert helper.is_file() and not helper.is_symlink()
            helper_sha = hashlib.sha256(helper.read_bytes()).hexdigest()
            assert helper_sha == candidate['files']['tests/helpers/release-stand-assistant-behavior.cjs']['sha256']
            behavior_identity = dict(candidate=identity['candidate'], sourceHash=identity['sourceHash'], profileHash=identity['profileHash'], imageId=identity['imageId'], helperSha256=helper_sha)
            behavior_http = json.loads(command('docker', 'run', '--rm', '--network', 'none',
                '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
                '--mount', 'type=bind,source='+str(helper)+',target=/stand/assistant-behavior.cjs,readonly',
                '--entrypoint', 'node', image, '/stand/assistant-behavior.cjs',
                json.dumps(behavior_identity, separators=(',', ':')), timeout=180))
            assert behavior_http.get('passed') is True, 'Fresh behavior HTTP checks failed'
        stand = fixture.Fixture(str(source), image)
        assert stand.new == image, 'Fixture image differs from loaded immutable image'
        # Setup only, not an inherited scenario execution. The original full main
        # reaches these cases with schema17/key-file data from the preceding group.
        stand.reset(17, key_file=True)
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand, 'publication-gate-after-disconnect', schema=17, publication_gate=True)
        scenario(stand, 'publication-gate-without-migration', schema=17, publication_gate=True)
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand, 'publication-gate-startup-failure-returns-current', schema=17, failure='startup', publication_gate=True)
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand, 'publication-gate-activation-failure-keeps-current-data', schema=17, failure='activation', publication_gate=True)
    finally:
        try:
            assert not report.is_symlink() and (report.stat().st_dev, report.stat().st_ino) == report_identity
            rows = stand.results if stand else []
            extra = dict(audioSessionHttp=audio_http) if session else {}
            if behavior:
                extra['assistantBehaviorHttp'] = behavior_http
            report.write_text(json.dumps(dict(identity,
                passed=[row['scenario'] for row in rows] == FRESH and all(row['passed'] is True for row in rows)
                    and (not session or bool(audio_http and audio_http.get('passed') is True))
                    and (not behavior or bool(behavior_http and behavior_http.get('passed') is True)),
                scenarios=rows, setupPriming=dict(schema=17, keyFile=True, scenarioCount=0), **extra), indent=2))
        finally:
            if stand:
                stand.close()


if __name__ == '__main__':
    main()
