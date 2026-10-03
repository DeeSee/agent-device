import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';
import { prepareUploadArtifact } from '../upload-client-artifact.ts';
import { uploadArtifact } from '../upload-client.ts';
import { streamFileToHttpRequest } from '../upload-stream.ts';

function canceledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  return controller.signal;
}

test('pre-canceled remote artifact preparation performs no local-path work', async () => {
  await assert.rejects(
    prepareRemoteRequestArtifacts(
      {
        session: 'qa',
        command: 'install',
        positionals: ['/path-that-must-not-be-read'],
        flags: { platform: 'ios' },
      },
      { baseUrl: 'https://daemon.example.test', token: 'token' },
      canceledSignal(),
    ),
    isRequestCanceledError,
  );
});

test('pre-canceled upload preparation does not stat or hash its path', async () => {
  await assert.rejects(
    prepareUploadArtifact('/path-that-must-not-be-read', 'ios', canceledSignal()),
    isRequestCanceledError,
  );
});

test('pre-canceled upload client does not prepare or contact an endpoint', async () => {
  await assert.rejects(
    uploadArtifact({
      localPath: '/path-that-must-not-be-read',
      baseUrl: 'https://daemon.example.test',
      token: 'token',
      signal: canceledSignal(),
    }),
    isRequestCanceledError,
  );
});

test('pre-canceled upload stream does not load transport or read its path', async () => {
  await assert.rejects(
    streamFileToHttpRequest({
      url: new URL('https://daemon.example.test/upload'),
      method: 'POST',
      headers: {},
      payloadPath: '/path-that-must-not-be-read',
      timeoutMessage: 'timeout',
      errorMessage: 'error',
      signal: canceledSignal(),
    }),
    isRequestCanceledError,
  );
});
