import { describe, expect, it } from 'vitest';

import { waitForDaemonStartupWithContainment } from './daemon-client-startup.ts';

describe('owned daemon startup containment', () => {
  it('exact-stops before releasing when readiness observation fails', async () => {
    const events: string[] = [];
    const failure = new Error('readiness failed');

    await expect(
      waitForDaemonStartupWithContainment(
        async () => {
          events.push('observe');
          throw failure;
        },
        async () => {
          events.push('stop');
        },
        () => events.push('release'),
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(['observe', 'stop', 'release']);
  });

  it('retains launch authority and surfaces exact-stop uncertainty', async () => {
    const events: string[] = [];
    const containment = new Error('containment unknown');

    await expect(
      waitForDaemonStartupWithContainment(
        async () => {
          events.push('observe');
          throw new Error('readiness failed');
        },
        async () => {
          events.push('stop');
          throw containment;
        },
        () => events.push('release'),
      ),
    ).rejects.toBe(containment);
    expect(events).toEqual(['observe', 'stop']);
  });

  it('does not stop or release when readiness observation succeeds', async () => {
    const events: string[] = [];
    const result = { kind: 'timeout' as const };

    await expect(
      waitForDaemonStartupWithContainment(
        async () => {
          events.push('observe');
          return result;
        },
        async () => {
          events.push('stop');
        },
        () => events.push('release'),
      ),
    ).resolves.toBe(result);
    expect(events).toEqual(['observe']);
  });
});
