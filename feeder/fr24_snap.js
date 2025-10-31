// feeder/fr24_snap.js
// scrape FR24 BRS arrivals → normalised JSON for the web page
//
// WHAT THIS DOES
// 1. Opens FR24 arrivals for BRS.
// 2. Scrapes each visible "row/card" of arrivals data.
// 3. Normalises it into a clean row structure we use on the dashboard.
// 4. Keeps only flights within the next 3 hours.
// 5. Writes docs/assignments.json (which the webpage reads).
//
// REQUIREMENTS
// - Node 18+
// - npm i puppeteer
// - package.json must have { "type": "module" }

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OUTPUT goes to docs/assignments.json so GH Pages can see it
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");

// FR24 source page
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

// config
const DEFAULT_BELT_MIN = 30;   // default belt duration if we have a start time
const HORIZON_MIN      = 180;  // only keep ~3 hours ahead

// turn "21:35" into today's ISO timestamp
function todayIsoFromHHMM(hhmm) {
  if (!hhmm) return null;
  const now = new Date();
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0
  );
  return d.toISOString();
}

// pull "CPH" from "Copenhagen(CPH)"
function extractIataFromOrigin(origin) {
  if (!origin) return "";
  const m = origin.match(/\(([A-Za-z0-9]{2,5})\)/);
  return m ? m[1].toUpperCase() : "";
}

// skip junk rows like "Friday, 31 October"
function looksLikeJunk(title) {
  if (!title) return false;
  const s = title.trim().toLowerCase();
  const dayWords = [
    "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday"
  ];
  if (dayWords.some(d => s.startsWith(d))) return true;
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

// minutes late/early
// schedHHMM = "21:30", etaHHMM = "21:35"
function calcDelayMin(schedHHMM, etaHHMM) {
  if (!schedHHMM || !etaHHMM) return null;
  const now = new Date();
  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);
  const sched = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    sh,
    sm,
    0,
    0
  );
  const eta = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    eh,
    em,
    0,
    0
  );
  return Math.round((eta - sched) / 60000);
}

// add X minutes to startIso
function makeEndIso(startIso, minutes = DEFAULT_BELT_MIN) {
  if (!startIso) return null;
  const s = new Date(startIso);
  return new Date(s.getTime() + minutes * 60000).toISOString();
}

