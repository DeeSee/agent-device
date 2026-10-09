export async function writeVerifiedAppleAppContainerJson(
  ...args: Parameters<
    typeof import('./core/app-container-json.ts').writeVerifiedAppleAppContainerJson
  >
): Promise<
  Awaited<
    ReturnType<typeof import('./core/app-container-json.ts').writeVerifiedAppleAppContainerJson>
  >
> {
  const { writeVerifiedAppleAppContainerJson: write } =
    await import('./core/app-container-json.ts');
  return await write(...args);
}

export async function readAppleAppContainerJson(
  ...args: Parameters<typeof import('./core/app-container-json.ts').readAppleAppContainerJson>
): Promise<
  Awaited<ReturnType<typeof import('./core/app-container-json.ts').readAppleAppContainerJson>>
> {
  const { readAppleAppContainerJson: read } = await import('./core/app-container-json.ts');
  return await read(...args);
}
