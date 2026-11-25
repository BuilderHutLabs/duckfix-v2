import { createTracker, layoutKeys, paperBox, prepare, type TrackKey } from '../../src/scan/track';
import { frameOf, joinedReceipts, makeReceipt, type FrameOpts } from './sweepFixture';

const RW = 200;
const RH = 1200;
const FW = 160;
const FH = 240;
/** Frame px per receipt row with the receipt 100 px wide in the frame (paperW / RW). */
const PER_ROW = 100 / RW;

type Opts = Partial<FrameOpts>;
const frame = (rec: Uint8ClampedArray, y: number, o: Opts = {}) =>
  frameOf(rec, RW, RH, { y, frameW: FW, frameH: FH, paperW: 100, noise: 6, seed: y * 7 + 1, ...o });

/** Runs the tracker over frames at receipt rows ys; returns the last pos, the states, the kept frames. */
function run(rec: Uint8ClampedArray, ys: number[], o: (y: number) => Opts = () => ({})) {
  const tr = createTracker();
  let pos = 0;
  const states: string[] = [];
  const keys: (TrackKey & { y: number })[] = [];
  for (const y of ys) {
    const p = prepare(frame(rec, y, o(y)), FW, FH);
    const out = tr.push(p);
    pos = out.pos;
    states.push(out.state);
    if (out.capture) {
      tr.captured(p, out.global);
      keys.push({ global: out.global, w: FW, h: FH, y });
    }
  }
  return { pos, states, keys };
}
const steps = (from: number, to: number, by: number) => Array.from({ length: Math.floor((to - from) / by) + 1 }, (_, i) => from + i * by);
const rec = makeReceipt(RW, RH);

describe('Paragon tracker: following the camera like a panorama', () => {
  it('a steady sweep: how far it went, never lost', () => {
    const { pos, states } = run(rec, steps(0, 700, 8));
    expect(states).not.toContain('lost');
    expect(Math.abs(pos - 700 * PER_ROW)).toBeLessThanOrEqual(700 * PER_ROW * 0.02);
  });

  it('a hand that sways left and right (±12 px) and turns a little: still followed', () => {
    const { pos, states } = run(rec, steps(0, 700, 8), (y) => ({ dx: 12 * Math.sin(y / 40), tiltDeg: 1.5 * Math.sin(y / 90) }));
    expect(states).not.toContain('lost');
    expect(Math.abs(pos - 700 * PER_ROW)).toBeLessThanOrEqual(700 * PER_ROW * 0.03);
  });

  it('the phone comes closer and goes back (receipt 92..108 px wide): still followed, each kept frame at its size', () => {
    const width = (y: number) => 100 + 8 * Math.sin(y / 120);
    const { states, keys } = run(rec, steps(0, 700, 8), (y) => ({ paperW: width(y) }));
    expect(states).not.toContain('lost');
    // a kept frame's size against the first one follows the phone's distance
    const scale = (k: TrackKey) => Math.hypot(k.global[0], k.global[3]);
    for (const k of keys) expect(Math.abs(scale(k) - width(0) / width(k.y))).toBeLessThan(0.02);
  });

  it('two receipts of different widths one under the other, table between them: never lost', () => {
    const { pos, states } = run(joinedReceipts(RW, RH), steps(0, 700, 8), (y) => ({ dx: 8 * Math.sin(y / 50) }));
    expect(states).not.toContain('lost');
    expect(Math.abs(pos - 700 * PER_ROW)).toBeLessThanOrEqual(700 * PER_ROW * 0.03);
  });

  it('frames are kept at the start and then about every 45% of the frame', () => {
    const { keys } = run(rec, steps(0, 700, 8));
    expect(keys[0].y).toBe(0);
    const gap = (0.45 * FH) / PER_ROW; // receipt rows
    for (const [i, k] of keys.slice(1).entries()) expect(Math.abs(k.y - keys[i].y - gap)).toBeLessThanOrEqual(16);
  });

  it('a jump far beyond the last kept frame: lost after three frames; back near it, it goes on', () => {
    const tr = createTracker();
    const at = (y: number) => prepare(frame(rec, y), FW, FH);
    const f0 = at(100);
    tr.captured(f0, tr.push(f0).global);
    tr.push(at(108));
    const far = [960, 965, 970].map((y) => tr.push(at(y)).state);
    expect(far.at(-1)).toBe('lost');
    const back = tr.push(at(116));
    expect(back.state).not.toBe('lost');
    expect(Math.abs(back.pos - 16 * PER_ROW)).toBeLessThanOrEqual(2);
  });

  it('blank paper fills the frame: "blank", not lost, nothing moves', () => {
    const tr = createTracker();
    const f0 = prepare(frame(rec, 100), FW, FH);
    tr.captured(f0, tr.push(f0).global);
    const out = tr.push(prepare(new Uint8ClampedArray(FW * FH).fill(240), FW, FH));
    expect(out.state).toBe('blank');
    expect(out.pos).toBe(0);
  });

  it('a quick blurred step past the keeping point keeps no frame; the next steady one is kept', () => {
    const tr = createTracker();
    const at = (y: number) => prepare(frame(rec, y), FW, FH);
    const f0 = at(0);
    tr.captured(f0, tr.push(f0).global);
    tr.push(at(60));
    const fast = tr.push(at(230)); // to 0.48 of the frame at once
    expect(fast.state).toBe('fast');
    expect(fast.capture).toBe(false);
    expect(tr.push(at(236)).capture).toBe(true);
  });
});

describe('Paragon tracker: the kept frames in one picture', () => {
  it('neighbours meet without overlap or gap; the picture is as wide as all that was filmed', () => {
    const { keys } = run(rec, steps(0, 700, 8), (y) => ({ dx: 10 * Math.sin(y / 40) }));
    const lay = layoutKeys(keys);
    for (let i = 1; i < lay.bands.length; i++) expect(lay.bands[i].from).toBeCloseTo(lay.bands[i - 1].to, 6);
    // from the first frame's top to the last kept frame's bottom
    expect(Math.abs(lay.bottom - lay.top - (keys.at(-1)!.y * PER_ROW + FH))).toBeLessThanOrEqual(FH * 0.03);
    // the hand swayed: nothing filmed is cut off at the sides
    expect(lay.right - lay.left).toBeGreaterThan(FW + 5);
  });

  it('the paper in the put-together picture: the table around it is left out', () => {
    const w = 200;
    const h = 300;
    const g = new Uint8ClampedArray(w * h).fill(90); // table
    for (let y = 40; y < 280; y++) for (let x = 50; x < 150; x++) g[y * w + x] = (x + y) % 9 ? 235 : 60; // paper with print
    const b = paperBox(g, w, h)!;
    expect(Math.abs(b.x0 - 50)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.x1 - 150)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.y0 - 40)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.y1 - 280)).toBeLessThanOrEqual(3);
  });

  it('no paper to be seen: the whole picture is kept', () => {
    expect(paperBox(new Uint8ClampedArray(100 * 100).fill(90), 100, 100)).toBeNull();
  });
});
