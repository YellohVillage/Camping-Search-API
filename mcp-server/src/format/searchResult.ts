import type { RestSearchResponse } from '../rest/types.js';

/** Résultat de recherche pour le LLM (§6.4). */
export interface McpSearchResult {
  status: 'OK' | 'PARTIAL' | 'NO_AVAILABILITY';
  message: string | null;
  search: {
    start_date: string;
    end_date: string;
    nights: number;
    people_count: number;
    accommodation_type: 'rental' | 'slot';
    filters: string[];
    /** Nombre d'identifiants de campings de la recherche (0 = tout le réseau). */
    camping_ids_count: number;
  };
  matching: { available: number; alternative_dates: number };
  results: {
    rank: number;
    availability_type: 'available' | 'alternative_dates' | 'alternative_capacity';
    name: string;
    city: string;
    department: string | null;
    region: string | null;
    stars: number | null;
    rating_out_of_10: number | null;
    alternative_begin_date: string | null;
    alternative_end_date: string | null;
    alternative_capacity: number | null;
    booking_link: string;
    camping_page: string;
    image_url: string | null;
  }[];
}

/** Mapping de la réponse REST (§6.4) : liens recopiés sans modification ; camping_code, coordonnées et meta retirés. */
export function toMcpSearchResult(r: RestSearchResponse): McpSearchResult {
  return {
    status: r.status,
    message: r.message,
    search: {
      start_date: r.search.start_date,
      end_date: r.search.end_date,
      nights: r.search.nights,
      people_count: r.search.people_count,
      accommodation_type: r.search.accommodation_type,
      filters: r.search.filters,
      camping_ids_count: r.search.camping_ids?.length ?? 0,
    },
    matching: { available: r.summary.available_count, alternative_dates: r.summary.alternative_dates_count },
    results: r.results.map((x) => ({
      rank: x.rank,
      availability_type: x.availability_type,
      name: x.name.trim(),
      city: x.city.trim(),
      department: x.department?.trim() || null,
      region: x.region?.trim() || null,
      stars: x.stars,
      rating_out_of_10: x.rating,
      alternative_begin_date: x.alternative_begin_date_availability,
      alternative_end_date: x.alternative_end_date_availability,
      alternative_capacity: x.alternative_capacity,
      booking_link: x.bookingengine_link,
      camping_page: x.camping_url,
      image_url: x.image_url,
    })),
  };
}

const fmtRating = (r: number | null) => (r === null ? null : `${r.toFixed(1)}/10`);

/** Résumé texte (§6.4) : guide la présentation, deux liens par camping. */
export function searchText(s: McpSearchResult): string {
  if (s.status === 'NO_AVAILABILITY') {
    const base = 'No campsite available ("aucun camping disponible"). Suggest other dates or fewer filters.';
    return s.search.camping_ids_count > 0
      ? `${base} The search was restricted to the place found by search_geography: also suggest a wider or nearby area.`
      : base;
  }
  const n = s.results.length;
  const noneOnDates = s.matching.available === 0;
  const head = noneOnDates
    ? `${n} campsite${n > 1 ? 's' : ''} proposed. None is available on the requested dates (0 available, ${s.matching.alternative_dates} with alternative dates).`
    : `${n} campsite${n > 1 ? 's' : ''} found (${s.matching.available} match the criteria).`;
  const lines = [
    `${head} Show them to the user, each with its campsite page link and its booking link, unchanged. Never state a price.`,
  ];
  if (s.status === 'PARTIAL' && s.message) lines.push(`Note: fewer results than requested (${s.message}).`);
  for (const r of s.results) {
    const place = [r.city, r.department ? `(${r.department})` : ''].filter(Boolean).join(' ');
    let avail: string;
    if (r.availability_type === 'available') {
      avail = `available ${s.search.start_date} → ${s.search.end_date}`;
    } else if (r.availability_type === 'alternative_dates') {
      avail = `NOT available on requested dates — available ${r.alternative_begin_date} → ${r.alternative_end_date}`;
    } else {
      avail = `available on requested dates in an accommodation for ${r.alternative_capacity ?? '?'} people`;
    }
    const parts = [
      r.name,
      place,
      r.stars !== null ? `${r.stars}★` : null,
      fmtRating(r.rating_out_of_10),
      avail,
    ].filter(Boolean);
    lines.push(`${r.rank}. ${parts.join(' — ')}`);
    lines.push(`   Campsite page: ${r.camping_page}`);
    lines.push(`   Booking: ${r.booking_link}`);
  }
  return lines.join('\n');
}
