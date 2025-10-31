// feeder/feeder.js
// BRS allocator, reusable
// - Auto belts: 1,2,3,5,6
// - Keep 7 (domestic/CTA target)
// - If none fits → force to earliest-clearing belt (the one whose last end time is smallest)

const AUTO_BELTS = [1, 2, 3, 5, 6];
const MIN_GAP_MIN = 1;

// --- time helpers ---
function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}

// overlap + cooldown check
function overlapsOrTooClose(f1, f2, minGapMin) {
  const s1 = toMs(f1.start);
  const e1 = toMs(f1.end);
  const s2 = toMs(f2.start);
  const e2 = toMs(f2.end);

  // true overlap
  if (s1 < e2 && s2 < e1) return true;

  // cooldown
  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < minGapMin || gap2 < minGapMin) return true;

  return false;
}

// create empty usage map
function initUsage() {
  const usage = {};
  for (const b of AUTO_BELTS) usage[b] = [];
  return usage;
}

// last end time on a belt
function getBeltFreeTime(beltSlots) {
  if (!beltSlots || beltSlots.length === 0) return 0;
  const last = beltSlots[beltSlots.length - 1];
  return last.endMs;
}

// pick the belt that will clear earliest
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

// can this flight go on this belt under strict rules?
function canPlaceOnBeltStrict(flight, belt, usage) {
  const beltSlots = usage[belt] || [];
  for (const slot of beltSlots) {
    if (
      overlapsOrTooClose(
        { start: flight.start, end: flight.end },
        { start: slot.flightRef.start, end: slot.flightRef.end },
        MIN_GAP_MIN
      )
    ) {
      return false;
    }
  }
  return true;
}

// actually record placement
function recordPlacement(flight, belt, usage) {
  flight.belt = belt;
  usage[belt].push({
    startMs: toMs(flight.start),
    endMs: toMs(flight.end),
    flightRef: flight
  });
  usage[belt].sort((a, b) => a.startMs - b.startMs);
}

// main
function assignBelts(rowsIn) {
  // clone to avoid mutating caller’s array
  const rows = rowsIn.map(r => ({ ...r }));

  // sort by start time so we place in chronological order
  rows.sort((a, b) => toMs(a.start) - toMs(b.start));

  const usage = initUsage();

  for (const flight of rows) {
    const currentBelt = parseInt(flight.belt, 10);

    // keep belt 7 (domestic/CTA case)
    if (currentBelt === 7) {
      continue;
    }

    // if flight already sits on a valid auto belt → just track it
    if (AUTO_BELTS.includes(currentBelt)) {
      recordPlacement(flight, currentBelt, usage);
      continue;
    }

    // otherwise we must place it
    let placed = false;
    for (const b of AUTO_BELTS) {
      if (canPlaceOnBeltStrict(flight, b, usage)) {
        recordPlacement(flight, b, usage);
        placed = true;
        break;
      }
    }

    // if no belt passed the rules → force to earliest-clearing belt
    if (!placed) {
      const fb = pickEarliestClearingBelt(usage);
      recordPlacement(flight, fb, usage);
    }

    // normalise reason
    if (!flight.reason || flight.reason === 'no_slot_available') {
      flight.reason = 'auto-assign';
    }
  }

  return rows;
}

module.exports = {
  assignBelts
};
