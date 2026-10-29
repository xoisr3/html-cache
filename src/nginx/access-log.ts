export type AccessSummary = {
  total: number;
  hit: number;
  miss: number;
  bypass: number;
  bypassCookie: number;
  bypassQuery: number;
};

const LINE =
  /"\S+ [^"]*" \d{3} (?<cache>HIT|MISS|BYPASS) cookie=(?<cookie>[01]) query_ok=(?<query>[01])/;

export function summarizeAccessLog(text: string): AccessSummary {
  const summary: AccessSummary = {
    total: 0,
    hit: 0,
    miss: 0,
    bypass: 0,
    bypassCookie: 0,
    bypassQuery: 0,
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = LINE.exec(line);
    if (!match?.groups) continue;
    summary.total += 1;
    if (match.groups.cache === 'HIT') summary.hit += 1;
    else if (match.groups.cache === 'MISS') summary.miss += 1;
    else {
      summary.bypass += 1;
      if (match.groups.cookie === '1') summary.bypassCookie += 1;
      else if (match.groups.query === '0') summary.bypassQuery += 1;
    }
  }
  return summary;
}
