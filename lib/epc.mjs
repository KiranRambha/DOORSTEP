// Optional: adds room counts and floor area to each sale by matching it to the
// home's Energy Performance Certificate (EPC). Land Registry doesn't record bedrooms,
// but EPCs record "habitable rooms" (bedrooms + living/dining rooms) and floor area,
// which is the best free proxy for a 4-bed house.
//
// Needs a free bearer token: sign in with GOV.UK One Login at
// https://get-energy-performance-data.communities.gov.uk/guidance/energy-certificate-data-apis
// then put EPC_TOKEN=... in the .env file.

import { fetchJson, cached, mapLimit } from './util.mjs';

const BASE = 'https://api.get-energy-performance-data.communities.gov.uk';
const MAX_CERT_FETCHES = 250;

const headers = () => ({ Authorization: `Bearer ${process.env.EPC_TOKEN}`, Accept: 'application/json' });
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function certificatesForPostcode(postcode) {
  return cached(`epc:search:${postcode}`, 24 * 30, async () => {
    const url = `${BASE}/api/domestic/search?postcode=${encodeURIComponent(postcode).replace(/%20/g, '+')}&page_size=5000`;
    const r = await fetchJson(url, { headers: headers(), allow404: true, retries: 1 });
    const list = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.data) ? r.data.data : [];
    return list.map((c) => ({
      cert: c.certificateNumber || c.certificate_number,
      address: norm([c.addressLine1, c.addressLine2, c.addressLine3, c.addressLine4, c.address_line_1, c.address_line_2].filter(Boolean).join(' ')),
      date: c.registrationDate || c.registration_date || '',
    })).filter((c) => c.cert);
  });
}

async function certificateDetails(cert) {
  return cached(`epc:cert:${cert}`, Infinity, async () => {
    const r = await fetchJson(`${BASE}/api/certificate?certificate_number=${encodeURIComponent(cert)}`, { headers: headers(), retries: 1 });
    const d = r?.data || {};
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    return {
      habitableRooms: num(d.habitable_room_count ?? d.number_habitable_rooms ?? d.habitableRoomCount),
      floorArea: num(d.total_floor_area ?? d.totalFloorArea),
      band: d.current_energy_efficiency_band ?? d.currentEnergyEfficiencyBand ?? null,
    };
  });
}

/** Find the EPC that belongs to this sale's address. */
export function matchCertificate(sale, certs) {
  const paon = norm(sale.paon);
  const street = norm(sale.street);
  if (!paon) return null;
  const paonRe = new RegExp(`(^| )${escapeRe(paon)}( |$)`);
  const saon = norm(sale.saon);
  const hits = certs.filter((c) =>
    paonRe.test(c.address)
    && (!street || c.address.includes(street))
    && (!saon || c.address.includes(saon)));
  hits.sort((a, b) => b.date.localeCompare(a.date));
  return hits[0] || null;
}

export async function enrichWithEpc(sales) {
  const postcodes = [...new Set(sales.map((s) => s.postcode))];
  const certLists = new Map();
  await mapLimit(postcodes, 4, async (pc) => {
    certLists.set(pc, await certificatesForPostcode(pc).catch(() => []));
  });

  const matches = sales.map((s) => ({ sale: s, match: matchCertificate(s, certLists.get(s.postcode) || []) }));
  const toFetch = matches.filter((m) => m.match).slice(0, MAX_CERT_FETCHES);
  let failed = 0;
  await mapLimit(toFetch, 4, async ({ sale, match }) => {
    try {
      const d = await certificateDetails(match.cert);
      sale.habitableRooms = d.habitableRooms;
      sale.floorArea = d.floorArea;
      sale.epcBand = d.band;
    } catch {
      failed++;
    }
  });

  return {
    enabled: true,
    matched: sales.filter((s) => s.habitableRooms || s.floorArea).length,
    total: sales.length,
    failed,
  };
}