async function main() {
  console.log("[fr24_snap] start…");

  // launch a headless browser
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto(FR24_URL, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  // wait a little bit for content to render
  await page.waitForSelector("body", { timeout: 60000 }).catch(() => {});

  // pull raw blocks of text from anything that looks like a row/card/table
  const rawBlocks = await page.evaluate(() => {
    const out = [];

    // classic table rows (older layout)
    document
      .querySelectorAll("table tbody tr, .table tbody tr")
      .forEach(tr => {
        const txt = tr.innerText || tr.textContent || "";
        if (txt.trim()) {
          out.push({ kind: "table", text: txt });
        }
      });

    // new card/grid style rows (FR24 has changed layout multiple times)
    document
      .querySelectorAll('[role="row"], .row, .list-item, .data-row')
      .forEach(el => {
        const txt = el.innerText || el.textContent || "";
        if (txt.trim()) {
          out.push({ kind: "card", text: txt });
        }
      });

    // absolute fallback: dump whole body if nothing else
    if (out.length === 0) {
      const txt = document.body.innerText || "";
      out.push({ kind: "body", text: txt });
    }

    return out;
  });

  await browser.close();

  // parse / normalise each block into { flight, origin, ... }
  const parsedRows = [];

  for (const blk of rawBlocks) {
    const lines = blk.text
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    if (!lines.length) continue;

    const first = lines[0];
    if (looksLikeJunk(first)) {
      continue;
    }

    // Typical FR24 card layout we saw:
    //
    //   0: "Estimated 18:28"  (status + ETA)
    //   1: "18:20"            (scheduled)
    //   2: "SI4494"           (flight)
    //   3: "Jersey(JER)"      (origin)
    //   4: "AT76"             (aircraft type)
    //   5: "G-ISLP"           (reg)
    //   6: "Blue Islands"     (airline)
    //
    if (
      lines.length >= 4 &&
      /^(estimated|delayed|landed|scheduled)/i.test(lines[0])
    ) {
      const statusLine   = lines[0];      // "Estimated 21:35"
      const schedLine    = lines[1] || ""; // "21:30"
      const flightLine   = lines[2] || ""; // "U22848"
      const originLine   = lines[3] || ""; // "Milan(MXP)"
      const aircraftLine = lines[4] || ""; // "A320" etc
      // airline usually appears after reg; could be index 6 or 5 depending on row
      const airlineLine  = lines[6] || lines[5] || "";

      // pull ETA time (HH:MM) out of status string
      let etaHHMM = "";
      const mEta = statusLine.match(/(\d{1,2}:\d{2})/);
      if (mEta) {
        etaHHMM = mEta[1];
      }

      const etaIso   = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      const endIso   = makeEndIso(startIso, DEFAULT_BELT_MIN);

      parsedRows.push({
        flight: flightLine,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "",           // fill later
        belt: "",           // fill later (allocator)
        start: startIso,
        end: endIso,
        reason: "fr24:live",
        airline: airlineLine,
        aircraft: aircraftLine ? `(${aircraftLine})` : "",
        pax_estimate: null,
        scheduled_local: schedLine,
        eta_local: etaHHMM || "",
        delay_min: calcDelayMin(schedLine, etaHHMM),
        ui_state: "upcoming",
        ui_age_min: 0
      });

      continue;
    }

    // fallback mode:
    // try to find something that *looks* like a flight number
    // e.g. "U22848", "FR506", "KL1083"
    const maybeFlight = lines.find(x => /[A-Za-z]{1,3}\d{2,4}/.test(x));
    if (maybeFlight) {
      const schedLine  = lines.find(x => /^\d{1,2}:\d{2}$/.test(x)) || "";
      const originLine = lines.find(x => /\([A-Za-z0-9]{2,5}\)/.test(x)) || "";
      const statusLine =
        lines.find(x => /estimated|delayed|landed|scheduled/i.test(x)) ||
        "scheduled";

      const etaHHMM =
        (statusLine.match(/(\d{1,2}:\d{2})/) || [null, ""])[1] || "";
      const etaIso   = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      const endIso   = makeEndIso(startIso, DEFAULT_BELT_MIN);

      parsedRows.push({
        flight: maybeFlight,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "",
        belt: "",
        start: startIso,
        end: endIso,
        reason: "fr24:fallback",
        airline: "",
        aircraft: "",
        pax_estimate: null,
        scheduled_local: schedLine,
        eta_local: etaHHMM || "",
        delay_min: calcDelayMin(schedLine, etaHHMM),
        ui_state: "upcoming",
        ui_age_min: 0
      });
    }
  }

  // ------------------------------------------------------------------
  // FILTER + NORMALISE
  //
  // We only want:
  // - flights that actually have a flight code
  // - flights that have some time anchor (eta/start)
  // - flights arriving in the next HORIZON_MIN minutes (3h)
  // - flow default "INTERNATIONAL"
  // ------------------------------------------------------------------

  const now = new Date();
  const horizonMs = now.getTime() + HORIZON_MIN * 60000;

  const filtered = parsedRows
    // drop rows with no flight ID at all
    .filter(r => r.flight && r.flight.trim() !== "")
    // drop rows that have neither eta nor start
    .filter(r => r.eta || r.start)
    // enforce 3h ahead horizon (if we *do* have a timestamp)
    .filter(r => {
      const t = r.eta
        ? new Date(r.eta).getTime()
        : r.start
          ? new Date(r.start).getTime()
          : null;
      if (!t) return true; // keep rows we couldn't time (should be rare now)
      return t <= horizonMs;
    })
    // ensure flow is set
    .map(r => ({
      ...r,
      flow: r.flow && r.flow.trim() !== "" ? r.flow : "INTERNATIONAL"
    }));

  // final payload written to docs/assignments.json
  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: HORIZON_MIN,
    rows: filtered
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), "utf8");

  console.log(
    `[fr24_snap] wrote ${filtered.length} rows to ${OUTPUT_PATH} (next ${HORIZON_MIN} min).`
  );
}

// run
main().catch(err => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});
