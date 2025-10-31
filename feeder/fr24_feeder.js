/**
 * feeder/fr24_feeder.js
 *
 * PURPOSE
 * -------
 * This is the "belt fixer" that was working for you before.
 *
 * What it does:
 * 1. Try to load a local FR24 snapshot if present:
 *      feeder/fr24-snapshot.json
 *    - This is for when you manually paste / export the FR24 arrivals JSON.
 *    - If this file exists and is valid, we use it as the source of flights.
 *
 * 2. If the snapshot does NOT exist (or is invalid), we FALL BACK to the
 *    previous, working behaviour:
 *      - read docs/assignments.json
 *      - fix belts
 *      - write docs/assignments.json back
 *
 * 3. Belt logic (same as the version you pasted):
 *    - Keep belt 7 if already set (domestic).
 *    - Otherwise, use belts 1..6 only.
 *    - We walk flights chronologically.
 *    - We rank belts 1..6 by "how long they've been used so far" BEFORE this
 *      flight starts (most-used first).
 *    - We try to place the flight on that belt respecting MIN_GAP_MIN = 1 min.
 *    - If NO belt can take it under spacing, we FORCE it on the most-used belt.
 *    - We also normalise reason → 'auto-assign' if we had to force.
 *
 * This is the behaviour you said was working.
 *
 * NOTE
 * ----
 * We do NOT touch timeline files here.
 */

const fs = require('fs');
const path = require('path');

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////

const ASSIGNMENTS_PATH = path.join(__dirname, '..', 'docs', 'assignments.json');
const SNAPSHOT_PATH    = path.join(__dirname, 'fr24-snapshot.json');

// belts we auto-assign (international/general)
const AUTO_BELTS = [1, 2, 3, 4, 5, 6];

// minimum spacing (minutes) for same-belt windows
const MIN_GAP_MIN = 1;

////////////////////////////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////////////////////////////

function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}

function overlapsOrTooClose(f1, f2, minGapMin) {
  const s1 = toMs(f1.start);
  const e1 = toMs(f1.end);
  const s2 = toMs(f2.start);
  const e2 = toMs(f2.end);

  // overlap
  if (s1 < e2 && s2 < e1) return true;

  // gap check (both directions)
  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < minGapMin || gap2 < minGapMin) return true;

  return false;
}

/**
 * usage[belt] = [ { startMs, endMs, flightRef }, ... ]
 */
function initUsage() {
  const usage = {};
  for (const b of AUTO_BELTS) {
    usage[b] = [];
  }
  return usage;
}

/**
 * Sum how long this belt has been used BEFORE cutoffMs
 */
function getBeltUsedMinutesSoFar(beltSlots, cutoffMs) {
  if (!beltSlots || beltSlots.length === 0) return 0;
  let totalMs = 0;
  for (const slot of beltSlots) {
    const s = slot.startMs;
    const e = slot.endMs;
    if (s >= cutoffMs) {
      continue;
    }
    const overlapEnd = Math.min(e, cutoffMs);
    if (overlapEnd > s) {
      totalMs += (overlapEnd - s);
    }
  }
  return totalMs / 60000;
}

/**
 * Return AUTO_BELTS sorted DESC by "minutes used so far"
 */
function rankBeltsByUsage(usage, flightStartMs) {
  const scored = AUTO_BELTS.map(b => {
    return {
      belt: b,
      mins: getBeltUsedMinutesSoFar(usage[b], flightStartMs)
    };
  });
  scored.sort((a, b) => b.mins - a.mins);
  return scored.map(x => x.belt);
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

function tryRankedBeltsForFlight(flight, rankedBelts, usage) {
  for (const belt of rankedBelts) {
    if (canPlaceOnBeltStrict(flight, belt, usage)) {
      recordPlacement(flight, belt, usage);
      return true;
    }
  }
  return false;
}

////////////////////////////////////////////////////////////////////////////////
// CORE ASSIGNMENT
////////////////////////////////////////////////////////////////////////////////

function assignBelts(rowsIn) {
  const rows = rowsIn.map(r => ({ ...r }));
  rows.sort((a, b) => toMs(a.start) - toMs(b.start));

  const usage = initUsage();

  for (const flight of rows) {
    const currentBelt = parseInt(flight.belt, 10);

    // keep belt 7 (domestic)
    if (currentBelt === 7) {
      // we do NOT add belt 7 into usage – same as your working version
      continue;
    }

    // keep any valid 1..6 and track it
    if (AUTO_BELTS.includes(currentBelt)) {
      recordPlacement(flight, currentBelt, usage);
      continue;
    }

    // need to place
    const startMs = toMs(flight.start);
    const ranked = rankBeltsByUsage(usage, startMs);

    const placed = tryRankedBeltsForFlight(flight, ranked, usage);
    if (!placed) {
      // force to most-used
      const fallback = ranked[0] || 1;
      recordPlacement(flight, fallback, usage);
    }

    if (!flight.reason || flight.reason === 'no_slot_available') {
      flight.reason = 'auto-assign';
    }
  }

  return rows;
}

////////////////////////////////////////////////////////////////////////////////
// I/O
////////////////////////////////////////////////////////////////////////////////

function loadFromAssignmentsJson() {
  const raw = fs.readFileSync(ASSIGNMENTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    meta: {
      generated_at_utc:  parsed.generated_at_utc  || '',
      generated_at_local: parsed.generated_at_local || '',
      source:             parsed.source             || '',
      horizon_minutes:    parsed.horizon_minutes    || 0
    },
    rows: Array.isArray(parsed.rows) ? parsed.rows : []
  };
}

/**
 * Try to load a local snapshot if present.
 * Expected shape:
 * {
 *   "generated_at_utc": "...",
 *   "generated_at_local": "...",
 *   "source": "flightradar24.com (screen-scrape)",
 *   "horizon_minutes": 180,
 *   "rows": [ ... ]
 * }
 */
function tryLoadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.rows)) {
      return null;
    }
    return {
      meta: {
        generated_at_utc:  parsed.generated_at_utc  || '',
        generated_at_local: parsed.generated_at_local || '',
        source:             parsed.source             || 'fr24-snapshot',
        horizon_minutes:    parsed.horizon_minutes    || 0
      },
      rows: parsed.rows
    };
  } catch (e) {
    console.error('[feeder] snapshot exists but could not be parsed, falling back to docs/assignments.json');
    return null;
  }
}

function writeAssignments(meta, rows) {
  const out = {
    generated_at_utc:  meta.generated_at_utc,
    generated_at_local: meta.generated_at_local,
    source:             meta.source,
    horizon_minutes:    meta.horizon_minutes,
    rows
  };
  fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(out, null, 2), 'utf8');
}

////////////////////////////////////////////////////////////////////////////////
// MAIN
////////////////////////////////////////////////////////////////////////////////

async function run() {
  try {
    // 1) try snapshot first
    let src = tryLoadSnapshot();
    if (!src) {
      // 2) fallback to existing docs/assignments.json (your old working way)
      src = loadFromAssignmentsJson();
    }

    const fixed = assignBelts(src.rows);

    // NOTE: we do NOT change source/horizon here – we keep whatever the file said
    writeAssignments(src.meta, fixed);

    console.log('[feeder] assignments.json updated (keep 7, fill 1–6, snapshot-fallback).');
    console.log(`[feeder] rows written: ${fixed.length}`);
  } catch (err) {
    console.error('[feeder] ERROR:', err);
    process.exitCode = 1;
  }
}

run();
