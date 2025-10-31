// feeder/fr24_snap.js
//
// PURPOSE
// - Open FlightRadar24 BRS arrivals page (or your saved URL)
// - Grab the visible arrivals table
// - Normalise into a structure our feeder understands
// - Save to docs/assignments.json (raw, BEFORE belt logic)
//
// REQUIREMENTS
// - Node 18+
// - npm i puppeteer
//
// NOTE
// - If FR24 changes the selector, adjust the query parts below.
// - If you use a local HTML export instead of live FR24, just read that file
//   instead of Puppeteer and keep the rest exactly the same.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'assignments.json');
// your FR24 URL – use the actual Bristol arrivals URL you normally open
const FR24_URL = 'https://www.flightradar24.com/data/airports/brs/arrivals';

function toIsoLocal(d) {
  // returns ISO-like string in UTC for consistency
  return new Date(d).toISOString();
}

async function main() {
  console.log('[fr24_snap] starting…');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // wait for table – adjust if FR24 changes
  await page.waitForSelector('table, .table', { timeout: 60000 }).catch(() => {});

  // run in page context – extract rows
  const rows = await page.evaluate(() => {
    // this part depends on FR24’s structure – keep it defensive
    const out = [];
    // TRY to find table rows
    const trs = document.querySelectorAll('table tbody tr, .table tbody tr');
    trs.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) return;

      // You may need to adjust the column mapping here depending on FR24 layout
      const flightText = tds[0]?.innerText?.trim() || '';
      const originText = tds[1]?.innerText?.trim() || '';
      const schedText  = tds[2]?.innerText?.trim() || '';
      const statusText = tds[3]?.innerText?.trim() || '';

      // we only care about basic fields; rest is feeder work
      out.push({
        flight: flightText,
        origin: originText,
        // we don’t know the belt yet
        belt: '',
        // FR24 shows times in local; we still store ISO so timeline can read it
        scheduled_local: schedText,
        status: statusText
      });
    });
    return out;
  });

  const now = new Date();
  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),  // timeline shows this
    source: 'flightradar24.com (live screen-scrape)',
    horizon_minutes: 180,
    rows
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), 'utf8');
  console.log(`[fr24_snap] wrote ${rows.length} raw rows to ${OUTPUT_PATH}`);

  await browser.close();
}

main().catch(err => {
  console.error('[fr24_snap] ERROR:', err);
  process.exit(1);
});
