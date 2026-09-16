/** Resolves early when `signal` aborts, so a stopping loop does not wait out the delay. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function envInt(key: string, defaultValue: number): number {
  const val = Number(process.env[key]);
  return isNaN(val) ? defaultValue : val;
}

/**
 * Reads an env var that must be one of an enum's values.
 */
export function envEnum<T extends Record<string, string>>(
  key: string,
  enumObj: T,
  defaultValue: T[keyof T],
): T[keyof T] {
  const raw = process.env[key];
  if (!raw) {
    return defaultValue;
  }
  const allowed = Object.values(enumObj);
  if (!allowed.includes(raw)) {
    throw new Error(`Invalid ${key}: ${raw}. Expected one of: ${allowed.join(', ')}`);
  }
  return raw as T[keyof T];
}
