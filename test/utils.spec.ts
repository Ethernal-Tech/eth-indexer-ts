import { describe, it, expect } from 'vitest';
import { sleep } from '../src/common/utils';

describe('sleep', () => {
  it('resolves immediately for a non positive delay', async () => {
    const started = Date.now();
    await sleep(0);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('cuts the wait short when the signal aborts mid sleep', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await sleep(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('waits out the delay when nothing aborts', async () => {
    const started = Date.now();
    await sleep(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
