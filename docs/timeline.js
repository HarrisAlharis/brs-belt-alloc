(async function(){
  const DESIRED_BELT_ORDER = [1,2,3,5,6,7];
  const ROW_H = 76, TOP = 36, LEFT = 84, RIGHT = 24;

  const res = await fetch(`assignments.json?v=${Date.now()}`);
  const data = await res.json();
  const allRows = Array.isArray(data.rows) ? data.rows : [];
  const itemsAll = allRows.filter(r => r.belt && r.start && r.end);

  document.getElementById("meta").textContent =
    `Generated ${data.generated_at_local || data.generated_at_utc || ""} • Horizon ${data.horizon_minutes||""} min`;

  const beltChipsEl = document.getElementById("beltChips");
  const zoomEl = document.getElementById("zoom");
  const backEl = document.getElementById("back");
  const aheadEl = document.getElementById("ahead");
  const jumpNowBtn = document.getElementById("jumpNow");

  const beltsPresent = [...new Set(itemsAll.map(r => Number(r.belt)))].sort((a,b)=>DESIRED_BELT_ORDER.indexOf(a)-DESIRED_BELT_ORDER.indexOf(b));
  const belts = DESIRED_BELT_ORDER.filter(b => beltsPresent.includes(b));
  const selectedBelts = new Set(belts);

  function renderBeltChips(){
    beltChipsEl.innerHTML = "";
    belts.forEach(b=>{
      const span = document.createElement("span");
      span.className = "chip active";
      span.textContent = `Belt ${b}`;
      span.dataset.belt = String(b);
      span.onclick = ()=>{
        if (selectedBelts.has(b)) { selectedBelts.delete(b); span.classList.remove("active"); }
        else { selectedBelts.add(b); span.classList.add("active"); }
        draw();
      };
      beltChipsEl.appendChild(span);
    });
  }
  renderBeltChips();
  document.getElementById("allBelts").onclick = ()=>{ selectedBelts.clear(); belts.forEach(b=>selectedBelts.add(b)); [...beltChipsEl.children].forEach(c=>c.classList.add("active")); draw(); };
  document.getElementById("noBelts").onclick  = ()=>{ selectedBelts.clear(); [...beltChipsEl.children].forEach(c=>c.classList.remove("active")); draw(); };
  jumpNowBtn.onclick = ()=>{ draw(true); };

  const host = document.getElementById("host");
  const svg  = document.getElementById("svg");
  const NS   = "http://www.w3.org/2000/svg";
  const g = (tag, attrs={}) => { const el = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

  const tip = document.getElementById("tooltip");
  const showTip = (e, html)=>{ tip.innerHTML=html; tip.style.display="block"; positionTip(e); };
  const hideTip = ()=> tip.style.display="none";
  const positionTip = (e)=>{
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left + 12;
    const y = e.clientY - r.top + 12;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  };

  const hhmm = (iso)=>{
    if(!iso) return "";
    const d=new Date(iso); const p=n=>String(n).padStart(2,"0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const colorFor = (delay)=>{
    if (typeof delay !== "number") return "#143b1f";
    if (delay >= 20) return "#3e1316";
    if (delay >= 10) return "#3c2a10";
    if (delay < 0)   return "#102a3c";
    return "#143b1f";
  };

  function computeBounds(items, backMin, aheadMin){
    const now = new Date();
    const t0 = new Date(now.getTime() - backMin*60000);
    const lastEnd = new Date(Math.max(...items.map(r => new Date(r.end).getTime()), now.getTime()+aheadMin*60000));
    return { now, t0, t1: lastEnd };
  }

  function draw(cacheBustNow=false){
    const backMin  = Number(backEl.value || 15);
    const aheadMin = Number(aheadEl.value || 180);
    const pxPerMin = Number(zoomEl.value || 6);

    const sel = itemsAll.filter(r => selectedBelts.has(Number(r.belt)));
    const { now, t0, t1 } = computeBounds(sel.length ? sel : itemsAll, backMin, aheadMin);
    const totalMin = Math.max(1, (t1 - t0)/60000);
    const width = Math.max(LEFT + RIGHT + totalMin * pxPerMin, 900);
    const beltCount = (selectedBelts.size || DESIRED_BELT_ORDER.filter(b=>[...new Set(itemsAll.map(x=>x.belt))].includes(b)).length);
    const height = TOP + beltCount * ROW_H + 24;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const xOf = (d)=> LEFT + ((new Date(d) - t0)/60000) * pxPerMin;
    const beltsInData = [...new Set(itemsAll.map(r => Number(r.belt)))];
    const visibleBelts = (selectedBelts.size ? DESIRED_BELT_ORDER.filter(b=>selectedBelts.has(b)) : []);
    const beltList = (visibleBelts.length ? visibleBelts : DESIRED_BELT_ORDER.filter(b => beltsInData.includes(b)));

    const rowY = (belt)=> {
      const idx = beltList.indexOf(Number(belt));
      return TOP + idx * ROW_H;
    };

    svg.appendChild(g("rect",{x:0,y:0,width:width,height:height,fill:"#121a25",stroke:"#233041"}));

    beltList.forEach((b,i)=>{
      const y = TOP + i*ROW_H;
      svg.appendChild(g("rect",{x:0,y, width:width, height:ROW_H, fill: i%2? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)"}));
      svg.appendChild(g("text",{x:LEFT-10,y:y+ROW_H/2+5, fill:"#9fb1c5","text-anchor":"end","font-size":"13"}))
         .appendChild(document.createTextNode(`Belt ${b}`));
    });

    const tickEvery = 15;
    const firstTick = new Date(t0); firstTick.setMinutes(Math.ceil(t0.getMinutes()/tickEvery)*tickEvery,0,0);
    for(let t=firstTick; t<=t1; t=new Date(t.getTime()+tickEvery*60000)){
      const x = xOf(t);
      svg.appendChild(g("line",{x1:x,y1:TOP-24,x2:x,y2:height-8, stroke:"rgba(255,255,255,0.08)"}));
      const label = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
      svg.appendChild(g("text",{x, y: TOP-8, fill:"#9fb1c5","font-size":"12", "text-anchor":"middle"}))
         .appendChild(document.createTextNode(label));
    }

    const xNow = xOf(cacheBustNow ? new Date() : now);
    svg.appendChild(g("line",{x1:xNow,y1:TOP-24,x2:xNow,y2:height-8, stroke:"#5ab0ff","stroke-width":"1.5"}));

    (sel.length ? sel : itemsAll).forEach(r=>{
      if (!beltList.includes(Number(r.belt))) return;
      const y  = rowY(r.belt) + 10;
      const x0 = xOf(r.start);
      const x1 = xOf(r.end);
      const w  = Math.max(10, x1-x0);
      const h  = ROW_H - 20;

      const fill = colorFor(r.delay_min);
      const rect = g("rect",{x:x0,y:y,width:w,height:h, rx:10, ry:10, fill, stroke:"rgba(255,255,255,0.18)"});
      svg.appendChild(rect);

      const label = `${(r.flight||"").toUpperCase()} • ${(r.origin_iata||"").toUpperCase()}`;
      const text = g("text",{x:x0+8,y:y+22, fill:"#e7edf5","font-size":"12","font-weight":"700"});
      text.appendChild(document.createTextNode(label));
      svg.appendChild(text);

      const sched = r.scheduled_local || "";
      const eta   = r.eta_local || hhmm(r.eta);
      const delay = (typeof r.delay_min==="number") ? (r.delay_min>0?`+${r.delay_min} min`:`${r.delay_min} min`) : "—";
      const html = `
        <div class="title">${(r.flight||"").toUpperCase()} • ${(r.origin||"")}</div>
        <div class="muted">Scheduled → ETA: <b>${sched||"—"}</b> → <b>${eta||"—"}</b> (${delay})</div>
        <div>Flow: <b>${(r.flow||"").toUpperCase()}</b> &nbsp; Belt: <b>${r.belt||"?"}</b></div>
        <div>Start–End: <b>${hhmm(r.start)}</b>–<b>${hhmm(r.end)}</b></div>
        <div class="muted">Reason: ${r.reason||"—"}</div>
      `;
      const hit = g("rect",{x:x0,y:y,width:w,height:h, fill:"transparent"});
      hit.addEventListener("mousemove", (e)=>{ showTip(e, html); });
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    });

    const vline = g("line",{x1:0,y1:TOP-24,x2:0,y2:height-8, stroke:"rgba(255,255,255,0.22)", "stroke-dasharray":"3,3", visibility:"hidden"});
    const ts = g("text",{x:0,y:TOP-28, fill:"#9fb1c5","font-size":"12","text-anchor":"middle"});
    svg.appendChild(vline); svg.appendChild(ts);

    host.onmousemove = (e)=>{
      const r = host.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - r.left, LEFT), width-RIGHT);
      vline.setAttribute("x1", x); vline.setAttribute("x2", x);
      vline.setAttribute("visibility","visible");
      const minutesFromStart = (x - LEFT) / pxPerMin;
      const t = new Date(t0.getTime() + minutesFromStart*60000);
      const label = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
      ts.setAttribute("x", x); ts.textContent = label;
    };
    host.onmouseleave = ()=>{ vline.setAttribute("visibility","hidden"); ts.textContent=""; };
  }

  draw();
  zoomEl.onchange = draw;
  backEl.onchange = draw;
  aheadEl.onchange = draw;
})();
