// feeder/fr24_snap.js (ESM, enriched to match your old assignments.json)
//
// 1) Scrape FR24 BRS arrivals
// 2) Normalise rows to look like your previous working JSON:
//    - flight
//    - origin + origin_iata
//    - eta (ISO)
//    - eta_local (HH:MM)
//    - scheduled_local
//    - status
//    - flow: "INTERNATIONAL" (default)
//    - belt: "" (let fr24_feeder.js fill 1..6, keep 7)
//    - start / end: eta → +30 min
//    - reason: "fr24:snap"
// 3) Write to docs/assignments.json
//
// Then you run:
//    node feeder/fr24_feeder.js
// to fill the belts.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'assignments.json');
const FR24_URL    = 'https://www.flightradar24.com/data/airports/brs/arrivals';

// --- helpers ---
function toIsoUtc(d) {
  return new Date(d).toISOString();
}

// "Estimated 20:34" → "20:34"
// "Delayed 21:09"   → "21:09"
// "Landed 19:51"    → "19:51"
function extractHHMM(statusText) {
  if (!statusText) return null;
  const m = statusText.match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

// make today's ISO in Europe/London for the given HH:MM
function todayIsoFromHHMM(hhmm) {
  if (!hhmm) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  // build today in local, then turn to ISO
  const dt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0
  );
  return dt.toISOString();
}

// make +30 min window
function addMinutesIso(iso, minutes) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

// "(CPH)" → "CPH"
function extractIata(originText) {
  if (!originText) return '';
  const m = originText.match(/\(([A-Z0-9]{2,4})\)/i);
  return m ? m[1].toUpperCase() : '';
}

async function main() {
  console.log('[fr24_snap] starting…');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.goto(FR24_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // adjust if FR24 changes layout
    await page.waitForSelector('table, .table', { timeout: 60000 }).catch(() => {});

    const rawRows = await page.evaluate(() => {
      const out = [];
      const trs = document.querySelectorAll('table tbody tr, .table tbody tr');
      trs.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (!tds.length) return;

        const flightText = tds[0]?.innerText?.trim() || '';
        const originText = tds[1]?.innerText?.trim() || '';
        const schedText  = tds[2]?.innerText?.trim() || '';
        const statusText = tds[3]?.innerText?.trim() || '';

        if (!flightText) return;

        out.push({
          flightText,
          originText,
          schedText,
          statusText
        });
      });
      return out;
    });

    const now = new Date();
    const enrichedRows = rawRows.map(r => {
      const hhmm = extractHHMM(r.statusText) || r.schedText || null;
      const etaIso = hhmm ? todayIsoFromHHMM(hhmm) : null;
      const startIso = etaIso || toIsoUtc(now);
      const endIso   = addMinutesIso(startIso, 30);
      const originIata = extractIata(r.originText);

      return {
        flight: r.flightText,
        origin: r.originText,
        origin_iata: originIata,
        eta: etaIso,
        status: r.statusText || '',
        flow: 'INTERNATIONAL',
        belt: "",
        start: startIso,
        end: endIso,
        reason: 'fr24:snap',
        airline: "",           // FR24 list page doesn’t always show it
        aircraft: "",          // same
        pax_estimate: null,
        scheduled_local: r.schedText || '',
        eta_local: hhmm || '',
        delay_min: null,
        ui_state: 'upcoming',
        ui_age_min: 0
      };
    });

    const outJson = {
      generated_at_utc: toIsoUtc(now),
      generated_at_local: toIsoUtc(now),
      source: 'flightradar24.com (live screen-scrape)',
      horizon_minutes: 180,
      rows: enrichedRows
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), 'utf8');
    console.log(`[fr24_snap] wrote ${enrichedRows.length} rows to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error('[fr24_snap] ERROR:', err);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[fr24_snap] FATAL:', err);
  process.exit(1);
});
