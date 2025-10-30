// feeder/feeder.js
// BRS allocator, reusable
// - Auto belts: 1,2,3,5,6
// - Keep 7
// - If none fits → force to earliest-clearing belt

const AUTO_BELTS = [1, 2, 3, 5, 6];
const MIN_GAP_MIN = 1;

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

  for (const flight of rows) {
    const currentBelt = parseInt(flight.belt, 10);

    // keep domestic
    if (currentBelt === 7) continue;

    // keep valid and track
    if (AUTO_BELTS.includes(currentBelt)) {
      recordPlacement(flight, currentBelt, usage);
      continue;
    }

    // need to place
    let placed = false;
    for (const b of AUTO_BELTS) {
      if (canPlaceOnBeltStrict(flight, b, usage)) {
        recordPlacement(flight, b, usage);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const fb = pickEarliestClearingBelt(usage);
      recordPlacement(flight, fb, usage);
    }

    if (!flight.reason || flight.reason === 'no_slot_available') {
      flight.reason = 'auto-assign';
    }
  }

  return rows;
}

module.exports = {
  assignBelts
};
