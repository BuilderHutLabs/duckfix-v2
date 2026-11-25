/**
 * "Paragon": a long receipt filmed while the phone moves down it. These are the sums on small grey
 * frames: where the receipt's edges are, how far it moved since the last frame, and how the sharp
 * frames kept on the way are laid out into one receipt.
 */

/** Left and right edge of the receipt (columns, px) in the top and in the bottom band of a frame. */
export type Strip = { topL: number; topR: number; botL: number; botR: number };

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
function edgesIn(gray: Uint8ClampedArray, w: number, y0: number, y1: number): { l: number; r: number } | null {
  const col = new Float32Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) col[x] += gray[y * w + x];
  for (let x = 0; x < w; x++) col[x] /= y1 - y0;
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
  let bestL = 0;
  let bestLen = 0;
  for (let x = 0; x < w;) {
    if (col[x] <= thr) {
      x++;
      continue;
    }
    const start = x;
    while (x < w && col[x] > thr) x++;
    if (x - start > bestLen) {
      bestLen = x - start;
      bestL = start;
    }
  }
  if (bestLen < w * 0.25 || bestLen > w * 0.95) return null;
  return { l: bestL, r: bestL + bestLen };
}

/** The receipt's edges in a grey frame (w × h), or null when no receipt on a darker table is seen. */
export function findStrip(gray: Uint8ClampedArray, w: number, h: number): Strip | null {
  const band = Math.max(1, Math.round(h * BAND));
  const top = edgesIn(gray, w, 0, band);
  const bot = edgesIn(gray, w, h - band, h);
  if (!top || !bot) return null;
  return { topL: top.l, topR: top.r, botL: bot.l, botR: bot.r };
}

/**
 * The receipt cut out of the frame and brought to `outW` columns: each row is read between the
 * edges (taken in a straight line from the top band to the bottom one), and the rows are scaled by
 * the same factor, so a "row of the strip" is the same length whatever the phone's distance.
 */
export function unwarpStrip(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  s: Strip,
  outW = 96,
): { data: Uint8ClampedArray; w: number; h: number } {
  const paperW = (s.topR - s.topL + s.botR - s.botL) / 2;
  const k = outW / paperW;
  const outH = Math.max(1, Math.round(h * k));
  const data = new Uint8ClampedArray(outW * outH);
  const yTop = h * TOP_Y;
  const span = h * (BOT_Y - TOP_Y);
  for (let j = 0; j < outH; j++) {
    const y = Math.min(h - 1, Math.floor((j + 0.5) / k));
    const f = (y + 0.5 - yTop) / span;
    const l = s.topL + (s.botL - s.topL) * f;
    const r = s.topR + (s.botR - s.topR) * f;
    const step = (r - l) / outW;
    const row = y * w;
    for (let i = 0; i < outW; i++) {
      const x = Math.max(0, Math.min(w - 1, Math.floor(l + (i + 0.5) * step)));
      data[j * outW + i] = gray[row + x];
    }
  }
  return { data, w: outW, h: outH };
}
