/**
 * fr24_feeder.js (ESM version)
 *
 * PURPOSE
 * -------
 * 1. Load the latest docs/assignments.json that already exists.
 *    This file already has all arrivals, times, metadata, etc.
 *
 * 2. Fix belt assignment for every flight:
 *    - No flight is allowed to have an empty belt ("", null, undefined).
 *    - We only use belts 1..6 for international / general flow.
 *    - Belt 7 is kept only if it was already explicitly assigned (domestic).
 *
 * NEW RULE (longest-running belt rule, user request 2025-10-28):
 * If a flight has no valid belt, we assign it automatically according to:
 *
 *    a) Look at belts 1..6 and measure how long they've already been in use
 *       BEFORE this flight starts (total historical "on time").
 *    b) Sort belts 1..6 so the most-used belt so far is first.
 *    c) Try to place this flight on that belt if spacing rules allow.
 *       Spacing rule = can't overlap / be closer than 1 minute to an
 *       already assigned interval on that belt.
 *    d) If that belt can't take it under spacing, try the next belt, etc.
 *    e) If NONE of them can take it under spacing, FORCE it onto the
 *       single most-used belt anyway so it never stays blank.
 *
 * This guarantees: no more "no_slot_available", no blank belt.
 *
 * 3. After fixing, write the updated assignments.json back to /docs with
 *    all rows updated. We preserve:
 *    - generated_at_utc
 *    - generated_at_local
 *    - source
 *    - horizon_minutes
 *    - every field in each row except we overwrite:
 *        belt (filled 1..6 if it was blank)
 *        reason (set to "auto-assign" if we had to force-assign)
 *
 * IMPORTANT
 * ---------
 * - We DO NOT touch timeline.html / timeline.js / timeline.css.
 * - We DO NOT reorder keys in rows except where we have to update belt/reason.
 * - We DO NOT drop any fields like status, ui_state, etc.
 * - We DO NOT try to be clever with heavy flights other than what you asked.
 *
 * HOW THIS RUNS
 * -------------
 * Your run_feeder.bat / PowerShell calls:
 *    node .\feeder\fr24_feeder.js
 *
 * This version is ESM because package.json has "type": "module".
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

////////////////////////////////////////////////////////////////////////////////
// ESM __dirname
////////////////////////////////////////////////////////////////////////////////
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

////////////////////////////////////////////////////////////////////////////////
// CONFIG / CONSTANTS
////////////////////////////////////////////////////////////////////////////////

// Path to assignments.json inside the repo
const ASSIGNMENTS_PATH = path.join(__dirname, '..', 'docs', 'assignments.json');

// Belts we are allowed to auto-assign if a belt is missing
const AUTO_BELTS = [1, 2, 3, 4, 5, 6];

// Minimum gap (minutes) we consider "separate enough" for vertical stacking
// When placing two flights on the same belt visually, they can't overlap and
// can't be tighter than 1 minute gap unless we absolutely cannot place them.
const MIN_GAP_MIN = 1;

////////////////////////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////////////////////////

function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}

function overlapsOrTooClose(f1, f2, minGapMin) {
  // true if they overlap OR are closer than minGapMin minutes apart
  const s1 = toMs(f1.start);
  const e1 = toMs(f1.end);
  const s2 = toMs(f2.start);
  const e2 = toMs(f2.end);

  // overlap check
  if (s1 < e2 && s2 < e1) return true;

  // gap check
  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < minGapMin || gap2 < minGapMin) return true;

  return false;
}

/**
 * Create tracking structure:
 *   usage[belt] = [{ startMs, endMs, flightRef }, ...]
 */
function initUsage() {
  const usage = {};
  for (const b of AUTO_BELTS) {
    usage[b] = [];
  }
  return usage;
}

/**
 * getBeltUsedMinutesSoFar(usage[belt], cutoffMs)
 * Sum how long this belt has been in use BEFORE "cutoffMs".
 */
function getBeltUsedMinutesSoFar(beltSlots, cutoffMs) {
  if (!beltSlots || beltSlots.length === 0) return 0;
  let totalMs = 0;
  for (const slot of beltSlots) {
    const s = slot.startMs;
    const e = slot.endMs;
    if (s >= cutoffMs) {
      continue; // future usage doesn't count yet
    }
    const overlapEnd = Math.min(e, cutoffMs);
    if (overlapEnd > s) {
      totalMs += (overlapEnd - s);
    }
  }
  return totalMs / 60000;
}

/**
 * rankBeltsByUsage(usage, flightStartMs)
 * Return AUTO_BELTS sorted DESC by "minutes used so far".
 * So [beltWithMostHistory, ..., beltWithLeastHistory]
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

/**
 * canPlaceOnBeltStrict(flight, belt, usage)
 * True if flight can be placed on this belt under MIN_GAP_MIN spacing.
 */
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

