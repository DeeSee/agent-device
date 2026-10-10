// Copyright 2026 Yandex LLC. All rights reserved.

export type AppProcessesRuntimeInput = Readonly<{ appBundleId: string }>;
export type AppProcessesRuntimeResult = Readonly<{ processIds: readonly number[] }>;
export type AppProcessesRuntimeOperations = Readonly<{
  observeAppProcesses(input: AppProcessesRuntimeInput): Promise<AppProcessesRuntimeResult>;
}>;

export const appProcessesUnsupported = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'App process observation is supported only for iOS and iPadOS.',
} as const);
