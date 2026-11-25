import { createSweep, findStrip, rowFeatures, unwarpStrip, type SweepState } from '../../src/scan/sweep';
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

  it('the strip is brought to 96 columns, rows scaled alike', () => {
    const g = frame();
    const u = unwarpStrip(g, 200, 150, findStrip(g, 200, 150)!);
    expect(u.w).toBe(96);
    expect(Math.abs(u.h - (150 * 96) / 120)).toBeLessThanOrEqual(1);
    expect(u.data.length).toBe(u.w * u.h);
    // only paper and print in it, no table: the outer columns are paper
    for (const x of [0, 1, 94, 95]) {
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
/** Rows of the strip per row of the receipt: 96 columns for the receipt's RW. */
const PER_ROW = 96 / RW;

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
