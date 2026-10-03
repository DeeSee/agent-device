import type { DaemonRequest } from '../daemon-request.ts';
export function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    ...overrides,
  };
}
