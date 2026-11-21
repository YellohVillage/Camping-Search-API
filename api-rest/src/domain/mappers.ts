import type { GqlCamping } from '../upstream/types.js';
import { buildBookingEngineLink } from './bookingLink.js';
import type { AvailabilityType, Selected } from './selector.js';

/** Résultat de recherche (§7.6). */
export interface CampingResult {
  rank: number;
  availability_type: AvailabilityType;
  camping_code: number;
  name: string;
  stars: number | null;
  rating: number | null;
  city: string;
  department: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  image_url: string | null;
  camping_url: string;
  is_new: boolean;
  special_offer: string | null;
  alternative_begin_date_availability: string | null;
  alternative_end_date_availability: string | null;
  alternative_capacity: number | null;
  bookingengine_link: string;
}

/** Note GraphQL sur 100 → note sur 10 arrondie au dixième. */
export const toRating = (note: number | null | undefined) =>
  note === null || note === undefined ? null : Math.round(note) / 10;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  rsquo: '’',
  lsquo: '‘',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  Eacute: 'É',
  Egrave: 'È',
  Agrave: 'À',
  Ccedil: 'Ç',
};

/** Retire le HTML d'une offre spéciale (§7.6). */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

export interface MapContext {
  startDate: string;
  endDate: string;
  peopleCount: number;
  accommodationType: 'rental' | 'slot';
  track: string;
  siteBaseUrl: string;
  bookingEngineUrl: string;
}

export function toCampingResult(sel: Selected, rank: number, ctx: MapContext): CampingResult {
  const c: GqlCamping = sel.camping;
  const isAlternative = sel.type !== 'available';
  const begin = isAlternative && sel.begin ? sel.begin : ctx.startDate;
  const end = isAlternative && sel.end ? sel.end : ctx.endDate;
  return {
    rank,
    availability_type: sel.type,
    camping_code: c.campingCode,
    name: c.name,
    stars: c.starCount ?? null,
    rating: toRating(c.note),
    city: (c.city ?? '').trim(),
    department: c.department ?? null,
    region: c.region ?? null,
    latitude: c.coordinates?.latitude ?? null,
    longitude: c.coordinates?.longitude ?? null,
    image_url: c.image ?? null,
    camping_url: `${ctx.siteBaseUrl}${c.campingUrl}`,
    is_new: !!c.isNew,
    special_offer: stripHtml(c.specialOffer?.description),
    alternative_begin_date_availability: isAlternative ? (sel.begin ?? null) : null,
    alternative_end_date_availability: isAlternative ? (sel.end ?? null) : null,
    alternative_capacity: sel.type === 'alternative_capacity' ? (sel.capacity ?? null) : null,
    bookingengine_link: buildBookingEngineLink(
      {
        campingCode: c.campingCode,
        begin,
        end,
        peopleCount: ctx.peopleCount,
        track: ctx.track,
        accommodationType: ctx.accommodationType,
      },
      ctx.bookingEngineUrl,
    ),
  };
}
