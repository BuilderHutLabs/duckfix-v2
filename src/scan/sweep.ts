/**
 * "Paragon": a long receipt filmed while the phone moves down it. These are the sums on small grey
 * frames: where the receipt's edges are, how far it moved since the last frame, and how the sharp
 * frames kept on the way are laid out into one receipt.
 */

/**
 * Left and right edge of the receipt (columns, px) in the top and in the bottom band of a frame, and
 * the rows the paper takes (y0..y1): the whole frame, or less when its top or its end is in view.
 */
export type Strip = { topL: number; topR: number; botL: number; botR: number; y0: number; y1: number };

/** Columns the receipt is brought to: a row of the strip, the unit of every position, is 1/STRIP_W of its width. */
export const STRIP_W = 128;

/** The two bands the edges are measured in (fractions of the frame height), and their middle rows. */
const BAND = 0.25;
const TOP_Y = BAND / 2;
const BOT_Y = 1 - BAND / 2;
/** Paper must be at least this much lighter than the table. */
const MIN_CONTRAST = 40;

/** Otsu's threshold of a list of grey values: the split that best tells the two groups apart. */
function otsu(values: Float32Array): number {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t + 0.5;
    }
  }
  return thr;
}

/** The paper's columns in rows y0..y1: the longest run of light columns, or null. */
function edgesIn(gray: Uint8ClampedArray, w: number, y0: number, y1: number): { l: number; r: number; thr: number } | null {
  // per column, a light value of the band (its top tenth): paper is light between the lines of print
  // even where the print is dense and its strokes line up; the table is dark everywhere
  const col = new Float32Array(w);
  const n = y1 - y0;
  const vals = new Uint8Array(n);
  const at = Math.min(n - 1, Math.floor(n * 0.9));
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < n; y++) vals[y] = gray[(y0 + y) * w + x];
    vals.sort();
    col[x] = vals[at];
  }
  const thr = otsu(col);
  let light = 0;
  let nl = 0;
  let dark = 0;
  let nd = 0;
  for (const v of col) {
    if (v > thr) {
      light += v;
      nl++;
    } else {
      dark += v;
      nd++;
    }
  }
  if (!nl || !nd || light / nl - dark / nd < MIN_CONTRAST) return null;
  // what tells paper from table row by row: nearer the table's grey (shaded paper and dense print stay paper)
  const rowThr = dark / nd + (light / nl - dark / nd) * 0.4;
  // the longest light run; a narrow dark gap inside it is print, not table
  const maxGap = Math.max(3, Math.round(w * 0.04));
  let bestL = 0;
  let bestLen = 0;
  let x = 0;
  while (x < w) {
    if (col[x] <= thr) {
      x++;
      continue;
    }
    const start = x;
    let end = x;
    while (x < w) {
      if (col[x] > thr) {
        end = ++x;
        continue;
      }
      let g = x;
      while (g < w && col[g] <= thr) g++;
      if (g < w && g - x <= maxGap) x = g;
      else break;
    }
    if (end - start > bestLen) {
      bestLen = end - start;
      bestL = start;
    }
    x = Math.max(x, end + 1);
  }
  if (bestLen < w * 0.25 || bestLen > w * 0.95) return null;
  // the edges between pixels: where the light value crosses the threshold
  const end = bestL + bestLen;
  let l = bestL;
  let r = end;
  if (bestL > 0 && col[bestL] > col[bestL - 1]) l = bestL - 0.5 + (thr - col[bestL - 1]) / (col[bestL] - col[bestL - 1]);
  if (end < w && col[end - 1] > col[end]) r = end - 0.5 + (col[end - 1] - thr) / (col[end - 1] - col[end]);
  return { l, r, thr: rowThr };
}

/** Is row y paper between columns l..r? (A good part of it light: print never covers most of a row.) */
function paperRow(gray: Uint8ClampedArray, w: number, y: number, l: number, r: number, thr: number): boolean {
  const a = Math.round(l + (r - l) * 0.1);
  const b = Math.round(r - (r - l) * 0.1);
  let light = 0;
  for (let x = a; x < b; x++) if (gray[y * w + x] > thr) light++;
  return light >= (b - a) * 0.2;
}

