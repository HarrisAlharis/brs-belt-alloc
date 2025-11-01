// feeder/fr24_snap.js
// Scrape FR24 BRS arrivals → normalised JSON for the web page (ESM)

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

// belt window policy: start = ETA + 15, end = start + 30 (total 45)
const START_OFFSET_MIN = 15;
const DURATION_MIN = 30;
const HORIZON_MIN = 180; // 3 hours

// ---------- time helpers ----------
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

function addMin(iso, m) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return new Date(t + m * 60000).toISOString();
}

function calcDelayMin(schedHHMM, etaHHMM) {
  if (!schedHHMM || !etaHHMM) return null;
  const now = new Date();
  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);
  const s = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    sh,
    sm,
    0,
    0
  );
  const e = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    eh,
    em,
    0,
    0
  );
  return Math.round((e - s) / 60000);
}

function firstTimeMs(r) {
  const t = r.eta || r.start;
  return t ? new Date(t).getTime() : Number.MAX_SAFE_INTEGER;
}

// ---------- text helpers ----------
function extractIataFromOrigin(origin) {
  if (!origin) return "";
  const m = origin.match(/\(([A-Za-z0-9]{2,5})\)/);
  return m ? m[1].toUpperCase() : "";
}

function looksLikeJunk(title) {
  if (!title) return false;
  const s = title.trim().toLowerCase();
  if (
    [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].some((d) => s.startsWith(d))
  )
    return true;
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

function normFlight(f) {
  return String(f || "").replace(/\s+/g, "").toUpperCase();
}

// landed > estimated/delayed > scheduled > other
function statusScore(s) {
  const x = String(s || "").toLowerCase();
  if (x.startsWith("landed")) return 3;
  if (x.startsWith("estimated") || x.startsWith("delayed")) return 2;
  if (x.startsWith("scheduled")) return 1;
  return 0;
}

// prefer the "better" row when deduping
function betterRow(a, b) {
  const sa = statusScore(a.status);
  const sb = statusScore(b.status);
  if (sa !== sb) return sa > sb ? a : b;

  const aHasEta = !!a.eta;
  const bHasEta = !!b.eta;
  if (aHasEta !== bHasEta) return aHasEta ? a : b;

  if (aHasEta && bHasEta) {
    const ta = new Date(a.eta).getTime();
    const tb = new Date(b.eta).getTime();
    return tb > ta ? b : a;
  }
  return a;
}

// ---------- main ----------
async function main() {
  console.log("[fr24_snap] start scrape…");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 60000 }).catch(() => {});

  // Collect multiple possible structures; we'll dedupe later.
  const rawBlocks = await page.evaluate(() => {
    const out = [];

    // table-ish rows
    document
      .querySelectorAll("table tbody tr, .table tbody tr")
      .forEach((tr) => {
        const txt = tr.innerText || tr.textContent || "";
        if (txt.trim()) out.push({ kind: "table", text: txt });
      });

    // card/list rows
    document
      .querySelectorAll(
        '[role="row"], .row, .list-item, .data-row'
      )
      .forEach((el) => {
        const txt = el.innerText || el.textContent || "";
        if (txt.trim()) out.push({ kind: "card", text: txt });
      });

    if (out.length === 0) {
      const txt = document.body.innerText || "";
      out.push({ kind: "body", text: txt });
    }
    return out;
  });

  await browser.close();

  // Parse into rows[]
  const rows = [];

  for (const blk of rawBlocks) {
    const lines = (blk.text || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    if (looksLikeJunk(lines[0])) continue;

    // -------- PRIMARY PARSE (card-style rows we like) --------
    // Expect:
    //   [0] "Estimated 02:54" / "Landed 00:30" / "Scheduled"
    //   [1] "03:05"            (scheduled time)
    //   [2] "X3383"            (flight)
    //   [3] "Antalya (AYT)"    (origin + IATA)
    //   [4] "B38M (G-TUML)"    (aircraft)
    //   [5] maybe reg/airline/etc
    // This gives us clean 'flight': "X3383", etc.
    if (
      lines.length >= 4 &&
      /^(estimated|delayed|landed|scheduled)/i.test(lines[0])
    ) {
      const statusLine = lines[0];
      const schedLine = lines[1] || "";
      const flightLine = lines[2] || "";
      const originLine = lines[3] || "";
      const aircraftLine = lines[4] || "";
      const airlineLine = lines[6] || lines[5] || "";

      const etaHHMM =
        (statusLine.match(/(\d{1,2}:\d{2})/) || [null, ""])[1] || "";
      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;

      // start/end window: ETA +15 then +30
      const startIso = etaIso ? addMin(etaIso, START_OFFSET_MIN) : null;
      const endIso = startIso ? addMin(startIso, DURATION_MIN) : null;

      rows.push({
        flight: flightLine,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "",
        belt: "",
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
        ui_age_min: 0,
      });

      continue;
    }

    // -------- FALLBACK PARSE (table-ish / legacy) --------
    // PROBLEM rows (the ones we want to IGNORE) look like:
    //   "00:20 U22916Hurghada (HRG)-easyJet -A20N (G-UZLZ) Landed 00:30"
    // i.e. first token starts with "HH:MM " and then it glues everything together.
    //
    // We *do not* want those, because:
    //   - they duplicate flights we already captured above
    //   - they force 'flight' to become the whole sentence
    //
    // So: if first line starts with /^\d{1,2}:\d{2}\s+/, skip this block entirely.
    //
    // We ONLY parse fallback if it is NOT that glued style.

    const firstLine = lines[0] || "";
    const looksLikeGlued =
      /^\d{1,2}:\d{2}\s+/.test(firstLine); // <-- key new rule

    if (looksLikeGlued) {
      // skip this block completely, don't push anything
      continue;
    }

    // Normal fallback attempt:
    const maybeFlight = lines.find((x) =>
      /[A-Za-z]{1,3}\d{2,4}/.test(x)
    );

    if (maybeFlight) {
      const schedLine =
        lines.find((x) => /^\d{1,2}:\d{2}$/.test(x)) || "";
      const originLine =
        lines.find((x) => /\([A-Za-z0-9]{2,5}\)/.test(x)) || "";
      const statusLine =
        lines.find((x) =>
          /estimated|delayed|landed|scheduled/i.test(x)
        ) || "scheduled";

      const etaHHMM =
        (statusLine.match(/(\d{1,2}:\d{2})/) || [null, ""])[1] || "";
      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;

      const startIso = etaIso ? addMin(etaIso, START_OFFSET_MIN) : null;
      const endIso = startIso ? addMin(startIso, DURATION_MIN) : null;

      rows.push({
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
        ui_age_min: 0,
      });
    }
  }

  // ---------- DE-DUPLICATION ----------
  // Key by: flight + scheduled_local + origin_iata
  // Keep whichever row is "better" (landed > estimated > scheduled)
  const pick = new Map();
  for (const r of rows) {
    if (!r.flight) continue;
    const key = `${normFlight(r.flight)}|${(r.scheduled_local || "")
      .trim()}|${(r.origin_iata || "").trim()}`;
    const prev = pick.get(key);
    pick.set(key, prev ? betterRow(prev, r) : r);
  }

  let deduped = Array.from(pick.values());

  // ---------- horizon filter & defaults ----------
  const now = new Date();
  const horizonMs = now.getTime() + HORIZON_MIN * 60000;

  deduped = deduped
    .filter((r) => r.flight && r.flight.trim() !== "")
    .filter((r) => {
      const t = r.eta
        ? new Date(r.eta).getTime()
        : r.start
        ? new Date(r.start).getTime()
        : null;
      if (!t) return true;
      return t <= horizonMs;
    })
    .map((r) => ({
      ...r,
      flow: r.flow || "INTERNATIONAL",
    }))
    .sort((a, b) => firstTimeMs(a) - firstTimeMs(b));

  // ---------- write ----------
  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: HORIZON_MIN,
    rows: deduped,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), "utf8");
  console.log(
    `[fr24_snap] wrote ${deduped.length} rows to ${OUTPUT_PATH}.`
  );
}

main().catch((err) => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});
