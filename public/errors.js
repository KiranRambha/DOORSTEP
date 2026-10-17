// Turns raw failures ("api.tfl.gov.uk returned 404: {...json...}") into plain English for the page.
// Pure, shared by the page and the tests.

const SERVICES = [
  [/tfl\.gov\.uk/, 'TfL'],
  [/postcodes\.io/, 'The postcode service'],
  [/police\.uk/, 'The police crime service'],
  [/landregistry/, 'Land Registry'],
  [/energy-performance/, 'The energy certificate service'],
  [/environment|\.ea\.|agency/, 'The Environment Agency'],
  [/ofsted|gov\.uk/, 'A government data service'],
];

const GENERIC = 'Something went wrong. Try again in a minute.';

export function friendlyError(e) {
  const raw = String(e?.message ?? e ?? '').trim();
  if (/^(Failed to fetch|Load failed|NetworkError)/i.test(raw)) return "Couldn't reach Doorstep. Check the app is still running on the Mac.";
  if (/^fetch failed/i.test(raw)) return "Couldn't connect to the data services. Check the Mac's internet connection.";

  // fetchJson's shape: "<host> returned <status>[: body]" or "<host> timed out"
  const m = raw.match(/^([a-z0-9.-]+\.[a-z]{2,}) (?:returned (\d{3})|timed out)/i);
  if (m) {
    const name = SERVICES.find(([re]) => re.test(m[1]))?.[1] || 'A data service';
    const status = Number(m[2]);
    if (!status) return `${name} took too long to answer. Try again.`;
    if (status === 404 && name === 'TfL') return "TfL couldn't find a route from here.";
    if (status === 404) return `${name} has no data for this place.`;
    if (status === 429) return `${name} is busy right now. Try again in a minute.`;
    if (status >= 500) return `${name} is having problems right now. Try again later.`;
    return `${name} didn't accept the request.`;
  }

  // Doorstep's own messages are already plain English; anything long or bare is probably not.
  if (!raw || raw.length > 140 || /^Request failed \(\d+\)$/.test(raw)) return GENERIC;
  return raw;
}