/** The receipt's edges in a grey frame (w × h), or null when no receipt on a darker table is seen. */
export function findStrip(gray: Uint8ClampedArray, w: number, h: number): Strip | null {
  const band = Math.max(1, Math.round(h * BAND));
  const top = edgesIn(gray, w, 0, band);
  const bot = edgesIn(gray, w, h - band, h);
  if (!top && !bot) return null;
  const edges =
    top && bot
      ? { topL: top.l, topR: top.r, botL: bot.l, botR: bot.r }
      : { topL: (top ?? bot)!.l, topR: (top ?? bot)!.r, botL: (top ?? bot)!.l, botR: (top ?? bot)!.r };
  const thr = top && bot ? (top.thr + bot.thr) / 2 : (top ?? bot)!.thr;
  const lAt = (y: number) => edges.topL + ((edges.botL - edges.topL) * ((y + 0.5) / h - TOP_Y)) / (BOT_Y - TOP_Y);
  const rAt = (y: number) => edges.topR + ((edges.botR - edges.topR) * ((y + 0.5) / h - TOP_Y)) / (BOT_Y - TOP_Y);
  const isPaper = (y: number) => paperRow(gray, w, y, lAt(y), rAt(y), thr);
  // the rows the paper takes, from a row that is surely paper up and down to where the table starts
  // (the receipt's top or its end may be in view)
  const from = top && bot ? Math.floor(h / 2) : top ? Math.floor(band / 2) : Math.floor(h - band / 2);
  const gap = 3; // rows of table in a row end the paper
  let y0 = 0;
  let y1 = h;
  // beyond the paper's top or end there is table: most rows there are not paper (else it was print)
  const mostlyTable = (a: number, b: number) => {
    let t = 0;
    for (let y = a; y < b; y++) if (!isPaper(y)) t++;
    return t >= (b - a) * 0.7;
  };
  for (let y = from, miss = 0; y >= 0; y--) {
    miss = isPaper(y) ? 0 : miss + 1;
    if (miss >= gap) {
      if (mostlyTable(0, y + gap)) y0 = y + gap;
      break;
    }
  }
  for (let y = from, miss = 0; y < h; y++) {
    miss = isPaper(y) ? 0 : miss + 1;
    if (miss >= gap) {
      if (mostlyTable(y - gap + 1, h)) y1 = y - gap + 1;
      break;
    }
  }
  if (y1 - y0 < h * 0.3) return null;
  return { ...edges, y0, y1 };
}

/**
 * The receipt cut out of the frame, turned upright (its lean taken away, as cutKey does with the
 * full picture) and brought to `outW` columns; rows are scaled by the same factor, so a "row of the
 * strip" is the same share of the receipt's width whatever the phone's distance.
 */
export function unwarpStrip(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  s: Strip,
  outW = STRIP_W,
): { data: Uint8ClampedArray; w: number; h: number } {
  const tilt = stripTilt(s, h);
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const yc = h / 2;
  const at = (top: number, bot: number, y: number) => top + ((bot - top) * (y / h - TOP_Y)) / (BOT_Y - TOP_Y);
  const cx = (at(s.topL, s.botL, yc) + at(s.topR, s.botR, yc)) / 2;
  // across the paper (perpendicular to its edges) it is narrower than across the frame
  const paperW = (at(s.topR, s.botR, yc) - at(s.topL, s.botL, yc)) * cos || 1;
  const k = outW / paperW;
  const outH = Math.max(1, Math.round(((s.y1 - s.y0) / cos) * k));
  const data = new Uint8ClampedArray(outW * outH);
  // down the receipt: (-sin, cos); across it: (cos, sin); the strip's top is where the middle line meets row y0
  const t0 = (s.y0 - yc) / cos;
  for (let j = 0; j < outH; j++) {
    const t = t0 + (j + 0.5) / k;
    const mx = cx - t * sin;
    const my = yc + t * cos;
    for (let i = 0; i < outW; i++) {
      const v = ((i + 0.5) / outW - 0.5) * paperW * 0.96; // a hair inside the edges: no table at the sides
      const fx = Math.max(0, Math.min(w - 1.001, mx + v * cos - 0.5));
      const fy = Math.max(0, Math.min(h - 1.001, my + v * sin - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const p = y0 * w + x0;
      const top = gray[p] + (gray[p + 1] - gray[p]) * ax;
      const bot = gray[p + w] + (gray[p + w + 1] - gray[p + w]) * ax;
      data[j * outW + i] = top + (bot - top) * ay;
    }
  }
  return { data, w: outW, h: outH };
}

/** Columns each row of the strip is summed into: enough to tell one line of print from another. */
export const BINS = 24;

/** Per row of a grey picture (w × h), how dark each of BINS columns is (0 = paper). */
export function rowFeatures(gray: Uint8ClampedArray, w: number, h: number): Float32Array {
  const f = new Float32Array(h * BINS);
  const per = w / BINS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = Math.min(BINS - 1, Math.floor(x / per));
      f[y * BINS + b] += (255 - gray[y * w + x]) / per;
    }
  }
  return f;
}

