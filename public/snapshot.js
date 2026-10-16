// Turns the data loaded for a place into a shortlist snapshot. Pure functions with no DOM,
// shared by the page (app.js) and the server (lib/shortlist.mjs), and run by the Node tests.

/** Stable id for a place: a normalised postcode, or the lower-cased place name. */
export function shortlistId(query) {
  const q = String(query || '').trim();
  const s = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s)) return `${s.slice(0, -3)} ${s.slice(-3)}`;
  return q.toLowerCase().replace(/\s+/g, ' ');
}
