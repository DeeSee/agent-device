import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  resolveRequestTimeoutHint,
  shouldPreserveRunnerAfterRequestTimeout,
} from '../daemon-client/daemon-client-timeout.ts';

test('recording timeout preserves both daemon and runner authority', () => {
  assert.equal(resolveCommandTimeoutPolicy('record').onTimeout, 'preserve-daemon-and-runner');
  assert.equal(shouldPreserveRunnerAfterRequestTimeout('record'), true);
  assert.equal(shouldPreserveRunnerAfterRequestTimeout('snapshot'), false);
  assert.equal(shouldPreserveRunnerAfterRequestTimeout(undefined), false);
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      preserveRunner: true,
      command: 'record',
      appleCleanupEvidence: true,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out record request was canceled; the daemon and XCTest runner were kept alive so the exact durable resource can be retried or recovered.',
  );
});
