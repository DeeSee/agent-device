import { checkAppContainerJsonPath } from '@agent-device/contracts/app-deployment-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { writeAppContainerJsonUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import type { AppContainerWriteJsonInput } from '@agent-device/contracts/app-deployment-runtime';
import type { JsonObject, JsonValue } from '@agent-device/contracts/client';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import {
  requireRuntimeBinding,
  requireRuntimeFacts,
  unavailableRuntimeOperationResponse,
} from '../session-runtime-admission.ts';

export async function handleAppContainerJsonWriteCommand(params: {
  req: DaemonRequest;
  resolveDevice: () => Promise<DeviceInfo | DaemonResponse>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req } = params;
  try {
    const input = parseInput(req.input);
    const device = await params.resolveDevice();
    if ('ok' in device) return device;
    const facts = await requireRuntimeFacts(params.inspectFacts)(device);
    const unsupported = unavailableRuntimeOperationResponse(
      req.command,
      facts.operations.writeAppContainerJson,
    );
    if (unsupported) return unsupported;
    const runtime = await requireRuntimeBinding(params.bindDevice)(
      device,
      writeAppContainerJsonUse,
    );
    return { ok: true, data: await runtime.operations.writeAppContainerJson(input) };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function parseInput(value: unknown): AppContainerWriteJsonInput {
  if (!isRecord(value) || !hasExactKeys(value, ['app', 'containerPath', 'value'])) {
    throw new AppError(
      'INVALID_ARGS',
      'App container JSON write requires exactly app, containerPath, and value',
    );
  }
  const app = requireText(value.app, 'app');
  const checkedPath = checkAppContainerJsonPath(value.containerPath);
  if (!checkedPath.valid) throw new AppError('INVALID_ARGS', checkedPath.message);
  const containerPath = checkedPath.path;
  if (!isJsonObject(value.value)) {
    throw new AppError('INVALID_ARGS', 'value must be a JSON object');
  }
  return { app, containerPath, value: value.value };
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new AppError('INVALID_ARGS', `${name} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
