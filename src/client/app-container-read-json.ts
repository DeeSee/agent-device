import {
  APP_CONTAINER_JSON_MAX_BYTES,
  checkAppContainerJsonPath,
  isBoundedAppContainerJsonObject,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  AppContainerReadJsonOptions,
  AppContainerReadJsonResult,
} from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';

export function validateAppContainerReadOptions(options: AppContainerReadJsonOptions): void {
  if (!options.app || options.app.trim() !== options.app || options.app.includes('\0')) {
    throw new AppError('INVALID_ARGS', 'App-container JSON requires an exact app bundle ID');
  }
  const checked = checkAppContainerJsonPath(options.containerPath);
  if (!checked.valid) throw new AppError('INVALID_ARGS', checked.message);
}

export function normalizeAppContainerReadResult(
  data: Record<string, unknown>,
  options: AppContainerReadJsonOptions,
): AppContainerReadJsonResult {
  const keys = ['appId', 'containerPath', 'sha256', 'byteLength', 'value'];
  if (data.cost !== undefined) keys.push('cost');
  const actualKeys = Object.keys(data).sort();
  const expectedKeys = keys.sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    data.appId !== options.app ||
    data.containerPath !== options.containerPath ||
    typeof data.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    typeof data.byteLength !== 'number' ||
    !Number.isSafeInteger(data.byteLength) ||
    data.byteLength < 0 ||
    data.byteLength > APP_CONTAINER_JSON_MAX_BYTES ||
    !isBoundedAppContainerJsonObject(data.value)
  ) {
    throw invalidResult();
  }
  const cost = normalizeCost(data.cost);
  return {
    appId: options.app,
    containerPath: options.containerPath,
    sha256: data.sha256,
    byteLength: data.byteLength,
    value: data.value,
    ...(cost === undefined ? {} : { cost }),
  };
}

function normalizeCost(value: unknown): AppContainerReadJsonResult['cost'] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResult();
  const record = value as Record<string, unknown>;
  const keys = [
    'wallClockMs',
    'runnerRoundTrips',
    ...(record.nodeCount === undefined ? [] : ['nodeCount']),
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => {
      const number = record[key];
      return typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0;
    })
  )
    throw invalidResult();
  return {
    wallClockMs: record.wallClockMs as number,
    runnerRoundTrips: record.runnerRoundTrips as number,
    ...(record.nodeCount === undefined ? {} : { nodeCount: record.nodeCount as number }),
  };
}

function invalidResult(): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon returned an invalid app-container JSON result.');
}
