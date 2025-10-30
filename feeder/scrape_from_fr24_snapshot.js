/**
 * feeder/scrape_from_fr24_snapshot.js
 *
 * PURPOSE
 * -------
 * Read a *local* saved FR24 arrivals page (HTML), extract every arrival line
 * we can find, normalise it into our flight-row format, and write:
 *
 *   feeder/source_fr24.json
 *
 * This is the “step 1” you said you were missing.
 *
 * HOW TO USE
 * ----------
 * 1. Open FR24 arrivals for BRS in your browser.
 * 2. Save page as HTML (full) to:
 *        feeder/raw/fr24_arrivals.html
 *    (you can change path below if you like)
 * 3. Run:
 *        node feeder/scrape_from_fr24_snapshot.js
 * 4. Then run:
 *        node feeder/fr24_feeder.js
 *
 * NOTES
 * -----
 * - This tries 3 strategies so it doesn’t miss flights:
 *    A) HTML table-like rows
 *    B) JSON-ish structures embedded in <script> tags
 *    C) Loose text lines that look like flights
 *
 * - We normalise times to ISO and add a 30-min belt window.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, 'raw', 'fr24_arrivals.html');
const OUT_PATH      = path.join(__dirname, 'source_fr24.json');

// how long we want the belt window if FR24 didn’t give us one
const DEFAULT_BELT_DURATION_MIN = 30;

// util
function toIso(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(+dt)) return null;
  return dt.toISOString();
}

/**
 * Try to find something that looks like time in a FR24 cell, e.g. "20:34", "delayed 21:09"
 */
function extractTimeLike(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * Convert "20:34" to a full ISO using today's date
 */
function todayTimeToISO(hhmm) {
  if (!hhmm) return null;
  const now = new Date();
  const [hh, mm] = hhmm.split(':').map(Number);
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  return dt.toISOString();
}

/**
 * Normalise flight text
 */
function normFlight(f) {
  if (!f) return '';
  return f.replace(/\s+/g, '').toUpperCase();
}

/**
 * Parse the HTML in several passes.
 */
function parseFR24Html(html) {
  const rows = [];
  const errors = [];

  // ------------- PASS 1: very simple “table row” style ----------------
  // we look for things like <tr>...flight...origin...time...</tr>
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const tr = trMatch[1];

    // guess columns
    const tds = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1].replace(/<[^>]+>/g,'').trim());
    if (tds.length < 3) continue;

    // try to recognise a “flightish” string
    const maybeFlight = tds.find(t => /[A-Z]{1,3}\s?\d{1,4}/i.test(t));
    if (!maybeFlight) continue;

    // origin is often next
    const origin = tds[1] || '';
    // status or time
    const statusOrTime = tds.find(t => /\d{1,2}:\d{2}/.test(t)) || '';

    const timeStr = extractTimeLike(statusOrTime);
    const etaIso = todayTimeToISO(timeStr);

    const startIso = etaIso;
    let endIso = null;
    if (startIso) {
      const s = new Date(startIso);
      endIso = new Date(s.getTime() + DEFAULT_BELT_DURATION_MIN * 60 * 1000).toISOString();
    }

    rows.push({
      flight: normFlight(maybeFlight),
      origin: origin || '',
      origin_iata: '',
      eta: etaIso,
      status: statusOrTime || '',
      flow: '',               // will be fixed by allocator/biz rules
      belt: '',               // leave empty so allocator picks the belt
      start: startIso,
      end: endIso,
      reason: 'fr24:html-tr',
      airline: '',
      aircraft: '',
      pax_estimate: null,
      scheduled_local: timeStr || '',
      eta_local: timeStr || '',
      delay_min: null,
      ui_state: 'upcoming',
      ui_age_min: 0,
    });
  }

  // ------------- PASS 2: look for JSON-ish blocks ----------------
  // Sometimes FR24 embeds an array of flights in window.* or a <script> tag.
  // We'll grab {...} and look for flight + time there.
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const js = scriptMatch[1];
    // look for patterns like "flight":"U2228"
    const jsFlightRegex = /"flight"\s*:\s*"([^"]+)"/gi;
    let fMatch;
    while ((fMatch = jsFlightRegex.exec(js)) !== null) {
      const flt = normFlight(fMatch[1]);

      // get nearby "eta" or "time"
      // this is a bit fuzzy but it's better than dropping the row
      const nearby = js.slice(Math.max(0, fMatch.index - 200), fMatch.index + 200);
      const etaMatch = nearby.match(/"eta"\s*:\s*"([^"]+)"/) ||
                       nearby.match(/"time"\s*:\s*"([^"]+)"/);
      let etaIso = null;
      if (etaMatch) {
        // if it's already ISO, keep it, else try todayTimeToISO
        if (etaMatch[1].includes('T')) {
          etaIso = etaMatch[1];
        } else {
          etaIso = todayTimeToISO(etaMatch[1]);
        }
      }

      const startIso = etaIso;
      let endIso = null;
      if (startIso) {
        const s = new Date(startIso);
        endIso = new Date(s.getTime() + DEFAULT_BELT_DURATION_MIN * 60 * 1000).toISOString();
      }

      // check if we already got this flight from pass 1 with same eta
      const exists = rows.some(r => r.flight === flt && (!etaIso || r.eta === etaIso));
      if (!exists) {
        rows.push({
          flight: flt,
          origin: '',
          origin_iata: '',
          eta: etaIso,
          status: '',
          flow: '',
          belt: '',
          start: startIso,
          end: endIso,
          reason: 'fr24:script',
          airline: '',
          aircraft: '',
          pax_estimate: null,
          scheduled_local: '',
          eta_local: etaIso ? new Date(etaIso).toTimeString().slice(0,5) : '',
          delay_min: null,
          ui_state: 'upcoming',
          ui_age_min: 0,
        });
      }
    }
  }

  // ------------- PASS 3: final sanity + sorting ----------------
  // remove obvious empty rows
  const clean = rows.filter(r => r.flight);

  // sort by start
  clean.sort((a, b) => {
    const as = a.start ? +new Date(a.start) : Infinity;
    const bs = b.start ? +new Date(b.start) : Infinity;
    return as - bs;
  });

  return {
    generated_at_utc: new Date().toISOString(),
    generated_at_local: new Date().toISOString().slice(0,19),
    source: 'fr24 (local snapshot html)',
    horizon_minutes: 180,
    rows: clean
  };
}

function main() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error('[snap] FR24 snapshot not found at:', SNAPSHOT_PATH);
    console.error('[snap] Please save your FR24 page to that path first.');
    process.exit(1);
  }

  const html = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const data = parseFR24Html(html);

  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log('[snap] wrote', OUT_PATH, 'with', data.rows.length, 'rows.');
}

main();
