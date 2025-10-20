:root{
  --bg: #0d151d;
  --panel: #111b26;
  --grid: #1b2a39;
  --grid-faint: #14212f;
  --text: #dce6f2;
  --text-dim: #93a4b7;
  --accent: #48a3ff;

  --puck-radius: 14px;
  --puck-pad-x: 14px;
  --puck-pad-y: 10px;

  /* vertical packing */
  --lane-height: 58px;       /* puck height incl. padding */
  --lane-gap: 10px;          /* vertical gap between lanes */

  /* keep this variable for JS sizing, but we’ll make top padding smaller below */
  --belt-pad-y: 18px;        /* used by JS for min-height calc */
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
}

/* Top bar */
.header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: linear-gradient(180deg, #0d151d, #0d151d 60%, transparent);
  position: sticky; top: 0; z-index: 50;
}
.badge { background: #162332; color: var(--text); border: 1px solid #22374d;
  border-radius: 999px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
.badge.is-on { background: #1c2a3c; border-color: #2b4b6a; }
.select { background: #162332; color: var(--text); border: 1px solid #22374d; border-radius: 10px; padding: 8px 12px; }

/* Timeline scroller */
.scroller {
  position: relative;
  overflow: auto;
  height: calc(100vh - 64px);
  border-top: 1px solid #122030;
}

/* Ruler (top) */
.ruler {
  position: sticky; top: 0; left: 0; right: 0; z-index: 40;
  height: 42px; background: var(--panel);
  border-bottom: 1px solid #1a2a3a;
  display: flex; align-items: flex-end;
}
.ruler-inner { position: relative; height: 100%; width: 100%; }
.rtick {
  position: absolute; bottom: 0; transform: translateX(-50%);
  height: 100%; width: 1px; background: #213043;
}
.rtick > .lab {
  position: absolute; bottom: 4px; left: 4px; transform: translateX(-50%);
  font-size: 14px; color: var(--text); background: #122335; padding: 2px 6px; border-radius: 6px;
}

/* Grid and belts */
.grid {
  position: relative;
  width: max-content;   /* expands to content width */
  min-width: 100%;
  background: linear-gradient(180deg, var(--bg), var(--bg));
}

/* ▼▼ THE ONLY VISUAL TWEAK: smaller top padding so pucks sit on the top line */
.belt-row {
  position: relative;
  border-bottom: 1px dashed var(--grid-faint);
  /* keep JS min-height math (it uses --belt-pad-y), but visually we pad less on top */
  min-height: calc(var(--belt-pad-y)*2 + var(--lane-height)); /* at least 1 lane */
  padding: 4px 8px var(--belt-pad-y) 8px;  /* top=4px, bottom=var(--belt-pad-y) */
}
/* ▲▲ end tweak */

.belt-name {
  position: sticky; left: 0; z-index: 20;
  width: 90px; padding-left: 12px; margin-right: 6px;
  color: var(--text-dim); font-weight: 600;
  pointer-events: none;
}
.row-inner {
  position: relative;
  margin-left: 110px;  /* leaves room for sticky belt name */
}

/* time grid verticals */
.gridline {
  position: absolute; top: 0; bottom: 0; width: 1px; background: var(--grid);
  transform: translateX(-.5px);
}

/* Now line */
.nowline {
  position: absolute; top: 0; bottom: 0; width: 2px;
  background: rgba(72,163,255,.85);
  box-shadow: 0 0 12px rgba(72,163,255,.6), 0 0 2px rgba(72,163,255,.9);
}

/* Pucks */
.puck {
  position: absolute;
  height: var(--lane-height);
  min-width: 120px;
  border-radius: var(--puck-radius);
  padding: var(--puck-pad-y) var(--puck-pad-x);
  display: flex; align-items: center; gap: 10px;
  box-shadow: 0 12px 24px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.06);
  color: #f2f5f9;
  cursor: default;
  overflow: hidden;
}
.puck .title { font-weight: 700; letter-spacing: .3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.puck .sub   { font-size: 12px; color: var(--text-dim); margin-left: auto; white-space: nowrap; }

/* Colors by delay class */
.puck.ok    { background: #103a2a; }
.puck.mid   { background: #254118; }
.puck.late  { background: #4a1818; }
.puck.early { background: #12344a; }

/* Completed (past) */
.puck.past {
  background: #2a2f38;
  color: #b8c0cc;
  border-color: rgba(255,255,255,.04);
  box-shadow: none;
  opacity: .85;
}

/* Tooltip */
.puck[data-tip]:hover:after{
  content: attr(data-tip);
  position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%);
  white-space: pre; font-size: 13px; line-height: 1.35;
  background: #0f2234; color: var(--text);
  border: 1px solid #23425f; border-radius: 8px; padding: 10px 12px; z-index: 30;
  max-width: 420px;
  box-shadow: 0 10px 20px rgba(0,0,0,.4);
}

/* Focus ring for keyboard nav (if ever added) */
.puck:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
