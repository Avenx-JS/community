export function readPositiveInteger(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined) {
    return fallback;
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86400) {
    throw new Error(`${name} must be an integer between 1 and 86400`);
  }
  return value;
}
