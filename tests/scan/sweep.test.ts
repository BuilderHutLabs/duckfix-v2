import {
  STRIP_W,
  createSweep,
  findStrip,
  layoutSweep,
  rowFeatures,
  unwarpStrip,
  type SweepKey,
  type SweepState,
} from '../../src/scan/sweep';
import { frameOf, makeReceipt } from './sweepFixture';

const RW = 200;
const RH = 900;
const rec = makeReceipt(RW, RH);
const frame = (o: Partial<Parameters<typeof frameOf>[3]> = {}) =>
  frameOf(rec, RW, RH, { y: 100, frameW: 200, frameH: 150, paperW: 120, noise: 6, ...o });

describe('Paragon sweep: the receipt in the frame', () => {
  it('finds its left and right edge', () => {
    const s = findStrip(frame(), 200, 150)!;
    expect(s).not.toBeNull();
    for (const v of [s.topL, s.botL]) expect(Math.abs(v - 40)).toBeLessThanOrEqual(2);
    for (const v of [s.topR, s.botR]) expect(Math.abs(v - 160)).toBeLessThanOrEqual(2);
  });

  it('a turned receipt: its top edge lies further right than its bottom one', () => {
    const s = findStrip(frame({ tiltDeg: 3 }), 200, 150)!;
    // 3° over the 112 rows between the two bands: about 6 px
    expect(s.topL - s.botL).toBeGreaterThan(4);
    expect(s.topL - s.botL).toBeLessThan(8);
    expect(s.topR - s.botR).toBeGreaterThan(4);
  });

  it('paper over the whole frame (no table to see) or no paper at all: no receipt', () => {
    expect(findStrip(new Uint8ClampedArray(200 * 150).fill(240), 200, 150)).toBeNull();
    expect(findStrip(new Uint8ClampedArray(200 * 150).fill(60), 200, 150)).toBeNull();
    expect(findStrip(frame({ paperW: 200 }), 200, 150)).toBeNull();
  });

  it('the strip is brought to STRIP_W columns, rows scaled alike', () => {
    const g = frame();
    const u = unwarpStrip(g, 200, 150, findStrip(g, 200, 150)!);
    expect(u.w).toBe(STRIP_W);
    expect(Math.abs(u.h - (150 * STRIP_W) / 120)).toBeLessThanOrEqual(1);
    expect(u.data.length).toBe(u.w * u.h);
    // only paper and print in it, no table: the outer columns are paper
    for (const x of [0, 1, STRIP_W - 2, STRIP_W - 1]) {
      let sum = 0;
      for (let y = 0; y < u.h; y++) sum += u.data[y * u.w + x];
      expect(sum / u.h).toBeGreaterThan(200);
    }
  });
});

/** What the sweep gets from one camera frame: the row features of the straightened strip. */
function featsOf(r: Uint8ClampedArray, y: number, o: Partial<Parameters<typeof frameOf>[3]> = {}) {
  const g = frameOf(r, RW, RH, { y, frameW: 200, frameH: 150, paperW: 120, noise: 6, seed: Math.round(y * 7) + 1, ...o });
  const st = findStrip(g, 200, 150)!;
  const u = unwarpStrip(g, 200, 150, st);
  return rowFeatures(u.data, u.w, u.h);
}
/** Rows of the strip per row of the receipt: STRIP_W columns for the receipt's RW. */
const PER_ROW = STRIP_W / RW;

/** Runs a sweep over frames at receipt rows ys; returns the last pos, the states, and where frames were kept. */
function run(r: Uint8ClampedArray, ys: number[], o: (y: number, i: number) => Partial<Parameters<typeof frameOf>[3]> = () => ({})) {
  const sw = createSweep();
  let pos = 0;
  const states: SweepState[] = [];
  const keys: number[] = [];
  ys.forEach((y, i) => {
    const f = featsOf(r, y, o(y, i));
    const out = sw.push(f);
    pos = out.pos;
    states.push(out.state);
    if (out.capture) {
      sw.captured(f);
      keys.push(y);
    }
  });
  return { pos, states, keys };
}
const steps = (from: number, to: number, by: number) => Array.from({ length: Math.floor((to - from) / by) + 1 }, (_, i) => from + i * by);

