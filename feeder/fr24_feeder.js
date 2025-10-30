/**
 * feeder/fr24_feeder.js
 *
 * BRS allocator pipeline
 * - Step 1 (upstream): feeder/scrape_from_fr24_snapshot.js
 *      → writes feeder/source_fr24.json
 * - Step 2 (this file): read source_fr24.json
 *      → apply BRS belt rules
 *      → write docs/assignments.json
 *
 * Rules:
 * - No belt 4
 * - Auto belts: 1,2,3,5,6
 * - Keep 7 if it was set (domestic)
 * - If no belt passes spacing → force to earliest-clearing belt
 */

const fs = require('fs');
const path = require('path');

const SOURCE_SNAPSHOT_PATH = path.join(__dirname, 'source_fr24.json');  // NEW
const ASSIGNMENTS_PATH     = path.join(__dirname, '..', 'docs', 'assignments.json');

const AUTO_BELTS = [1, 2, 3, 5, 6];
const MIN_GAP_MIN = 1;

// ---------- helpers ----------
function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}
function overlapsOrTooClose(f1, f2, minGapMin) {
  const s1 = toMs(f1.start);
  const e1 = toMs(f1.end);
  const s2 = toMs(f2.start);
  const e2 = toMs(f2.end);
  if (s1 < e2 && s2 < e1) return true;
  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < minGapMin || gap2 < minGapMin) return true;
  return false;
}
function initUsage() {
  const usage = {};
  for (const b of AUTO_BELTS) usage[b] = [];
  return usage;
}
function getBeltFreeTime(beltSlots) {
  if (!beltSlots || beltSlots.length === 0) return 0;
  const last = beltSlots[beltSlots.length - 1];
  return last.endMs;
}
function pickEarliestClearingBelt(usage) {
  let bestBelt = null;
  let bestEnd = Infinity;
  for (const b of AUTO_BELTS) {
    const end = getBeltFreeTime(usage[b]);
    if (end < bestEnd) {
      bestEnd = end;
      bestBelt = b;
    }
  }
  return bestBelt || AUTO_BELTS[0];
}
function canPlaceOnBeltStrict(flight, belt, usage) {
  const beltSlots = usage[belt] || [];
  for (const slot of beltSlots) {
    if (overlapsOrTooClose(
      { start: flight.start, end: flight.end },
      { start: slot.flightRef.start, end: slot.flightRef.end },
      MIN_GAP_MIN
    )) {
      return false;
    }
  }
  return true;
}
function recordPlacement(flight, belt, usage) {
  flight.belt = belt;
  usage[belt].push({
    startMs: toMs(flight.start),
    endMs: toMs(flight.end),
    flightRef: flight
  });
  usage[belt].sort((a, b) => a.startMs - b.startMs);
}
function assignBelts(rowsIn) {
  const rows = rowsIn.map(r => ({ ...r }));
  rows.sort((a, b) => toMs(a.start) - toMs(b.start));
  const usage = initUsage();
  let fixed = 0;

  for (const flight of rows) {
    const currentBelt = parseInt(flight.belt, 10);

    // domestic stays 7
    if (currentBelt === 7) continue;

    // valid belts stay + tracked
    if (AUTO_BELTS.includes(currentBelt)) {
      recordPlacement(flight, currentBelt, usage);
      continue;
    }

    // we need to place
    let placed = false;
    for (const b of AUTO_BELTS) {
      if (canPlaceOnBeltStrict(flight, b, usage)) {
        recordPlacement(flight, b, usage);
        placed = true;
        break;
      }
    }

    // force to earliest-clearing belt
    if (!placed) {
      const fb = pickEarliestClearingBelt(usage);
      recordPlacement(flight, fb, usage);
    }

    if (!flight.reason || flight.reason === 'no_slot_available') {
      flight.reason = 'auto-assign';
    }

    fixed++;
  }

  return { rows, fixed };
}

// ---------- I/O ----------
function loadSource() {
  // prefer fresh source from snapshot
  if (fs.existsSync(SOURCE_SNAPSHOT_PATH)) {
    const raw = fs.readFileSync(SOURCE_SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      meta: {
        generated_at_utc: parsed.generated_at_utc || new Date().toISOString(),
        generated_at_local: parsed.generated_at_local || new Date().toISOString().slice(0,19),
        source: parsed.source || 'fr24 (snapshot)',
        horizon_minutes: parsed.horizon_minutes || 180
      },
      rows: Array.isArray(parsed.rows) ? parsed.rows : []
    };
  }

  // fallback: current assignments.json
  const raw = fs.readFileSync(ASSIGNMENTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    meta: {
      generated_at_utc: parsed.generated_at_utc || '',
      generated_at_local: parsed.generated_at_local || '',
      source: parsed.source || '',
      horizon_minutes: parsed.horizon_minutes || 0
    },
    rows: Array.isArray(parsed.rows) ? parsed.rows : []
  };
}

function writeAssignments(meta, rows) {
  const out = {
    generated_at_utc: meta.generated_at_utc,
    generated_at_local: meta.generated_at_local,
    source: meta.source,
    horizon_minutes: meta.horizon_minutes,
    rows
  };
  fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(out, null, 2), 'utf8');
}

// ---------- main ----------
async function run() {
  console.log('[feeder] BRS run (snapshot → assign)…');
  const { meta, rows } = loadSource();
  const { rows: fixedRows, fixed } = assignBelts(rows);
  writeAssignments(meta, fixedRows);
  console.log(`[feeder] fixed flights: ${fixed}`);
  console.log('[feeder] wrote docs/assignments.json');
}

run().catch(err => {
  console.error('[feeder] ERROR:', err);
  process.exitCode = 1;
});
