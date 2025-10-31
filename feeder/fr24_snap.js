// feeder/fr24_snap.js
// scrape FR24 BRS arrivals → normalised JSON for the web page

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

const DEFAULT_BELT_MIN = 30;
const HORIZON_MIN = 180; // 3 hours

function todayIsoFromHHMM(hhmm) {
  if (!hhmm) return null;
  const now = new Date();
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  return d.toISOString();
}

function extractIataFromOrigin(origin) {
  if (!origin) return "";
  const m = origin.match(/\(([A-Za-z0-9]{2,5})\)/);
  return m ? m[1].toUpperCase() : "";
}

function looksLikeJunk(title) {
  if (!title) return false;
  const s = title.trim().toLowerCase();
  if (["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].some(d => s.startsWith(d)))
    return true;
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

function calcDelayMin(schedHHMM, etaHHMM) {
  if (!schedHHMM || !etaHHMM) return null;
  const now = new Date();
  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0, 0);
  const e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0, 0);
  return Math.round((e - s) / 60000);
}

function makeEndIso(startIso, minutes = DEFAULT_BELT_MIN) {
  if (!startIso) return null;
  const s = new Date(startIso);
  return new Date(s.getTime() + minutes * 60000).toISOString();
}

async function main() {
  console.log("[fr24_snap] start…");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 60000 }).catch(() => {});

  const rawBlocks = await page.evaluate(() => {
    const out = [];

    // table-ish
    document.querySelectorAll("table tbody tr, .table tbody tr").forEach(tr => {
      const txt = tr.innerText || tr.textContent || "";
      if (txt.trim()) out.push({ kind: "table", text: txt });
    });

    // card-ish
    document.querySelectorAll('[role="row"], .row, .list-item, .data-row').forEach(el => {
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

  const rows = [];

  for (const blk of rawBlocks) {
    const lines = blk.text.split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) continue;

    const first = lines[0];
    if (looksLikeJunk(first)) continue;

    if (lines.length >= 4 && /^(estimated|delayed|landed|scheduled)/i.test(lines[0])) {
      const statusLine = lines[0];
      const schedLine = lines[1] || "";
      const flightLine = lines[2] || "";
      const originLine = lines[3] || "";
      const aircraftLine = lines[4] || "";
      const airlineLine = lines[6] || lines[5] || "";

      let etaHHMM = "";
      const mEta = statusLine.match(/(\d{1,2}:\d{2})/);
      if (mEta) etaHHMM = mEta[1];

      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      const endIso = makeEndIso(startIso);

      rows.push({
        flight: flightLine,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "",           // set later or by feeder
        belt: "",           // set later by feeder
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

    // fallback
    const maybeFlight = lines.find(x => /[A-Za-z]{1,3}\d{2,4}/.test(x));
    if (maybeFlight) {
      const schedLine = lines.find(x => /^\d{1,2}:\d{2}$/.test(x)) || "";
      const originLine = lines.find(x => /\([A-Za-z0-9]{2,5}\)/.test(x)) || "";
      const statusLine = lines.find(x => /estimated|delayed|landed|scheduled/i.test(x)) || "scheduled";

      const etaHHMM = (statusLine.match(/(\d{1,2}:\d{2})/) || [null, ""])[1] || "";
      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      const endIso = makeEndIso(startIso);

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
        ui_age_min: 0
      });
    }
  }

  // 3-hour cap + small cleanup
  const now = new Date();
  const horizonMs = now.getTime() + HORIZON_MIN * 60000;

  const filtered = rows
    .filter(r => r.flight && r.flight.trim() !== "")      // drop totally blank rows
    .filter(r => {
      const t = r.eta ? new Date(r.eta).getTime()
             : r.start ? new Date(r.start).getTime()
             : null;
      if (!t) return true; // keep if we couldn't time it
      return t <= horizonMs;
    })
    .map(r => ({
      ...r,
      flow: r.flow || "INTERNATIONAL"
    }));

  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: HORIZON_MIN,
    rows: filtered
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), "utf8");
  console.log(`[fr24_snap] wrote ${filtered.length} rows to ${OUTPUT_PATH}.`);
}

main().catch(err => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});