describe('Paragon sweep: following the receipt', () => {
  it('the rows moved add up to how far the phone went', () => {
    const { pos, states } = run(rec, steps(0, 640, 6));
    expect(Math.abs(pos - 640 * PER_ROW)).toBeLessThanOrEqual(640 * PER_ROW * 0.02);
    expect(states.filter((s) => s === 'lost')).toHaveLength(0);
  });

  it('forty lines that look exactly alike: never off by one line', () => {
    const same = makeReceipt(RW, RH, { repeatFrom: 150, repeatTo: 790 });
    const { pos } = run(same, steps(0, 640, 6));
    expect(Math.abs(pos - 640 * PER_ROW)).toBeLessThanOrEqual(640 * PER_ROW * 0.02);
  });

  it('a jump too far: lost after three frames; back where the last frame was kept, it goes on from there', () => {
    const sw = createSweep();
    const f0 = featsOf(rec, 100);
    expect(sw.push(f0).capture).toBe(true);
    sw.captured(f0);
    sw.push(featsOf(rec, 106));
    const far = [400, 404, 408].map((y) => sw.push(featsOf(rec, y)).state);
    expect(far.at(-1)).toBe('lost');
    expect(far.slice(0, 2)).not.toContain('lost');
    const back = sw.push(featsOf(rec, 112));
    expect(back.state).not.toBe('lost');
    expect(Math.abs(back.pos - 12 * PER_ROW)).toBeLessThanOrEqual(2);
  });

  it('blank paper (the end of the receipt): it does not move, and is not lost', () => {
    const blank = new Uint8ClampedArray(RW * RH).fill(245);
    const sw = createSweep();
    const f0 = featsOf(rec, 100);
    sw.push(f0);
    sw.captured(f0);
    const out = sw.push(featsOf(blank, 300));
    expect(out.state).toBe('blank');
    expect(out.pos).toBe(0);
  });

  it('a frame is kept at the start and then every ~45% of the frame', () => {
    const { keys } = run(rec, steps(0, 640, 6));
    expect(keys[0]).toBe(0);
    // the frame shows 250 rows of the receipt: a new one after ~112 rows
    const gaps = keys.slice(1).map((k, i) => k - keys[i]);
    for (const g of gaps) expect(Math.abs(g - 112)).toBeLessThanOrEqual(8);
  });

  it('moving fast: "fast", but still followed', () => {
    const { pos, states } = run(rec, steps(0, 560, 56));
    expect(states).toContain('fast');
    expect(Math.abs(pos - 560 * PER_ROW)).toBeLessThanOrEqual(560 * PER_ROW * 0.03);
  });
});

/**
 * The whole way on a made-up receipt: frames, the sweep, the kept frames (and the last one), the
 * layout. Returns the length put together (rows of the receipt) and, for each join, how far apart
 * the two frames were put against how far apart they really were (rows of the strip).
 */
function sweepAndCompose(r: Uint8ClampedArray, ys: number[], o: (y: number) => Partial<Parameters<typeof frameOf>[3]> = () => ({})) {
  const sw = createSweep();
  const keys: (SweepKey & { y: number })[] = [];
  let last: (SweepKey & { y: number }) | null = null;
  for (const y of ys) {
    const opts = { y, frameW: 200, frameH: 150, paperW: 120, noise: 6, seed: y * 7 + 1, ...o(y) };
    const g = frameOf(r, RW, RH, opts);
    const u = unwarpStrip(g, 200, 150, findStrip(g, 200, 150)!);
    const f = rowFeatures(u.data, u.w, u.h);
    const out = sw.push(f);
    last = { pos: out.pos, rows: u.h, feats: f, y };
    if (out.capture) {
      sw.captured(f);
      keys.push(last);
    }
  }
  keys.push(last!); // "Stop": the last frame too
  const ranges = layoutSweep(keys);
  const length = ranges.reduce((n, rg) => n + rg.to - rg.from, 0) / PER_ROW;
  // where frame b starts in frame a's rows is a.to - b.from (both meet at the cut)
  const joins = ranges.slice(1).map((b, i) => ({ put: ranges[i].to - b.from, real: (keys[i + 1].y - keys[i].y) * PER_ROW }));
  return { length, joins };
}

/** A join off by more than this many strip rows shows a line twice or loses one (a line of print is ~4.5 rows). */
const JOIN_OK = 2;

describe('Paragon sweep: the kept frames make one receipt', () => {
  const all = steps(0, 640, 6);
  // the last frame shows the receipt down to row 640 + 250 (150 frame rows at 0.6 px per receipt row)
  const SEEN = 640 + 250;

  it('as long as the real one, and the same all the way down', () => {
    const { length, joins } = sweepAndCompose(rec, all);
    expect(Math.abs(length - SEEN) / SEEN).toBeLessThanOrEqual(0.02);
    for (const j of joins) expect(Math.abs(j.put - j.real)).toBeLessThanOrEqual(JOIN_OK);
  });

  it('the phone comes closer and goes back on the way: still the right length', () => {
    const { length, joins } = sweepAndCompose(rec, all, (y) => ({ paperW: 120 + 10 * Math.sin(y / 100) }));
    expect(Math.abs(length - SEEN) / SEEN).toBeLessThanOrEqual(0.02);
    for (const j of joins) expect(Math.abs(j.put - j.real)).toBeLessThanOrEqual(JOIN_OK);
  });

  it('forty lines that look alike: none of them twice, none missing', () => {
    const same = makeReceipt(RW, RH, { repeatFrom: 150, repeatTo: 790 });
    const { length, joins } = sweepAndCompose(same, all);
    expect(Math.abs(length - SEEN) / SEEN).toBeLessThanOrEqual(0.02);
    for (const j of joins) expect(Math.abs(j.put - j.real)).toBeLessThanOrEqual(JOIN_OK);
  });

  it('a wrong place from tracking (off by a few rows) is put right at the join', () => {
    const keys = [0, 112, 224].map((y) => {
      const g = frameOf(rec, RW, RH, { y, frameW: 200, frameH: 150, paperW: 120, noise: 6 });
      const u = unwarpStrip(g, 200, 150, findStrip(g, 200, 150)!);
      return { pos: y * PER_ROW + (y ? 4 : 0), rows: u.h, feats: rowFeatures(u.data, u.w, u.h) };
    });
    const [a, b] = layoutSweep(keys);
    // the second frame starts 112 receipt rows (53.8 strip rows) below the first: the cut sits in the overlap
    expect(Math.abs(a.to - b.from - 112 * PER_ROW)).toBeLessThanOrEqual(1);
  });
});

