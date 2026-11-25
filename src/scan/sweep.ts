/**
 * "Paragon": where the receipt is in a small grey camera frame (its left and right edge, and its top
 * or end when in view), for the camera's outline and hints. Following the camera is in track.ts.
 */

/**
 * Left and right edge of the receipt (columns, px) in the top and in the bottom band of a frame, and
 * the rows the paper takes (y0..y1): the whole frame, or less when its top or its end is in view.
 */
export type Strip = { topL: number; topR: number; botL: number; botR: number; y0: number; y1: number };

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
