function parseVersionParts(version: string): number[] | null {
  const core = version.trim().replace(/^v/i, '').split('-')[0] ?? '';
  if (!core) return null;

  const parts = core.split('.');
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.map((part) => Number(part));
}

/** True when `candidate` is a newer x.y.z release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersionParts(candidate);
  const installed = parseVersionParts(current);
  if (!next || !installed) return false;

  const length = Math.max(next.length, installed.length);
  for (let i = 0; i < length; i += 1) {
    const nextPart = next[i] ?? 0;
    const installedPart = installed[i] ?? 0;
    if (nextPart > installedPart) return true;
    if (nextPart < installedPart) return false;
  }
  return false;
}
