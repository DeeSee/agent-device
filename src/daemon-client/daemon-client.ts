import type {
  DaemonRequest as SharedDaemonRequest,
  DaemonResponse as SharedDaemonResponse,
} from '../daemon/daemon-request.ts';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
export type DaemonRequest = SharedDaemonRequest;
export type DaemonResponse = SharedDaemonResponse;

export async function sendToDaemon(
  req: Omit<DaemonRequest, 'token'>,
  options: AgentDeviceDaemonTransportContext & { onProgress?: RequestProgressSink } = {},
): Promise<DaemonResponse> {
  const { sendToDaemon: send } = await import('./daemon-client-request.ts');
  return await send(req, options);
}