/** Below this spread of the features there is only blank paper: nothing to follow. */
const BLANK_SPREAD = 4;
/** A match worse than this is no match. */
const BAD_SCORE = 0.5;

/** The features blurred a little from row to row: a move by part of a row then still matches. */
function smooth(f: Float32Array): Float32Array {
  const h = f.length / BINS;
  const out = new Float32Array(f.length);
  const k = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++) {
    for (let b = 0; b < BINS; b++) {
      let s = 0;
      let n = 0;
      for (let i = -2; i <= 2; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) continue;
        s += f[yy * BINS + b] * k[i + 2];
        n += k[i + 2];
      }
      out[y * BINS + b] = s / n;
    }
  }
  return out;
}

/** Blurred a little, and the slow changes taken away (the phone's shadow, uneven light stay with the camera). */
function prep(f: Float32Array): Float32Array {
  const s = smooth(f);
  const h = s.length / BINS;
  const out = new Float32Array(s.length);
  const R = 5;
  for (let b = 0; b < BINS; b++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      let n = 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
        sum += s[yy * BINS + b];
        n++;
      }
      out[y * BINS + b] = s[y * BINS + b] - sum / n;
    }
  }
  return out;
}

function spread(f: Float32Array): number {
  let mean = 0;
  for (const v of f) mean += v;
  mean /= f.length || 1;
  let s = 0;
  for (const v of f) s += (v - mean) * (v - mean);
  return s / (f.length || 1);
}

/** How badly row `s` of `a` onwards matches `b` from its top (0 = the same; Infinity: too little in common). */
function matchScore(a: Float32Array, b: Float32Array, s: number, minRows: number): number {
  const ha = a.length / BINS;
  const hb = b.length / BINS;
  const a0 = Math.max(0, s);
  const b0 = Math.max(0, -s);
  const rows = Math.min(ha - a0, hb - b0);
  if (rows < minRows) return Infinity;
  const n = rows * BINS;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[a0 * BINS + i];
  mean /= n;
  let diff = 0;
  let ink = 0;
  for (let i = 0; i < n; i++) {
    const va = a[a0 * BINS + i];
    const d = va - b[b0 * BINS + i];
    diff += d * d;
    ink += (va - mean) * (va - mean);
  }
  if (ink / n < BLANK_SPREAD) return Infinity;
  return diff / ink;
}

/**
 * How many rows the print moved up from strip `prev` to strip `next` (row features of two strips).
 * Looked for within maxFrac of the height around `predicted`; of the shifts that match about as well
 * as the best one (lines that all look alike), the one nearest `predicted` wins. Sub-row precise.
 */
export function trackShift(
  prev: Float32Array,
  next: Float32Array,
  predicted: number,
  maxFrac = 0.35,
): { shift: number; score: number; blank: boolean } {
  prev = prep(prev);
  next = prep(next);
  if (spread(prev) < BLANK_SPREAD || spread(next) < BLANK_SPREAD) return { shift: predicted, score: Infinity, blank: true };
  const ha = prev.length / BINS;
  const hb = next.length / BINS;
  const minRows = Math.max(8, Math.round(Math.min(ha, hb) * 0.3));
  const reach = Math.max(2, Math.round(Math.min(ha, hb) * maxFrac));
  const lo = Math.max(-(hb - minRows), Math.round(predicted) - reach);
  const hi = Math.min(ha - minRows, Math.round(predicted) + reach);
  const scores = new Map<number, number>();
  let best = Infinity;
  for (let s = lo; s <= hi; s++) {
    const sc = matchScore(prev, next, s, minRows);
    scores.set(s, sc);
    if (sc < best) best = sc;
  }
  if (!Number.isFinite(best)) return { shift: predicted, score: Infinity, blank: false };
  let pick = lo;
  let pickDist = Infinity;
  for (const [s, sc] of scores) {
    if (sc > best * 3 + 0.25) continue;
    const d = Math.abs(s - predicted);
    if (d < pickDist) {
      pickDist = d;
      pick = s;
    }
  }
  // the low point of a parabola through the scores around it
  const l = scores.get(pick - 1) ?? Infinity;
  const r = scores.get(pick + 1) ?? Infinity;
  const c = scores.get(pick)!;
  let shift = pick;
  if (Number.isFinite(l) && Number.isFinite(r)) {
    const den = l - 2 * c + r;
    if (den > 1e-9) shift += Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den)));
  }
  return { shift, score: c, blank: false };
}

