/**
 * "Paragon": following the camera over a long receipt, the way a panorama is put together. Each
 * small grey frame is matched with the last kept one by a move, a change of size (the phone comes
 * closer or goes away) and a small turn; the kept frames then sit in one picture of the receipt.
 * The receipt's edges are not needed, so receipts of different widths one under another, a hand
 * that sways left and right, or a phone that bobs up and down do not throw it off.
 */

/** A picture prepared for matching: details kept, light and shadows taken away. Two sizes. */
export type Pyr = { levels: { d: Float32Array; w: number; h: number; gx: Float32Array; gy: Float32Array }[]; spread: number };

/**
 * Where a picture's points land in another one: x' = m[0] x + m[1] y + m[2], y' = m[3] x + m[4] y + m[5],
 * with x, y measured from the middle of the picture (in pixels of the small frame).
 */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0];

export function apply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[1] * y + m[2], y: m[3] * x + m[4] * y + m[5] };
}
/** b first, then a. */
export function compose(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}
export function invert(m: Mat): Mat {
  const det = m[0] * m[4] - m[1] * m[3] || 1e-12;
  const a = m[4] / det;
  const b = -m[1] / det;
  const d = -m[3] / det;
  const e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

function blurBox(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function half(src: Float32Array, w: number, h: number): { d: Float32Array; w: number; h: number } {
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);
  const d = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const i = 2 * y * w + 2 * x;
      d[y * hw + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) / 4;
    }
  return { d, w: hw, h: hh };
}

function level(d: Float32Array, w: number, h: number) {
  const gx = new Float32Array(d.length);
  const gy = new Float32Array(d.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (d[i + 1] - d[i - 1]) / 2;
      gy[i] = (d[i + w] - d[i - w]) / 2;
    }
  return { d, w, h, gx, gy };
}

/** A small grey frame (w × h) made ready for matching: half size, softened, slow light changes removed. */
export function prepare(gray: Uint8ClampedArray, w: number, h: number): Pyr {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = gray[i];
  const a = half(f, w, h);
  const soft = blurBox(a.d, a.w, a.h, 1);
  const slow = blurBox(a.d, a.w, a.h, 7);
  const d0 = new Float32Array(a.d.length);
  let s = 0;
  for (let i = 0; i < d0.length; i++) {
    d0[i] = soft[i] - slow[i];
    s += d0[i] * d0[i];
  }
  const b = half(d0, a.w, a.h);
  return { levels: [level(d0, a.w, a.h), level(b.d, b.w, b.h)], spread: s / d0.length };
}

/**
 * How `cur` sits against `key` (key points → cur points, from `init`), and how well they then agree
 * (0..1; 0 when they overlap too little). Gauss-Newton on two sizes, inverse compositional.
 */