describe('Paragon sweep: what a real camera adds (from the review)', () => {
  it('blank paper under the phone shadow is still blank paper, not something that moves', () => {
    const blank = new Uint8ClampedArray(RW * RH).fill(245);
    const sw = createSweep();
    const f0 = featsOf(rec, 100, { shade: 0.25 });
    sw.push(f0);
    sw.captured(f0);
    const out = sw.push(featsOf(blank, 300, { shade: 0.25 }));
    expect(out.state).toBe('blank');
  });

  it('followed under the phone shadow just as well', () => {
    const { pos } = run(rec, steps(0, 640, 6), () => ({ shade: 0.25 }));
    expect(Math.abs(pos - 640 * PER_ROW)).toBeLessThanOrEqual(640 * PER_ROW * 0.02);
  });

  it('lines that look alike close together, and a shaky hand (steps of 3 to 9 rows): never off by a line', () => {
    const same = makeReceipt(RW, RH, { repeatFrom: 150, repeatTo: 790, pitch: 10 });
    const shake = [3, 8, 5, 9, 4, 7, 3, 6, 9, 5, 4, 8];
    const ys = [0];
    for (let i = 0; ys.at(-1)! < 640; i++) ys.push(Math.min(640, ys.at(-1)! + shake[i % shake.length]));
    const { pos, states } = run(same, ys);
    expect(states).not.toContain('lost');
    expect(Math.abs(pos - ys.at(-1)! * PER_ROW)).toBeLessThanOrEqual(ys.at(-1)! * PER_ROW * 0.02);
  });

  it('no frame is kept in a fast, blurred step: the next steady one is kept instead', () => {
    const sw = createSweep();
    const f0 = featsOf(rec, 0);
    sw.push(f0);
    sw.captured(f0);
    sw.push(featsOf(rec, 40)); // speeding up
    // a quick move past the keeping point
    const fast = sw.push(featsOf(rec, 120));
    expect(fast.state).toBe('fast');
    expect(fast.capture).toBe(false);
    const steady = sw.push(featsOf(rec, 123));
    expect(steady.state).toBe('moving');
    expect(steady.capture).toBe(true);
  });
});

describe('Paragon sweep: the top and the end of the receipt in the frame (from the review)', () => {
  it('the table above the receipt top: still found, starting where the paper starts', () => {
    const g = frameOf(rec, RW, RH, { y: -40, frameW: 200, frameH: 150, paperW: 120, noise: 6 }); // top at frame row 24
    const s = findStrip(g, 200, 150)!;
    expect(s).not.toBeNull();
    expect(Math.abs(s.y0 - 24)).toBeLessThanOrEqual(2);
    expect(s.y1).toBe(150);
    expect(Math.abs(s.topL - 40)).toBeLessThanOrEqual(2);
    const u = unwarpStrip(g, 200, 150, s);
    expect(Math.abs(u.h - ((150 - s.y0) * STRIP_W) / 120)).toBeLessThanOrEqual(2);
  });

  it('the receipt end in the middle of the frame: still found, ending where the paper ends', () => {
    const g = frameOf(rec, RW, RH, { y: RH - 125, frameW: 200, frameH: 150, paperW: 120, noise: 6 }); // end at frame row 75
    const s = findStrip(g, 200, 150)!;
    expect(s).not.toBeNull();
    expect(s.y0).toBe(0);
    expect(Math.abs(s.y1 - 75)).toBeLessThanOrEqual(2);
  });

  it('from the top (table above it) down past the end (table below it): followed all the way, never lost', () => {
    const ys = steps(-80, RH - 100, 6);
    const { pos, states } = run(rec, ys);
    expect(states).not.toContain('lost');
    // the strip starts at the receipt's top until it leaves the frame: what moved is from row 0 to the last frame's top
    const moved = ys.at(-1)! * PER_ROW;
    expect(Math.abs(pos - moved)).toBeLessThanOrEqual(moved * 0.02);
  });
});
