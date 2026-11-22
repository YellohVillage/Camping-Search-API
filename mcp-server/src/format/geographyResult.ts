import type { RestGeographyResponse } from '../rest/types.js';

/** Sortie de search_geography pour le LLM (§6 bis.4). */
export interface McpGeographyResult {
  status: 'OK' | 'NO_RESULT';
  keywords: string;
  match: { name: string; type: string | null; camping_count: number } | null;
  camping_ids: number[];
  other_matches: { name: string; type: string | null; camping_count: number }[];
}

const MAX_OTHER_MATCHES = 5;

/** Mapping de la réponse REST : camping_ids recopiés sans modification ; content_id, locale et meta retirés. */
export function toMcpGeographyResult(r: RestGeographyResponse): McpGeographyResult {
  return {
    status: 'OK',
    keywords: r.keywords,
    match: { name: r.match.name, type: r.match.type, camping_count: r.match.camping_count },
    camping_ids: r.camping_ids,
    other_matches: r.other_matches
      .slice(0, MAX_OTHER_MATCHES)
      .map((o) => ({ name: o.name, type: o.type, camping_count: o.camping_count })),
  };
}

export const noGeographyResult = (keywords: string): McpGeographyResult => ({
  status: 'NO_RESULT',
  keywords,
  match: null,
  camping_ids: [],
  other_matches: [],
});

/** Texte du §6 bis.4. */
export function geographyText(g: McpGeographyResult): string {
  if (g.status === 'NO_RESULT' || !g.match) {
    return `No place found for "${g.keywords}" ("no result"). You may try another wording (region or department name). If no place is found, still call search_campings without camping_ids (whole network). No need to tell the user.`;
  }
  const n = g.match.camping_count;
  const lines = [
    `Place found: ${g.match.name} (${g.match.type ?? 'unknown type'}) — ${n} campsite${n > 1 ? 's' : ''}.`,
    `Pass these camping_ids unchanged to search_campings: [${g.camping_ids.join(',')}]`,
  ];
  if (g.other_matches.length > 0) {
    lines.push(
      `Other matches: ${g.other_matches.map((o) => `"${o.name}" (${o.type ?? '?'}, ${o.camping_count})`).join(', ')}`,
    );
  }
  return lines.join('\n');
}
