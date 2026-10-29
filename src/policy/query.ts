import { digitsSource } from './match.ts';
import type { QueryParamSpec, QueryRule } from '../types.ts';

type CompiledParam = {
  name: string;
  pattern: string;
};

export function compileQueryRules(allow: Record<string, QueryParamSpec>): QueryRule[] {
  const params: CompiledParam[] = Object.entries(allow).map(([name, spec]) => ({
    name,
    pattern: spec.type === 'digits' ? digitsSource() : spec.values.join('|'),
  }));
  const rules: QueryRule[] = [];
  for (let size = 1; size <= params.length; size += 1) {
    for (const subset of combinations(params, size)) {
      for (const order of permutations(subset)) {
        const source = `^${order
          .map((param) => `${param.name}=(?<${param.name}>${param.pattern})`)
          .join('&')}$`;
        const directory = subset.map((param) => `${param.name}-$${param.name}`).join('.');
        rules.push({
          source,
          nginxMatch: `~${source}`,
          directory,
        });
      }
    }
  }
  return rules;
}

export function queryDirectory(rawQuery: string, allow: Record<string, QueryParamSpec>, rules: QueryRule[]): string | null {
  if (rawQuery === '') return '';
  const parsed = parseQuery(rawQuery, allow);
  if (!parsed) return null;
  const rule = rules.find((candidate) => new RegExp(candidate.source).test(rawQuery));
  if (!rule) return null;
  const match = new RegExp(rule.source).exec(rawQuery);
  if (!match?.groups) return null;
  const fromRule = Object.keys(allow)
    .filter((name) => match.groups?.[name] !== undefined)
    .map((name) => `${name}-${match.groups?.[name]}`)
    .join('.');
  return fromRule === parsed ? parsed : null;
}

export function parseQuery(rawQuery: string, allow: Record<string, QueryParamSpec>): string | null {
  if (rawQuery === '') return '';
  if (/[%+\s]/.test(rawQuery)) return null;
  const parts = rawQuery.split('&');
  const seen = new Map<string, string>();
  for (const part of parts) {
    const splitAt = part.indexOf('=');
    if (splitAt <= 0 || splitAt !== part.lastIndexOf('=') || splitAt === part.length - 1) return null;
    const name = part.slice(0, splitAt);
    const value = part.slice(splitAt + 1);
    if (seen.has(name) || !Object.prototype.hasOwnProperty.call(allow, name)) return null;
    const spec = allow[name];
    if (!spec || !valueMatches(value, spec)) return null;
    seen.set(name, value);
  }
  return Object.keys(allow)
    .filter((name) => seen.has(name))
    .map((name) => `${name}-${seen.get(name)}`)
    .join('.');
}

function valueMatches(value: string, spec: QueryParamSpec): boolean {
  if (spec.type === 'digits') return new RegExp(`^${digitsSource()}$`).test(value);
  return spec.values.includes(value);
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...tail] = items;
  if (!head) return [];
  return [
    ...combinations(tail, size - 1).map((combo) => [head, ...combo]),
    ...combinations(tail, size),
  ];
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, itemIndex) => itemIndex !== index)).map((rest) => [item, ...rest]),
  );
}
