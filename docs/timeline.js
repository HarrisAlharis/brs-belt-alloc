(async function () {
  const svg = d3.select("#chart");
  const tooltip = d3.select("#tooltip");
  const BELTS = [1, 2, 3, 5, 6, 7];

  // ---------- fetch ----------
  const res = await fetch(`assignments.json?v=${Date.now()}`);
  const data = await res.json();
  const rows = (data.history && Array.isArray(data.history) ? data.history : data.rows) || [];

  // normalize & sort
  const parsed = rows
    .filter(r => r.start && r.end && r.belt)
    .map(r => ({
      ...r,
      startD: new Date(r.start),
      endD: new Date(r.end),
      etaD: r.eta ? new Date(r.eta) : null
    }))
    .sort((a, b) => a.startD - b.startD);

  d3.select("#meta").text(
    `Generated ${data.generated_at_local || data.generated_at_utc || ""} • ${parsed.length} allocations`
  );

  // ---------- UI: belt filter chips ----------
  const chipWrap = d3.select("#belt-filter");
  const chipData = [{ label: "All", id: "all" }, ...BELTS.map(b => ({ label: `Belt ${b}`, id: `b${b}` }))];
  let activeBelts = new Set(BELTS);

  chipWrap.selectAll(".chip").data(chipData).join("div")
    .attr("class", d => "chip" + (d.id === "all" ? " active" : ""))
    .text(d => d.label)
    .on("click", (ev, d) => {
      chipWrap.selectAll(".chip").classed("active", false);
      if (d.id === "all") {
        activeBelts = new Set(BELTS);
        chipWrap.selectAll(".chip").filter(c => c.id === "all").classed("active", true);
      } else {
        const beltNum = +d.label.replace(/\D/g, "");
        const toggledOn = !activeBelts.has(beltNum);
        if (toggledOn) activeBelts.add(beltNum); else activeBelts.delete(beltNum);
        chipWrap.selectAll(".chip").filter(c => c.id === d.id).classed("active", toggledOn);
      }
      render();
    });

  // ---------- sizing ----------
  const margin = { top: 30, right: 30, bottom: 30, left: 90 };
  function size() {
    const { width, height } = svg.node().getBoundingClientRect();
    return { width, height, innerW: width - margin.left - margin.right, innerH: height - margin.top - margin.bottom };
  }

  // ---------- scales & state ----------
  const y = d3.scaleBand().domain(BELTS).paddingInner(0.18).paddingOuter(0.25);
  let minutesPerPixel = +document.getElementById("zoomPreset").value; // px per minute
  let x;              // time scale
  let xDomain;        // current time window
  const nowBtn = document.getElementById("now");
  const backSel = document.getElementById("back");
  const aheadSel = document.getElementById("ahead");
  const zoomPresetSel = document.getElementById("zoomPreset");

  function setWindowToNow() {
    const now = new Date();
    const backMin = +backSel.value;
    const aheadMin = +aheadSel.value;
    xDomain = [d3.timeMinute.offset(now, -backMin), d3.timeMinute.offset(now, +aheadMin)];
  }
  setWindowToNow();

  zoomPresetSel.onchange = () => { minutesPerPixel = +zoomPresetSel.value; render(true); };
  backSel.onchange = () => { setWindowToNow(); render(true); };
  aheadSel.onchange = () => { setWindowToNow(); render(true); };
  nowBtn.onclick = () => { setWindowToNow(); render(true); };

  // ---------- layers ----------
  const root = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const gridG = root.append("g");
  const axisG = root.append("g").attr("class", "axis");
  const rowBandG = root.append("g");
  const puckG = root.append("g");
  const nowG = root.append("g");

  // ---------- zoom/pan (re-layout, not bitmap scale) ----------
  const zoom = d3.zoom()
    .filter(ev => !ev.ctrlKey)
    .on("zoom", (ev) => {
      const msPerPx = 60000 / minutesPerPixel;
      const { innerW } = size();
      const visibleMs = innerW * msPerPx;
      const span = xDomain[1] - xDomain[0];

      // pan
      const dxMs = -ev.transform.x * msPerPx;
      const base0 = +xDomain[0] + dxMs;

      // zoom (Shift+wheel)
      const k = (ev.sourceEvent && ev.sourceEvent.shiftKey) ? ev.transform.k : 1;

      const center = new Date((base0 + visibleMs / 2));
      const newSpan = span / k;
      xDomain = [new Date(center - newSpan / 2), new Date(center + newSpan / 2)];

      svg.call(zoom.transform, d3.zoomIdentity);
      render();
    });

  svg.call(zoom);

  // ---------- helpers ----------
  const fmt = d3.timeFormat("%H:%M");
  function puckColor(r) {
    const d = typeof r.delay_min === "number" ? r.delay_min : null;
    if (d == null) return "green";
    if (d >= 20) return "red";
    if (d >= 10) return "amber";
    if (d <= -1) return "blue";
    return "green";
  }
  function withinWindow(r) {
    return r.endD >= xDomain[0] && r.startD <= xDomain[1];
  }
  function clampLabel(r, pixelWidth) {
    const primary = `${(r.flight || "").trim()} • ${(r.origin_iata || "").toUpperCase()}`;
    if (pixelWidth >= 140) return primary;
    if (pixelWidth >= 95) return (r.flight || "").trim();
    return "";
  }

  // ---------- render ----------
  function render(recalcScale = false) {
    const { innerW, innerH } = size();

    y.range([0, innerH]);
    if (recalcScale || !x) x = d3.scaleTime().range([0, innerW]).domain(xDomain);
    else x.range([0, innerW]).domain(xDomain);

    // bands
    rowBandG.selectAll("rect.rowBand").data(BELTS, d => d).join(
      enter => enter.append("rect")
        .attr("class", "rowBand")
        .attr("x", 0).attr("height", y.bandwidth())
        .attr("width", innerW)
        .attr("y", d => y(d)),
      update => update
        .attr("width", innerW)
        .attr("y", d => y(d))
    );

    // axis + grid
    const axis = d3.axisTop(x).ticks(innerW < 900 ? d3.timeMinute.every(15) : d3.timeMinute.every(10)).tickFormat(fmt);
    axisG.attr("transform", "translate(0,-6)").call(axis);

    const ticks = x.ticks(d3.timeMinute.every(5));
    gridG.selectAll("line.gridline").data(ticks, d => d).join(
      enter => enter.append("line").attr("class", "gridline")
        .attr("y1", 0).attr("y2", innerH)
        .attr("x1", d => x(d)).attr("x2", d => x(d)),
      update => update
        .attr("y2", innerH)
        .attr("x1", d => x(d)).attr("x2", d => x(d))
    );

    // belt labels
    const rootSel = root.selectAll("text.yLbl").data(BELTS, d => d);
    rootSel.join(
      enter => enter.append("text").attr("class", "yLbl")
        .attr("x", -12).attr("text-anchor", "end").attr("fill", "#cbd5e1")
        .attr("y", d => y(d) + y.bandwidth() / 2 + 4)
        .text(d => `Belt ${d}`),
      update => update.attr("y", d => y(d) + y.bandwidth() / 2 + 4)
    );

    // data -> visible + filter
    const visible = parsed.filter(withinWindow).filter(r => activeBelts.has(+r.belt));

    // pucks
    const nodes = puckG.selectAll("g.p").data(visible, d => `${d.flight}|${d.start}|${d.belt}`);
    const nodesEnter = nodes.enter().append("g").attr("class", "p");
    nodesEnter.append("rect").attr("class", "puck");
    nodesEnter.append("text").attr("class", "puckLabel");
    nodesEnter.append("text").attr("class", "puckSub");

    nodes.merge(nodesEnter).each(function (d) {
      const g = d3.select(this);

      const x0 = x(d.startD);
      const x1 = x(d.endD);
      const w = Math.max(28, x1 - x0);
      const y0 = y(+d.belt) + 4;
      const h = Math.max(28, y.bandwidth() - 8);

      const endedAgoMin = (Date.now() - d.endD.getTime()) / 60000;
      const dim = endedAgoMin > 60;

      g.select("rect.puck")
        .attr("x", x0).attr("y", y0).attr("width", w).attr("height", h)
        .attr("class", `puck ${puckColor(d)} ${dim ? "dim" : ""}`);

      const lbl = clampLabel(d, w - 16);
      g.select("text.puckLabel")
        .attr("x", x0 + 12).attr("y", y0 + 18)
        .text(lbl);

      const sub = (d.scheduled_local && d.eta_local)
        ? `${d.scheduled_local} → ${d.eta_local} • ${d.flow}`
        : `${d.flow || ""}`;
      g.select("text.puckSub")
        .attr("x", x0 + 12).attr("y", y0 + h - 10)
        .text(sub);

      g.on("mouseenter", (ev) => {
        const html = `
          <b>${d.flight || "—"} • ${(d.origin_iata || "").toUpperCase()} ${d.origin || ""}</b><br/>
          Time: ${d.scheduled_local || "?"} → <b>${d.eta_local || "?"}</b>
          ${typeof d.delay_min === "number" ? ` (${d.delay_min>=0?"+":""}${d.delay_min} min)` : ""}<br/>
          Flow: ${d.flow || "—"} • Belt: <b>${d.belt}</b><br/>
          Start–End: ${fmt(d.startD)} – ${fmt(d.endD)}<br/>
          Reason: ${d.reason || "—"}
        `;
        tooltip.html(html).style("display","block");
      }).on("mousemove", (ev) => {
        tooltip.style("left", (ev.clientX + 14) + "px").style("top", (ev.clientY + 14) + "px");
      }).on("mouseleave", () => {
        tooltip.style("display","none");
      });
    });

    nodes.exit().remove();

    // NOW line
    const now = new Date();
    const nx = x(now);
    nowG.selectAll("*").remove();
    if (nx >= 0 && nx <= innerW) {
      nowG.append("line").attr("class", "nowLine").attr("x1", nx).attr("x2", nx).attr("y1", 0).attr("y2", innerH);
      nowG.append("line").attr("class", "nowTick").attr("x1", nx - 8).attr("x2", nx + 8).attr("y1", 18).attr("y2", 18);
    }
  }

  render(true);
  window.addEventListener("resize", () => render(true));
})();
