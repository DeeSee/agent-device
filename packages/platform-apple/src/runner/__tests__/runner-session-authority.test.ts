import { runnerRecordingFixture, hasReason } from './runner-recording.fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { ensureRunnerSession } from '../runner-session.ts';
const { mocks } = runnerRecordingFixture;

test('internal selector change restarts the alive runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-internal-cutover' };
  const session = await ensureRunnerSession(device, {});
  mocks.resolveDerived.mockReturnValue('/tmp/derived-next');

  const restarted = await ensureRunnerSession(device, {});

  assert.notEqual(restarted, session);
  assert.equal(restarted.xctestrunArtifact?.derived, '/tmp/derived-next');
  assert.equal(mocks.runBackground.mock.calls.length, 2);
});

test('external selector change restarts instead of reusing the old runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-external-cutover' };
  const first = await ensureRunnerSession(device, { iosXctestrunFile: '/tmp/runner-a.xctestrun' });

  const second = await ensureRunnerSession(device, {
    iosXctestrunFile: '/tmp/runner-b.xctestrun',
  });

  assert.notEqual(second, first);
  assert.equal(second.launchIdentity.selectorFingerprint, '/tmp/runner-b.xctestrun');
  assert.equal(mocks.runBackground.mock.calls.length, 2);
});

test('exact session commands never resolve ambient selectors', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-exact-session' };
  const session = await ensureRunnerSession(device, {});
  mocks.resolveSelection.mockClear();

  const exact = await ensureRunnerSession(device, {
    expectedRunnerSessionId: session.sessionId,
    iosXctestrunFile: '/must/not/be/read.xctestrun',
  });

  assert.equal(exact, session);
  assert.equal(mocks.resolveSelection.mock.calls.length, 0);
  await assert.rejects(
    ensureRunnerSession(device, {
      expectedRunnerSessionId: session.sessionId,
      expectedRunnerLaunchIdentity: {
        ...session.launchIdentity,
        selectorFingerprint: 'wrong-selector',
      },
    }),
    hasReason('runner_session_ownership_changed'),
  );
  assert.equal(mocks.resolveSelection.mock.calls.length, 0);
});
