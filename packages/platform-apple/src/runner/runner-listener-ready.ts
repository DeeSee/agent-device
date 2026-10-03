const RUNNER_LISTENER_READY_MARKER = 'AGENT_DEVICE_RUNNER_LISTENER_READY';
const RUNNER_LISTENER_FAILED_MARKER = 'AGENT_DEVICE_RUNNER_LISTENER_FAILED=';
const ADDRESS_IN_USE_MARKER = 'Address already in use';
const RUNNER_LISTENER_SCAN_TAIL_LENGTH = 512;

export type RunnerListenerReadinessState = 'pending' | 'process_finished' | 'port_in_use' | 'ready';

export type RunnerListenerReadiness = Readonly<{
  wake: AbortSignal;
  state(): RunnerListenerReadinessState;
}>;

export type RunnerListenerReadySignal = RunnerListenerReadiness &
  Readonly<{
    observe(chunk: string): void;
    finish(): void;
  }>;

export function settledRunnerListenerReadiness(
  state: Exclude<RunnerListenerReadinessState, 'pending'>,
): RunnerListenerReadiness {
  return Object.freeze({ state: () => state, wake: AbortSignal.abort() });
}

/**
 * Turns the runner's authoritative NWListener-ready log marker into a one-shot host signal.
 * xcodebuild may split one log line across process-output chunks, so the scanner retains a bounded
 * log suffix long enough to classify both readiness and listener-bind failure.
 */
export function createRunnerListenerReadySignal(): RunnerListenerReadySignal {
  const wake = new AbortController();
  let state: RunnerListenerReadinessState = 'pending';
  let tail = '';
  return {
    wake: wake.signal,
    state: () => state,
    observe: (chunk) => {
      if (state !== 'pending') return;
      const candidate = tail + chunk;
      const failedAt = candidate.indexOf(RUNNER_LISTENER_FAILED_MARKER);
      const addressInUseAt = candidate.indexOf(ADDRESS_IN_USE_MARKER, failedAt);
      if (failedAt >= 0 && addressInUseAt >= failedAt) {
        state = 'port_in_use';
        tail = '';
        wake.abort();
        return;
      }
      if (candidate.includes(RUNNER_LISTENER_READY_MARKER)) {
        state = 'ready';
        tail = '';
        wake.abort();
        return;
      }
      tail = candidate.slice(-RUNNER_LISTENER_SCAN_TAIL_LENGTH);
    },
    finish: () => {
      if (state !== 'pending') return;
      state = 'process_finished';
      tail = '';
      wake.abort();
    },
  };
}
