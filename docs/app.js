(function () {
  const meta  = document.querySelector('#meta');
  const tbody = document.querySelector('#tbody');

  function showError(msg) {
    console.error(msg);
    tbody.innerHTML = `<tr><td colspan="9" class="empty error">${msg}</td></tr>`;
    meta.textContent = 'Load failed';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function hhmm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function beltBadge(b) {
    const v = (b === undefined || b === '' || b === null) ? '?' : b;
    return `<span class="pill pill-belt">${v}</span>`;
  }

  function flowBadge(flow) {
    return `<span class="pill pill-flow">${(flow || '').toUpperCase()}</span>`;
  }

  function timeCell(r) {
    const etaLocal  = r.eta_local || hhmm(r.eta);
    const schedLocal = r.scheduled_local || '';
    if (schedLocal) {
      return `<div class="time">
        <span class="time-sched">${escapeHtml(schedLocal)}</span>
        <span class="time-arrow">→</span>
        <span class="time-eta">${escapeHtml(etaLocal || '')}</span>
      </div>`;
    }
    return `<div class="time"><span class="time-eta">${escapeHtml(etaLocal || '')}</span></div>`;
  }

  function statusPill(r) {
    const text = r && r.status ? r.status : (r && r.eta_local ? `Estimated ${r.eta_local}` : '—');
    const d = (typeof r.delay_min === 'number') ? r.delay_min : null;
    let cls = 'pill-green';
    if (d !== null) {
      if (d < 0) cls = 'pill-blue';
      else if (d >= 20) cls = 'pill-red';
      else if (d >= 10) cls = 'pill-orange';
      else cls = 'pill-green';
    } else {
      const s = String(text).toLowerCase();
      if (s.includes('early')) cls = 'pill-blue';
      else if (s.includes('delayed')) cls = 'pill-orange';
      else if (s.includes('cancel')) cls = 'pill-red';
    }
    return `<span class="pill ${cls}">${escapeHtml(text)}</span>`;
  }

  function renderRow(r) {
    return `
      <tr>
        <td class="col-flight">${escapeHtml(r.flight || '')}</td>
        <td class="col-origin">
          <span class="origin-code">${escapeHtml((r.origin_iata || '').toUpperCase())}</span>
          <span class="origin-name">${escapeHtml(r.origin || '')}</span>
        </td>
        <td class="col-time">${timeCell(r)}</td>
        <td class="col-status">${statusPill(r)}</td>
        <td class="col-flow">${flowBadge(r.flow || '')}</td>
        <td class="col-belt">${beltBadge(r.belt)}</td>
        <td class="col-start">${hhmm(r.start)}</td>
        <td class="col-end">${hhmm(r.end)}</td>
        <td class="col-reason">${escapeHtml(r.reason || '')}</td>
      </tr>
    `;
  }

  async function load() {
    // current page base, e.g. https://harrisalharis.github.io/brs-belt-alloc/
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');

    // we try local first, then raw GitHub (which always works for public repos)
    const urls = [
      base + 'assignments.json?ts=' + Date.now(),
      base + 'docs/assignments.json?ts=' + Date.now(),
      'https://raw.githubusercontent.com/HarrisAlharis/brs-belt-alloc/main/docs/assignments.json?ts=' + Date.now()
    ];

    let data = null;
    let lastErr = '';

    for (const url of urls) {
      try {
        console.log('[app] trying', url);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        console.log('[app] loaded', url);
        break;
      } catch (err) {
        console.warn('[app] failed', url, err);
        lastErr = err.message;
      }
    }

    if (!data) {
      showError('Could not load assignments.json (' + lastErr + ')');
      return;
    }

    const rows = Array.isArray(data.rows) ? data.rows : [];
    meta.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">No arrivals found for the next 3 hours.</td></tr>`;
      return;
    }

    // sort by first available time
    rows.sort((a, b) => {
      const ta = a.start ? new Date(a.start).getTime()
               : a.eta ? new Date(a.eta).getTime()
               : Number.MAX_SAFE_INTEGER;
      const tb = b.start ? new Date(b.start).getTime()
               : b.eta ? new Date(b.eta).getTime()
               : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    tbody.innerHTML = rows.map(renderRow).join('');
  }

  window.addEventListener('DOMContentLoaded', load);
})();
