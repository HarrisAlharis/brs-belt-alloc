/**
 * feeder/fr24_feeder.js
 *
 * BRS allocator pipeline:
 * 1. read docs/assignments.json (raw from fr24_snap.js)
 * 2. normalise rows (set start/end if missing)
 * 3. apply BRS belt logic (no 4, keep 7, 1/2/3/5/6, force earliest-clearing)
 * 4. write docs/assignments.json back (now with belts)
 */

const fs = require('fs');
const path = require('path');
const { assignBelts } = require('./feeder');

const ASSIGNMENTS_PATH = path.join(__dirname, '..', 'docs', 'assignments.json');

const AUTO_BELTS = [1, 2, 3, 5, 6];
const DOMESTIC_BELT = 7;

// make a belt window if missing
function ensureWindow(row) {
  const minute = 60 * 1000;
  const now = Date.now();
  const start = row.start
    ? new Date(row.start)
    : row.eta
      ? new Date(row.eta)
      : new Date(now);

  // 30 min default window
  const end = row.end
    ? new Date(row.end)
    : new Date(start.getTime() + 30 * minute);

  row.start = start.toISOString();
  row.end = end.toISOString();
}

function isDomestic(row) {
  // your earlier JSON already had flow="DOMESTIC" — keep that rule
  return (row.flow && row.flow.toUpperCase() === 'DOMESTIC');
}

function loadAssignments() {
  const raw = fs.readFileSync(ASSIGNMENTS_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeAssignments(meta, rows) {
  const out = {
    generated_at_utc: new Date().toISOString(),
    generated_at_local: new Date().toISOString(),
    source: meta?.source || 'flightradar24.com (screen-scrape)',
    horizon_minutes: meta?.horizon_minutes || 180,
    rows
  };
  fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(out, null, 2), 'utf8');
}

async function run() {
  console.log('[fr24_feeder] starting…');
  const data = loadAssignments();
  const rows = Array.isArray(data.rows) ? data.rows.slice() : [];

  // normalise each row
  for (const r of rows) {
    ensureWindow(r);

    // detect domestic and hard-set belt
    if (isDomestic(r)) {
      r.belt = DOMESTIC_BELT;
      r.reason = 'domestic→7';
    }

    // ensure belt is number or empty
    if (r.belt !== undefined && r.belt !== null && r.belt !== '') {
      const nb = Number(r.belt);
      if (Number.isFinite(nb)) r.belt = nb;
    }
  }

  // run allocator
  const fixedRows = assignBelts(rows);

  // write back
  writeAssignments(data, fixedRows);
  console.log(`[fr24_feeder] wrote ${fixedRows.length} rows to assignments.json`);
}

run().catch(err => {
  console.error('[fr24_feeder] ERROR:', err);
  process.exit(1);
});
