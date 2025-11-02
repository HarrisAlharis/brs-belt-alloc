<script>
  function msFromHHMMWithRollover(hhmm, baseDate) {
    if (!hhmm) return null;
    const [hh, mm] = hhmm.split(':').map(Number);
    let d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hh, mm, 0, 0);
    if (baseDate.getHours() >= 18 && hh <= 6) d.setDate(d.getDate() + 1);
    if (baseDate.getHours() <= 6 && hh >= 18) d.setDate(d.getDate() - 1);
    return d.getTime();
  }

  function arrivalKeyMs(r, baseDate) {
    const landedMatch = /landed\s+(\d{1,2}:\d{2})/i.exec(r?.status || "");
    if (landedMatch) return msFromHHMMWithRollover(landedMatch[1], baseDate);

    if (r?.eta) {
      const t = new Date(r.eta).getTime();
      if (!isNaN(t)) return t;
    }

    if (r?.eta_local) {
      const t = msFromHHMMWithRollover(r.eta_local, baseDate);
      if (t) return t;
    }

    if (r?.scheduled_local) {
      const t = msFromHHMMWithRollover(r.scheduled_local, baseDate);
      if (t) return t;
    }

    return Number.MAX_SAFE_INTEGER;
  }

  // Example sorting usage
  const baseDate = new Date(data.generated_at_local || data.generated_at_utc || Date.now());
  rows.sort((a, b) => arrivalKeyMs(a, baseDate) - arrivalKeyMs(b, baseDate));
</script>
