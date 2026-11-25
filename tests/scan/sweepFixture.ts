/** Made-up receipts and camera frames of them, for the "Paragon" sweep tests. */

const PAPER = 245;
const INK = 40;
const TABLE = 70;

/** Steady pseudo-random numbers 0..1 (mulberry32: no short cycles, unlike a float LCG). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A long receipt (grey pixels, w × h): lines of "text" of random length. Rows repeatFrom..repeatTo
 * hold one and the same line over and over ("1 szt. x 4,99"), every `pitch` rows.
 */
export function makeReceipt(w: number, h: number, { seed = 7, repeatFrom = -1, repeatTo = -1, pitch = 16 } = {}): Uint8ClampedArray {
  const rnd = rng(seed);
  const g = new Uint8ClampedArray(w * h).fill(PAPER);
  const line = (y: number, start: number, end: number, r: () => number) => {
    for (let yy = y; yy < Math.min(h, y + 7); yy++)
      for (let xx = start; xx < Math.min(w - 4, end); xx++) if (r() > 0.35) g[yy * w + xx] = INK;
  };
  for (let y = 10; y < h - 14;) {
    if (y >= repeatFrom && y < repeatTo) {
      line(y, Math.round(w * 0.08), Math.round(w * 0.7), rng(99)); // the very same pixels every time
      y += pitch;
      continue;
    }
    const start = Math.floor(rnd() * w * 0.3);
    line(y, start, start + Math.floor(w * (0.3 + rnd() * 0.6)), rnd);
    y += 14 + Math.floor(rnd() * 6);
  }
  return g;
}

export type FrameOpts = {
  /** Receipt row at the top edge of the frame. */
  y: number;
  frameW: number;
  frameH: number;
  /** How wide the receipt looks in the frame (px). */
  paperW: number;
  /** Clockwise turn of the receipt in the frame (degrees): its top leans right. */
  tiltDeg?: number;
  /** The hand's sway: the receipt sits this many px right of the middle. */
  dx?: number;
  /** Shadow of the phone: the frame darkens by this share from top to bottom (it stays with the camera). */
  shade?: number;
  /** Grain (± grey levels). */
  noise?: number;
  seed?: number;
};

/** What the camera sees: the receipt (rw × rh) centred on a dark table, from receipt row `y` down. */
export function frameOf(rec: Uint8ClampedArray, rw: number, rh: number, o: FrameOpts): Uint8ClampedArray {
  const { frameW: fw, frameH: fh, paperW } = o;
  const s = paperW / rw;
  const t = ((o.tiltDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rnd = rng(o.seed ?? 3);
  const noise = o.noise ?? 0;
  const out = new Uint8ClampedArray(fw * fh);
  // each pixel averages 3 × 3 points, as a camera's lens and sensor do (no sharp stair-steps)
  const at = (px: number, py: number): number => {
    const cx = px - fw / 2;
    const cy = py - fh / 2;
    const ux = cx * cos + cy * sin + fw / 2;
    const uy = -cx * sin + cy * cos + fh / 2;
    const rx = Math.floor((ux - (fw - paperW) / 2 - (o.dx ?? 0)) / s);
    const ry = Math.floor(o.y + uy / s);
    if (rx >= 0 && rx < rw && ry >= 0 && ry < rh) return rec[ry * rw + rx];
    // the table's grain lies on the table (it moves with the receipt, not with the camera)
    return TABLE + Math.round(6 * Math.sin(rx * 0.21 + ry * 0.05) + 3 * Math.sin(ry * 0.37 - rx * 0.11));
  };
  for (let fy = 0; fy < fh; fy++) {
    for (let fx = 0; fx < fw; fx++) {
      let v = 0;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) v += at(fx + (i + 0.5) / 3, fy + (j + 0.5) / 3);
      v /= 9;
      if (o.shade) v *= 1 - (o.shade * fy) / fh;
      if (noise) v += Math.round((rnd() * 2 - 1) * noise);
      out[fy * fw + fx] = v;
    }
  }
  return out;
}

/**
 * Two receipts one under the other on the table: the second one narrower and to one side, with a
 * strip of table between them (table pixels inside the picture show the table).
 */
export function joinedReceipts(w: number, h: number): Uint8ClampedArray {
  const a = makeReceipt(w, h, { seed: 11 });
  const b = makeReceipt(w, h, { seed: 23 });
  const out = new Uint8ClampedArray(w * h);
  const gapFrom = Math.round(h * 0.45);
  const gapTo = gapFrom + 30;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (y < gapFrom) out[i] = a[i];
      else if (y < gapTo) out[i] = TABLE;
      else out[i] = x < w * 0.12 ? TABLE : b[i]; // narrower, to the right
    }
  return out;
}
