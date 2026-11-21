/** Lien vers le funnel YellohResa (§10.1 et §10.2). Pas de paramètre `lang` : le funnel suit le navigateur. */

const toFr = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return encodeURIComponent(`${d}/${m}/${y}`);
};

export interface BookingLinkParams {
  campingCode: number;
  begin: string;
  end: string;
  peopleCount: number;
  track: string;
  accommodationType: 'rental' | 'slot';
}

export function buildBookingEngineLink(p: BookingLinkParams, baseUrl: string): string {
  const type = p.accommodationType === 'slot' ? 1 : 0;
  return (
    `${baseUrl}?camping=yelloh&begin=${toFr(p.begin)}&end=${toFr(p.end)}` +
    `&sites[]=${p.campingCode}&nb_pers=${p.peopleCount}&track=${encodeURIComponent(p.track)}` +
    `&type=${type}`
  );
}