export function align(key: Pyr, cur: Pyr, init: Mat, reach = 0.35): { m: Mat; ncc: number } {
  let m: Mat = search(key, cur, init, reach);
  for (let l = key.levels.length - 1; l >= 0; l--) {
    const T = key.levels[l];
    const I = cur.levels[l];
    const sc = 2 ** (l + 1); // small-frame px per pixel of this level
    // the matrix in this level's pixels
    let ml: Mat = [m[0], m[1], m[2] / sc, m[3], m[4], m[5] / sc];
    const step = l === 0 ? 2 : 1;
    const iters = l === 0 ? 8 : 12;
    const cxT = T.w / 2;
    const cyT = T.h / 2;
    const cxI = I.w / 2;
    const cyI = I.h / 2;
    for (let it = 0; it < iters; it++) {
      const H = new Float64Array(16);
      const g = new Float64Array(4);
      let n = 0;
      for (let y = 2; y < T.h - 2; y += step) {
        const py = y - cyT;
        for (let x = 2; x < T.w - 2; x += step) {
          const px = x - cxT;
          const qx = ml[0] * px + ml[1] * py + ml[2] + cxI;
          const qy = ml[3] * px + ml[4] * py + ml[5] + cyI;
          if (qx < 0 || qy < 0 || qx >= I.w - 1 || qy >= I.h - 1) continue;
          const x0 = qx | 0;
          const y0 = qy | 0;
          const ax = qx - x0;
          const ay = qy - y0;
          const j = y0 * I.w + x0;
          const v = (I.d[j] * (1 - ax) + I.d[j + 1] * ax) * (1 - ay) + (I.d[j + I.w] * (1 - ax) + I.d[j + I.w + 1] * ax) * ay;
          const i = y * T.w + x;
          const e = v - T.d[i];
          const tx = T.gx[i];
          const ty = T.gy[i];
          const s0 = tx * px + ty * py;
          const s1 = -tx * py + ty * px;
          const sd = [s0, s1, tx, ty];
          for (let r = 0; r < 4; r++) {
            g[r] += sd[r] * e;
            for (let c = r; c < 4; c++) H[r * 4 + c] += sd[r] * sd[c];
          }
          n++;
        }
      }
      if (n < 50) break;
      for (let r = 0; r < 4; r++) for (let c = 0; c < r; c++) H[r * 4 + c] = H[c * 4 + r];
      const dp = solve4(H, g);
      if (!dp) break;
      // the small step, undone from the key's side: m ← m ∘ W(dp)⁻¹
      const W: Mat = [1 + dp[0], -dp[1], dp[2], dp[1], 1 + dp[0], dp[3]];
      ml = compose(ml, invert(W));
      if (Math.abs(dp[2]) + Math.abs(dp[3]) < 0.01 && Math.abs(dp[0]) + Math.abs(dp[1]) < 1e-4) break;
    }
    m = [ml[0], ml[1], ml[2] * sc, ml[3], ml[4], ml[5] * sc];
  }
  // a phone does not double its distance or turn far between two frames
  const scale = Math.hypot(m[0], m[3]);
  if (scale < 0.8 || scale > 1.25 || Math.abs(m[3]) / scale > 0.17) return { m, ncc: 0 };
  return { m, ncc: agreement(key.levels[0], cur.levels[0], m) };
}

/**
 * The move (up/down within `reach` of the frame, a little sideways) that best fits on the smaller
 * size, around `init`: where the fine matching starts, so a quick step is not missed.
 */
function search(key: Pyr, cur: Pyr, init: Mat, reach: number): Mat {
  const l = key.levels.length - 1;
  const T = key.levels[l];
  const I = cur.levels[l];
  const sc = 2 ** (l + 1);
  const R = Math.max(2, Math.round(T.h * reach));
  const cxT = T.w / 2;
  const cyT = T.h / 2;
  let best = Infinity;
  let bx = init[2];
  let by = init[5];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -4; dx <= 4; dx += 2) {
      const ox = init[2] / sc + dx;
      const oy = init[5] / sc + dy;
      let sum = 0;
      let n = 0;
      for (let y = 2; y < T.h - 2; y += 2) {
        const py = y - cyT;
        for (let x = 2; x < T.w - 2; x += 2) {
          const px = x - cxT;
          const qx = Math.round(init[0] * px + init[1] * py + ox + I.w / 2);
          const qy = Math.round(init[3] * px + init[4] * py + oy + I.h / 2);
          if (qx < 0 || qy < 0 || qx >= I.w || qy >= I.h) continue;
          const e = I.d[qy * I.w + qx] - T.d[y * T.w + x];
          sum += e * e;
          n++;
        }
      }
      const total = ((T.w - 4) / 2) * ((T.h - 4) / 2);
      if (n < total * 0.3) continue;
      // a little extra for moves far from the guess: of two equal fits, the nearer wins
      const score = sum / n + 0.002 * (dy * dy + dx * dx) * (sum / n);
      if (score < best) {
        best = score;
        bx = ox * sc;
        by = oy * sc;
      }
    }
  }
  return [init[0], init[1], bx, init[3], init[4], by];
}

