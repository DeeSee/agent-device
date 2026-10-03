import type { ScreenRecordingCadence } from '@agent-device/contracts/recording';
export type VideoInspection = ScreenRecordingCadence;
export function parseVideoInspectionOutput(stdout: string): VideoInspection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  return readVideoInspection(value);
}

export { invalidInspection, unavailableInspection } from './stop-checkpoints.ts';
import { readVideoInspection } from './stop-checkpoints.ts';
