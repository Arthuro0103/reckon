'use strict';

// ---------------------------------------------------------------------------
// Leak detection for `reckon watch`. PURE: a series goes in, a verdict comes out.
// No clock is read here. Time is the `t` each point carries, so a test can feed a
// three-hour story in microseconds, and the window is a constant, not a wait.
//
// What "a leak" means here, and what it does not: a process family whose resident
// memory has climbed steadily, hour after hour, and never come back down. It does
// NOT mean "this app is big" and it does NOT mean "this app is misbehaving": a
// build tool that is indexing a large project climbs the same way. So the verdict
// is a measurement with its proof, and the alert built from it invents no command.
// ---------------------------------------------------------------------------

const LEAK = Object.freeze({
  pointEveryMs: 4 * 60_000,   // one point per family every 4 min: 60 points cover 4 h, so a 3 h window fits
  maxPoints: 60,              // the bound, in memory and in each family's series
  windowHours: 3,             // the window is cut into this many equal "hours"...
  slopeMBPerHour: 50,         // ...and EACH of them must climb faster than this
  minPointsPerHour: 4,        // fewer points than this in a slice and the slice is not evidence
  minR2: 0.6,                 // how straight the whole climb must be; noise around a flat line scores near 0
  minMB: 200,                 // a family under this is too small to matter
  maxFamilies: 12,            // series are kept only for the biggest families
});

// Ordinary least squares over (hours, MB). Returns null for fewer than 2 distinct times.
function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / 3_600_000);
  const ys = points.map((p) => p.mb);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

// The verdict for ONE family's series ([{t, mb}], oldest first), or null.
// True only when the last `windowHours` hours of readings, cut into equal slices,
// each climb faster than `slopeMBPerHour` AND the whole climb is a straight line.
function verdict(series, tuning = LEAK) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  const spanMs = tuning.windowHours * 3_600_000;
  const pts = series.filter((p) => last.t - p.t <= spanMs);
  if (pts.length < tuning.windowHours * tuning.minPointsPerHour) return null;
  // The window must really be covered: a family seen for 40 minutes has no three hours.
  if (last.t - pts[0].t < spanMs * 0.9) return null;
  if (last.mb < tuning.minMB) return null;
  const whole = fit(pts);
  if (!whole || whole.slope < tuning.slopeMBPerHour || whole.r2 < tuning.minR2) return null;
  const sliceMs = spanMs / tuning.windowHours;
  const start = last.t - spanMs;
  const slopes = [];
  for (let h = 0; h < tuning.windowHours; h++) {
    const lo = start + h * sliceMs;
    const hi = lo + sliceMs;
    const part = pts.filter((p) => p.t >= lo && (h === tuning.windowHours - 1 ? p.t <= hi : p.t < hi));
    if (part.length < tuning.minPointsPerHour) return null;
    const f = fit(part);
    if (!f || f.slope < tuning.slopeMBPerHour) return null;
    slopes.push(f.slope);
  }
  return {
    firstMB: pts[0].mb, lastMB: last.mb, slopeMBPerHour: whole.slope, r2: whole.r2,
    hours: (last.t - pts[0].t) / 3_600_000, points: pts.length, sliceSlopes: slopes,
  };
}

const emptySeries = () => ({ map: new Map(), lastT: null });

// Adds a sample ({family: mb}) at time t to the in-memory series, bounded. Returns
// true when it was kept (the spacing rule can refuse it). Families that are not among
// the biggest `maxFamilies` lose their series: a bounded watcher cannot remember all.
function push(series, sample, t, tuning = LEAK) {
  if (series.lastT != null && t - series.lastT < tuning.pointEveryMs) return false;
  series.lastT = t;
  const keep = Object.entries(sample).filter(([, mb]) => mb >= tuning.minMB * 0.5)
    .sort((a, b) => b[1] - a[1]).slice(0, tuning.maxFamilies).map(([k]) => k);
  for (const k of keep) {
    const s = series.map.get(k) || [];
    s.push({ t, mb: sample[k] });
    while (s.length > tuning.maxPoints) s.shift();
    series.map.set(k, s);
  }
  for (const k of [...series.map.keys()]) if (!keep.includes(k)) series.map.delete(k);
  return true;
}

// Every family currently leaking, worst slope first.
function leaks(series, tuning = LEAK) {
  const out = [];
  for (const [family, s] of series.map) {
    const v = verdict(s, tuning);
    if (v) out.push({ family, ...v });
  }
  return out.sort((a, b) => b.slopeMBPerHour - a.slopeMBPerHour);
}

// Rebuilds the series from the lines the watcher appended, so a restart does not forget.
function seed(series, lines, tuning = LEAK) {
  for (const l of lines) {
    if (!l || !Number.isFinite(l.t) || !l.fam || typeof l.fam !== 'object') continue;
    const sample = {};
    for (const [k, v] of Object.entries(l.fam)) if (v && Number.isFinite(v.mb)) sample[k] = v.mb;
    push(series, sample, l.t, tuning);
  }
  return series;
}

module.exports = { LEAK, fit, verdict, push, leaks, emptySeries, seed };
