// Copyright 2026 Yandex LLC. All rights reserved.

import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { publicPlatformString } from '@agent-device/kernel/device';
import { appProcessesUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import type { SessionStore } from '../session-store.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';

export async function handleAppProcessesCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  try {
    if ((params.req.positionals?.length ?? 0) !== 0 || params.req.input !== undefined) {
      throw new AppError('INVALID_ARGS', 'app_processes accepts no command arguments.');
    }
    const session = params.sessionStore.get(params.sessionName);
    if (!session?.appBundleId) {
      throw new AppError(
        'SESSION_NOT_FOUND',
        'apps.processes requires an active app session. Run open <app> first.',
      );
    }
    const admitted = await admitRuntimeUse({
      command: params.req.command,
      device: session.device,
      use: appProcessesUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (admitted.type === 'response') return admitted.response;
    const result = await admitted.runtime.operations.observeAppProcesses({
      appBundleId: session.appBundleId,
    });
    return {
      ok: true,
      data: {
        platform: publicPlatformString(session.device),
        appBundleId: session.appBundleId,
        processIds: result.processIds,
        device: {
          platform: publicPlatformString(session.device),
          appleOs: session.device.appleOs,
          target: session.device.target ?? 'mobile',
          kind: session.device.kind,
          id: session.device.id,
          name: session.device.name,
        },
      },
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}