export type SweepState = 'moving' | 'fast' | 'lost' | 'blank';

/**
 * Follows the receipt from frame to frame (row features of each strip) and says when to keep a sharp
 * frame. Each frame is compared with the last kept one (not with the frame before), so small errors
 * do not add up. `pos`: rows of the strip moved since the first frame.
 */
export function createSweep({ keyFrac = 0.45, forceFrac = 0.6, fastFrac = 0.12, lostTicks = 3 } = {}) {
  let key: Float32Array | null = null;
  let keyPos = 0;
  let offset = 0;
  let speed = 0;
  let bad = 0;
  let lost = false;
  let state: SweepState = 'moving';
  return {
    push(feats: Float32Array): { pos: number; state: SweepState; capture: boolean } {
      if (!key) return { pos: 0, state: 'moving', capture: true };
      const rows = feats.length / BINS;
      const r = lost ? trackShift(key, feats, offset, 1) : trackShift(key, feats, offset + speed);
      if (r.blank) {
        if (!lost) state = 'blank';
        return { pos: keyPos + offset, state, capture: false };
      }
      if (r.score >= BAD_SCORE) {
        if (!lost && ++bad >= lostTicks) {
          lost = true;
          speed = 0;
        }
        if (lost) state = 'lost';
        return { pos: keyPos + offset, state, capture: false };
      }
      bad = 0;
      const was = lost;
      lost = false;
      const step = r.shift - offset;
      // the speed is smoothed: one odd frame does not throw the next guess far off
      speed = was ? 0 : speed * 0.5 + step * 0.5;
      offset = r.shift;
      state = Math.abs(step) > fastFrac * rows ? 'fast' : 'moving';
      // a fast step is blurred: wait for a steady frame, unless the overlap would get too small
      const capture = offset >= forceFrac * rows || (offset >= keyFrac * rows && state !== 'fast');
      return { pos: keyPos + offset, state, capture };
    },
    /** The frame with these features was kept: the next ones are compared with it. */
    captured(feats: Float32Array) {
      key = feats;
      keyPos += offset;
      offset = 0;
    },
  };
}

/** A sharp frame kept on the way: where its top is (rows of the strip), how tall it is, its row features. */
export type SweepKey = { pos: number; rows: number; feats: Float32Array };

/** How far around the tracked place each join is looked for again (fraction of the frame). */
const JOIN_REACH = 0.06;

/**
 * Which rows of each kept frame make the receipt: neighbours meet with no overlap and no gap. Each
 * join is looked for once more near where tracking put it, and cut in the middle of the overlap (the
 * middle of a frame is its sharpest, least bent part).
 */
export function layoutSweep(keys: SweepKey[]): { from: number; to: number }[] {
  if (!keys.length) return [];
  const at = [keys[0].pos];
  for (let i = 1; i < keys.length; i++) {
    const expected = keys[i].pos - keys[i - 1].pos;
    const r = trackShift(keys[i - 1].feats, keys[i].feats, expected, JOIN_REACH);
    const step = !r.blank && r.score < BAD_SCORE ? r.shift : expected;
    at.push(at[i - 1] + step);
  }
  const cuts: number[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const end = at[i] + keys[i].rows;
    cuts.push(end > at[i + 1] ? (at[i + 1] + end) / 2 : at[i + 1]);
  }
  return keys.map((k, i) => ({
    from: i === 0 ? 0 : Math.max(0, cuts[i - 1] - at[i]),
    to: i === keys.length - 1 ? k.rows : Math.min(k.rows, cuts[i] - at[i]),
  }));
}

/** How much the receipt leans in a frame `h` rows tall (radians, clockwise: its top to the right). */
export function stripTilt(s: Strip, h: number): number {
  const span = h * (BOT_Y - TOP_Y);
  return Math.atan2((s.topL - s.botL + s.topR - s.botR) / 2, span);
}

/** The receipt's left and right edge over the whole frame (h rows): [left top, left bottom, right bottom, right top]. */
export function stripEdges(
  s: Strip,
  h: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const at = (top: number, bot: number, y: number) => top + ((bot - top) * (y / h - TOP_Y)) / (BOT_Y - TOP_Y);
  return [
    { x: at(s.topL, s.botL, s.y0), y: s.y0 },
    { x: at(s.topL, s.botL, s.y1), y: s.y1 },
    { x: at(s.topR, s.botR, s.y1), y: s.y1 },
    { x: at(s.topR, s.botR, s.y0), y: s.y0 },
  ];
}
