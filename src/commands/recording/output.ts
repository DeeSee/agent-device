import type { CommandRequestResult } from '@agent-device/contracts/client';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

export function recordCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const outPath = typeof data.outPath === 'string' ? data.outPath : '';
  const chunks = readRecordingChunks(data);
  if (chunks.length <= 1) {
    return { data, text: formatRecordSingleOutput(data, outPath) };
  }

  const lines = ['Recording chunks:'];
  for (const chunk of chunks) {
    lines.push(`  ${chunk.index}: ${chunk.path}`);
  }
  const cadenceLine = formatRecordingCadence(data.cadence);
  if (cadenceLine) lines.push(cadenceLine);
  if (typeof data.telemetryPath === 'string') {
    lines.push(`Telemetry: ${data.telemetryPath}`);
  }
  if (typeof data.warning === 'string') {
    lines.push(`Warning: ${data.warning}`);
  }
  if (typeof data.overlayWarning === 'string') {
    lines.push(`Overlay warning: ${data.overlayWarning}`);
  }
  return { data, text: lines.join('\n') };
}

export const recordingCliOutputFormatters = {
  record: resultOutput(recordCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatRecordSingleOutput(data: Record<string, unknown>, outPath: string): string {
  const lines: string[] = [];
  if (outPath) lines.push(outPath);
  if (typeof data.sessionStateDir === 'string')
    lines.push(`Session state: ${data.sessionStateDir}`);
  const cadenceLine = formatRecordingCadence(data.cadence);
  if (cadenceLine) lines.push(cadenceLine);
  if (typeof data.warning === 'string') lines.push(`Warning: ${data.warning}`);
  if (typeof data.overlayWarning === 'string')
    lines.push(`Overlay warning: ${data.overlayWarning}`);
  return lines.join('\n');
}

function formatRecordingCadence(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cadence = value as Record<string, unknown>;
  if (cadence.status === 'unavailable' || cadence.status === 'invalid') {
    return typeof cadence.reason === 'string'
      ? `Cadence: ${cadence.status} (${cadence.reason})`
      : `Cadence: ${cadence.status}`;
  }
  return cadence.status === 'measured' ? formatMeasuredCadence(cadence) : undefined;
}

function formatMeasuredCadence(cadence: Record<string, unknown>): string {
  const details: string[] = [];
  if (typeof cadence.requestedFps === 'number')
    details.push(`requested ${formatCadenceNumber(cadence.requestedFps)} FPS`);
  details.push(
    typeof cadence.effectiveFps === 'number'
      ? `measured ${formatCadenceNumber(cadence.effectiveFps)} FPS`
      : 'measured FPS unavailable',
  );
  if (typeof cadence.sampleCount === 'number')
    details.push(
      `${formatCadenceNumber(cadence.sampleCount)} ${cadence.sampleCount === 1 ? 'sample' : 'samples'}`,
    );
  if (typeof cadence.maxInterSampleGapMs === 'number')
    details.push(`max gap ${formatCadenceNumber(cadence.maxInterSampleGapMs)}ms`);
  return `Cadence: ${details.join(', ')}`;
}

function formatCadenceNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : 'unavailable';
}

function readRecordingChunks(
  data: Record<string, unknown>,
): Array<{ index: number; path: string }> {
  const rawChunks = data.chunks;
  if (!Array.isArray(rawChunks)) return [];
  return rawChunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== 'object') return [];
    const candidate = chunk as Record<string, unknown>;
    if (typeof candidate.index !== 'number' || typeof candidate.path !== 'string') return [];
    return [{ index: candidate.index, path: candidate.path }];
  });
}