function solve4(A: Float64Array, b: Float64Array): number[] | null {
  const M = [0, 1, 2, 3].map((r) => [A[r * 4], A[r * 4 + 1], A[r * 4 + 2], A[r * 4 + 3], b[r]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[4] / M[i][i]);
}

/** Correlation of the key and the moved current picture where they overlap (0 with too little overlap). */
function agreement(T: Pyr['levels'][0], I: Pyr['levels'][0], m: Mat): number {
  const sc = 2;
  const ml: Mat = [m[0], m[1], m[2] / sc, m[3], m[4], m[5] / sc];
  let st = 0;
  let si = 0;
  let stt = 0;
  let sii = 0;
  let sti = 0;
  let n = 0;
  for (let y = 2; y < T.h - 2; y += 2) {
    const py = y - T.h / 2;
    for (let x = 2; x < T.w - 2; x += 2) {
      const px = x - T.w / 2;
      const qx = ml[0] * px + ml[1] * py + ml[2] + I.w / 2;
      const qy = ml[3] * px + ml[4] * py + ml[5] + I.h / 2;
      if (qx < 0 || qy < 0 || qx >= I.w - 1 || qy >= I.h - 1) continue;
      const x0 = qx | 0;
      const y0 = qy | 0;
      const ax = qx - x0;
      const ay = qy - y0;
      const j = y0 * I.w + x0;
      const v = (I.d[j] * (1 - ax) + I.d[j + 1] * ax) * (1 - ay) + (I.d[j + I.w] * (1 - ax) + I.d[j + I.w + 1] * ax) * ay;
      const t = T.d[y * T.w + x];
      st += t;
      si += v;
      stt += t * t;
      sii += v * v;
      sti += t * v;
      n++;
    }
  }
  const total = ((T.w - 4) / 2) * ((T.h - 4) / 2);
  if (n < total * 0.2) return 0;
  const cov = sti - (st * si) / n;
  const vt = stt - (st * st) / n;
  const vi = sii - (si * si) / n;
  return vt > 0 && vi > 0 ? cov / Math.sqrt(vt * vi) : 0;
}

export type SweepState = 'moving' | 'fast' | 'lost' | 'blank';

/** Below this spread the frame shows only blank paper (or nothing): nothing to follow. */
const BLANK = 4;
/** Agreement below this is no match. */
const GOOD = 0.5;

/**
 * Follows the camera frame by frame. Each frame is matched with the last kept one (no small errors
 * adding up); `global` places the frame in the receipt's picture (the first frame's pixels).
 * `pos`: how far down the receipt the frame's top is (small-frame px).
 */
export function createTracker({ keyFrac = 0.45, forceFrac = 0.6, fastFrac = 0.12, lostTicks = 3 } = {}) {
  let key: Pyr | null = null;
  let keyG: Mat = IDENTITY;
  let rel: Mat = IDENTITY; // key → current
  let vy = 0; // change of rel's ty per frame
  let bad = 0;
  let lost = false;
  let state: SweepState = 'moving';
  let h = 1;
  const top = (g: Mat) => apply(g, 0, -h / 2).y + h / 2;
  return {
    push(cur: Pyr): { pos: number; state: SweepState; capture: boolean; global: Mat; ncc: number } {
      h = cur.levels[0].h * 2;
      if (!key) return { pos: 0, state: 'moving', capture: true, global: IDENTITY, ncc: 1 };
      const g = () => compose(keyG, invert(rel));
      if (cur.spread < BLANK || key.spread < BLANK) {
        if (!lost) state = 'blank';
        return { pos: top(g()), state, capture: false, global: g(), ncc: 0 };
      }
      let best = { m: rel, ncc: -1 };
      const tries: number[] = lost ? [0, -0.15, 0.15, -0.3, 0.3] : [0];
      for (const d of tries) {
        const init: Mat = [rel[0], rel[1], rel[2], rel[3], rel[4], rel[5] + (lost ? d * h : vy)];
        const r = align(key, cur, init, lost ? 0.6 : 0.35);
        if (r.ncc > best.ncc) best = r;
        if (best.ncc >= GOOD && !lost) break;
      }
      if (best.ncc < GOOD) {
        if (!lost && ++bad >= lostTicks) {
          lost = true;
          vy = 0;
        }
        if (lost) state = 'lost';
        return { pos: top(g()), state, capture: false, global: g(), ncc: best.ncc };
      }
      bad = 0;
      const step = best.m[5] - rel[5];
      vy = lost ? 0 : vy * 0.5 + step * 0.5;
      lost = false;
      rel = best.m;
      state = Math.abs(step) > fastFrac * h ? 'fast' : 'moving';
      // how far the current frame's top is down the key frame
      const down = apply(invert(rel), 0, -h / 2).y + h / 2;
      const capture = down >= forceFrac * h || (down >= keyFrac * h && state !== 'fast');
      const gl = g();
      return { pos: top(gl), state, capture, global: gl, ncc: best.ncc };
    },
    /** The frame `cur` (just pushed, at `global`) was kept: the next ones are matched with it. */
    captured(cur: Pyr, global: Mat) {
      key = cur;
      keyG = global;
      rel = IDENTITY;
    },
  };
}

/** A kept frame: where it sits in the receipt's picture, and its size (small-frame px). */
export type TrackKey = { global: Mat; w: number; h: number };

/**
 * Which rows of the receipt's picture each kept frame gives (neighbours meet in the middle of their
 * overlap), and the columns any of them covers (a hand that swayed cuts nothing off).
 */
export function layoutKeys(keys: TrackKey[]): {
  bands: { from: number; to: number }[];
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const tops = keys.map((k) => apply(k.global, 0, -k.h / 2).y);
  const bots = keys.map((k) => apply(k.global, 0, k.h / 2).y);
  const cuts: number[] = [];
  for (let i = 0; i + 1 < keys.length; i++) cuts.push(bots[i] > tops[i + 1] ? (tops[i + 1] + bots[i]) / 2 : tops[i + 1]);
  const bands = keys.map((_, i) => ({ from: i === 0 ? tops[0] : cuts[i - 1], to: i === keys.length - 1 ? bots[i] : cuts[i] }));
  let left = Infinity;
  let right = -Infinity;
  keys.forEach((k, i) => {
    for (const y of [bands[i].from, bands[i].to]) {
      // the frame's left and right edge at this row of the picture
      const inv = invert(k.global);
      const p = apply(inv, 0, y);
      const l = apply(k.global, -k.w / 2, p.y).x;
      const r = apply(k.global, k.w / 2, p.y).x;
      left = Math.min(left, l);
      right = Math.max(right, r);
    }
  });
  return { bands, left, right, top: bands[0]?.from ?? 0, bottom: bands.at(-1)?.to ?? 0 };
}

/**
 * The paper in a grey picture (w × h): the columns where paper shows and the rows from the first to
 * the last one with paper; null when no paper stands out from the table.
 */
export function paperBox(gray: Uint8ClampedArray, w: number, h: number): { x0: number; x1: number; y0: number; y1: number } | null {
  // paper is the brightest big part, the table (wood, cloth, its grain and shadows) the rest: the
  // threshold sits nearer the paper, measured against this picture (a dim video still works)
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const at = (share: number) => {
    let n = 0;
    for (let i = 0; i < 256; i++) if ((n += hist[i]) >= gray.length * share) return i;
    return 255;
  };
  const table = at(0.5); // the table takes most of the picture (else there is little to cut off)
  const paper = at(0.98);
  if (paper - table < 15) return null;
  const thr = table + (paper - table) * 0.6;
  const colPaper = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] > thr) colPaper[x]++;
  let x0 = 0;
  let x1 = w;
  while (x0 < w && colPaper[x0] < h * 0.03) x0++; // a column with any paper (a short receipt to one side too)
  while (x1 > x0 && colPaper[x1 - 1] < h * 0.03) x1--;
  if (x1 - x0 < w * 0.1) return null;
  const rowPaper = (y: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (gray[y * w + x] > thr) n++;
    return n >= (x1 - x0) * 0.3;
  };
  let y0 = 0;
  let y1 = h;
  while (y0 < h && !rowPaper(y0)) y0++;
  while (y1 > y0 && !rowPaper(y1 - 1)) y1--;
  if (y1 - y0 < h * 0.05) return null;
  return { x0, x1, y0, y1 };
}
