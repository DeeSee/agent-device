import { runnerRecordingFixture, hasReason } from './runner-recording.fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { ensureRunnerSession } from '../runner-session.ts';
import {
  acquireRunnerRecordingPin,
  disposeRunnerAfterRejectedRecordingStart,
  getRunnerSessionSnapshot,
  releaseRunnerRecordingPin,
  updateRunnerRecordingPin,
} from '../runner-recording-authority.ts';
const { mocks } = runnerRecordingFixture;

test('recording authority blocks cutover and stale recording tokens', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-recording-pin' };
  const session = await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'record-start-1', remotePath: 'tmp/recording-1.mp4' },
    {},
  );
  mocks.resolveDerived.mockReturnValue('/tmp/derived-next');

  await assert.rejects(ensureRunnerSession(device, {}), hasReason('runner_session_pinned'));
  await assert.rejects(
    updateRunnerRecordingPin(
      device.id,
      { ...authority, startCommandId: 'stale-record-start' },
      'finalized',
    ),
    hasReason('runner_session_ownership_changed'),
  );
  await assert.rejects(
    releaseRunnerRecordingPin(device.id, authority, 'retrieved'),
    hasReason('runner_recording_not_finalized'),
  );

  await updateRunnerRecordingPin(device.id, authority, 'finalized');
  await releaseRunnerRecordingPin(device.id, authority, 'retrieved');
  const restarted = await ensureRunnerSession(device, {});
  assert.notEqual(restarted.sessionId, session.sessionId);
});

test('rejected recording disposal retains the exact pin through runner effects', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-rejected-start-disposal' };
  await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'rejected-record-start' },
    {},
  );
  let runnerAlive = true;
  mocks.isProcessAlive.mockImplementation(
    (pid: number | undefined) => pid === process.pid || (pid === 4242 && runnerAlive),
  );
  mocks.signalPids.mockImplementation(() => {
    assert.deepEqual(getRunnerSessionSnapshot(device.id)?.recordingAuthority, authority);
    runnerAlive = false;
  });

  await disposeRunnerAfterRejectedRecordingStart(device.id, authority);

  assert.equal(getRunnerSessionSnapshot(device.id), null);
  assert.ok(mocks.signalPids.mock.calls.length > 0);
});

test('failed rejected-recording disposal leaves the exact reuse fence intact', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-rejected-start-failure' };
  await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'rejected-record-start' },
    {},
  );
  await assert.rejects(
    disposeRunnerAfterRejectedRecordingStart(device.id, authority),
    hasReason('runner_disposal_unconfirmed'),
  );

  assert.deepEqual(getRunnerSessionSnapshot(device.id)?.recordingAuthority, authority);
  await assert.rejects(
    acquireRunnerRecordingPin(device, { startCommandId: 'competing-record-start' }, {}),
    hasReason('runner_session_pinned'),
  );

  mocks.isProcessAlive.mockImplementation((pid?: number) => pid === process.pid);
  await disposeRunnerAfterRejectedRecordingStart(device.id, authority);
});
