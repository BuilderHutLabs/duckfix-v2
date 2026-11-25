import { findStrip, unwarpStrip } from '../../src/scan/sweep';
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
    // only paper and print in it, no table
    let dark = 0;
    for (const v of u.data) if (v > 60 && v < 80) dark++;
    expect(dark / u.data.length).toBeLessThan(0.05);
  });
});