/**
 * recordPlacement(flight, belt, usage)
 * Actually assign belt to the flight and add to usage timeline.
 */
function recordPlacement(flight, belt, usage) {
  flight.belt = belt;
  usage[belt].push({
    startMs: toMs(flight.start),
    endMs: toMs(flight.end),
    flightRef: flight
  });
  usage[belt].sort((a, b) => a.startMs - b.startMs);
}

/**
 * tryRankedBeltsForFlight(flight, rankedBelts, usage)
 * Try each belt in order (most-used first). If strict spacing works, place there.
 * Return true if placed, false if none worked strictly.
 */
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
// CORE LOGIC: assignBelts
////////////////////////////////////////////////////////////////////////////////

/**
 * assignBelts(rowsIn)
 *
 * rowsIn = copy of assignments.rows from disk
 *
 * We:
 *  - Sort flights chronologically by .start
 *  - Walk them in order
 *  - If a flight already has belt:
 *      - If it's 7, keep 7 (domestic stays belt 7)
 *      - If it's in 1..6, keep that
 *      - Otherwise treat as "unassigned"
 *  - If "unassigned":
 *      - Rank belts 1..6 by total usage before this flight
 *      - Try spacing
 *      - If none fits, FORCE assign onto the most-used belt
 *
 * After assignment, if we had to force-assign a blank one,
 * we also rewrite its "reason" to "auto-assign".
 */
function assignBelts(rowsIn) {
  // clone rows so we don't mutate the input array directly
  const rows = rowsIn.map(r => ({ ...r }));

  // sort by chronological start
  rows.sort((a, b) => toMs(a.start) - toMs(b.start));

  // usage tracker per belt 1..6
  const usage = initUsage();

  for (const flight of rows) {
    // Check what belt we already have
    let currentBelt = parseInt(flight.belt, 10);

    // Keep belt 7 as-is (domestic), do not reassign it
    if (currentBelt === 7) {
      // We do NOT record belt 7 into usage, because we don't use belt 7
      // when auto-assigning other international flights.
      continue;
    }

    // If it's already in 1..6, keep it AND record usage so future
    // flights see that belt as "busy / used"
    if (AUTO_BELTS.includes(currentBelt)) {
      recordPlacement(flight, currentBelt, usage);
      continue;
    }

    // Otherwise, belt is blank or invalid. We must assign one now.
    const startMs = toMs(flight.start);
    const rankedBelts = rankBeltsByUsage(usage, startMs);

    // Try to place respecting spacing
    const placedStrict = tryRankedBeltsForFlight(flight, rankedBelts, usage);
    if (!placedStrict) {
      // Force onto the most-used belt so it is never blank
      const fallbackBelt = rankedBelts[0] || 1;
      recordPlacement(flight, fallbackBelt, usage);
    }

    // Update "reason" if it used to say "no_slot_available"
    if (
      !AUTO_BELTS.includes(currentBelt) &&
      currentBelt !== 7 &&
      (flight.reason === 'no_slot_available' || !flight.reason)
    ) {
      flight.reason = 'auto-assign';
    }
  }

  return rows;
}

////////////////////////////////////////////////////////////////////////////////
// I/O: Load latest assignments.json from disk
////////////////////////////////////////////////////////////////////////////////

/**
 * loadRawFlightsFromDisk()
 *
 * We read docs/assignments.json and treat its "rows" as the
 * inbound schedule to fix.
 */
function loadRawFlightsFromDisk() {
  const raw = fs.readFileSync(ASSIGNMENTS_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  const meta = {
    generated_at_utc:   parsed.generated_at_utc   || '',
    generated_at_local: parsed.generated_at_local || '',
    source:             parsed.source             || '',
    horizon_minutes:    parsed.horizon_minutes    || 0
  };

  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];

  return { meta, rows };
}

////////////////////////////////////////////////////////////////////////////////
// I/O: Write updated assignments.json
////////////////////////////////////////////////////////////////////////////////

function writeAssignments(meta, fixedRows) {
  const outObj = {
    generated_at_utc:   meta.generated_at_utc,
    generated_at_local: meta.generated_at_local,
    source:             meta.source,
    horizon_minutes:    meta.horizon_minutes,
    rows:               fixedRows
  };
  const jsonStr = JSON.stringify(outObj, null, 2);
  fs.writeFileSync(ASSIGNMENTS_PATH, jsonStr, 'utf8');
}

////////////////////////////////////////////////////////////////////////////////
// MAIN EXECUTION
////////////////////////////////////////////////////////////////////////////////

async function run() {
  try {
    const { meta, rows } = loadRawFlightsFromDisk();
    const fixedRows = assignBelts(rows);
    writeAssignments(meta, fixedRows);
    console.log('[feeder] assignments.json updated with enforced belts 1–6 / no blanks.');
  } catch (err) {
    console.error('[feeder] ERROR:', err);
    process.exitCode = 1;
  }
}

// Kick off
run();
