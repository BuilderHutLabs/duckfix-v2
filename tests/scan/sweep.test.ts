import { findStrip, stripEdges } from '../../src/scan/sweep';
import { frameOf, makeReceipt } from './sweepFixture';

const RW = 200;
const RH = 900;
const rec = makeReceipt(RW, RH);
const frame = (o: Partial<Parameters<typeof frameOf>[3]> = {}) =>
  frameOf(rec, RW, RH, { y: 100, frameW: 200, frameH: 150, paperW: 120, noise: 6, ...o });

describe('Paragon: the receipt in the frame (for the outline and the hints)', () => {
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

  it('dense print whose strokes line up in one column does not split the receipt in two', () => {
    const same = makeReceipt(RW, RH, { repeatFrom: 150, repeatTo: 790, pitch: 10 });
    const s = findStrip(frameOf(same, RW, RH, { y: 200, frameW: 200, frameH: 150, paperW: 120, noise: 6 }), 200, 150)!;
    expect(Math.abs(s.topL - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(s.botL - 40)).toBeLessThanOrEqual(2);
  });

  it('the table above the receipt top: found, starting where the paper starts', () => {
    const g = frameOf(rec, RW, RH, { y: -40, frameW: 200, frameH: 150, paperW: 120, noise: 6 }); // top at frame row 24
    const s = findStrip(g, 200, 150)!;
    expect(Math.abs(s.y0 - 24)).toBeLessThanOrEqual(2);
    expect(s.y1).toBe(150);
    expect(Math.abs(s.topL - 40)).toBeLessThanOrEqual(2);
  });

  it('the receipt end in the middle of the frame: found, ending where the paper ends', () => {
    const g = frameOf(rec, RW, RH, { y: RH - 125, frameW: 200, frameH: 150, paperW: 120, noise: 6 }); // end at frame row 75
    const s = findStrip(g, 200, 150)!;
    expect(s.y0).toBe(0);
    expect(Math.abs(s.y1 - 75)).toBeLessThanOrEqual(2);
  });

  it('the outline runs along the edges, from the paper top to its end', () => {
    const e = stripEdges({ topL: 40, topR: 160, botL: 40, botR: 160, y0: 10, y1: 120 }, 150);
    expect(e.map((p) => [Math.round(p.x), p.y])).toEqual([
      [40, 10],
      [40, 120],
      [160, 120],
      [160, 10],
    ]);
  });
});
