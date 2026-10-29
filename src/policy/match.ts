const DIGITS = '[1-9][0-9]{0,5}';

export function matchGlob(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = path.split('/').filter((segment) => segment.length > 0);
  return matchSegments(patternSegments, pathSegments);
}

function matchSegments(pattern: string[], path: string[]): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  while (patternIndex < pattern.length) {
    const part = pattern[patternIndex];
    if (part === '**') return true;
    if (pathIndex >= path.length) return false;
    if (part === '*') {
      pathIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (part !== path[pathIndex]) return false;
    patternIndex += 1;
    pathIndex += 1;
  }
  return pathIndex === path.length;
}

export function routeAllowed(path: string, include: string[], exclude: string[]): boolean {
  if (exclude.some((pattern) => matchGlob(pattern, path))) return false;
  return include.some((pattern) => matchGlob(pattern, path));
}

export function digitsSource(): string {
  return DIGITS;
}
