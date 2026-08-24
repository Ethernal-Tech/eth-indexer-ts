export function sleep(ms: number) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
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
