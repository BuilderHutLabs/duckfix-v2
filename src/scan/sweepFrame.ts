/**
 * "Paragon": the canvas side of the sweep. A small grey frame to follow the receipt with, a sharp
 * straightened frame kept on the way, and the kept frames put together into one tall JPEG.
 */
import { MAX_CANVAS_PIXELS } from '../export/rasterize';
import { STRIP_W, stripGeometry, type Strip } from './sweep';

/** Width the receipt is brought to in the result (px): sharp enough for print, light enough for a phone. */
const WIDTH = 1240;
/** Width of the small picture of a kept frame in the camera's strip (px). */
const THUMB_W = 48;

/** The live picture made small (`width` px wide) and grey, with how light it is on average. */
export function grabGray(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  width: number,
): { gray: Uint8ClampedArray; w: number; h: number; light: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const w = Math.min(width, vw);
  const h = Math.max(1, Math.round((vh * w) / vw));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx?.getImageData) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    gray[i] = v;
    sum += v;
  }
  return { gray, w, h, light: sum / gray.length };
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.9));
}

/** Widest a kept frame is cut (px): sharp enough for the 1240 px result, light on memory. */
const KEY_W = 1400;

/**
 * The live picture at full size, turned so the receipt stands straight and cut to it: its width and
 * the rows it takes (y0..y1, as unwarpStrip reads them). `strip` was found in a frame `smallW` px wide.
 */
export async function cutKey(video: HTMLVideoElement, strip: Strip, smallW: number): Promise<{ blob: Blob; thumb: string; width: number }> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const f = vw / smallW;
  const smallH = vh / f;
  const { tilt, cos, sin, yc, cx, paperW, t0, t1 } = stripGeometry(strip, smallH); // as unwarpStrip reads it
  const tm = (t0 + t1) / 2;
  const mx = (cx - tm * sin) * f;
  const my = (yc + tm * cos) * f;
  const scale = Math.min(1, KEY_W / (paperW * f));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(paperW * f * scale));
  c.height = Math.max(1, Math.round((t1 - t0) * f * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // the corners a turn leaves empty are paper, not black
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.scale(scale, scale);
  ctx.rotate(-tilt);
  ctx.drawImage(video, -mx, -my);
  const t = document.createElement('canvas');
  t.width = THUMB_W;
  t.height = Math.max(1, Math.round((c.height * THUMB_W) / c.width));
  t.getContext('2d')?.drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.6);
  t.width = 0;
  const width = c.width;
  const blob = await toBlob(c);
  c.width = 0; // free the picture memory at once (iOS)
  return { blob, thumb, width };
}

/**
 * The kept frames (top first) put together: from each, the rows `ranges` says (rows of the strip).
 * One frame is decoded at a time, and the result stays within the canvas limit (iOS).
 */
export async function composeSweep(cuts: { blob: Blob; width: number }[], ranges: { from: number; to: number }[]): Promise<Blob> {
  const rows = ranges.reduce((n, r) => n + Math.max(0, r.to - r.from), 0);
  // width × height = width² × rows / STRIP_W must stay under the canvas budget
  const fit = Math.floor(Math.sqrt((MAX_CANVAS_PIXELS * STRIP_W) / Math.max(1, rows)));
  const width = Math.max(1, Math.min(WIDTH, fit, ...cuts.map((c) => c.width)));
  const px = (n: number) => (n * width) / STRIP_W;
  const total = Math.max(1, Math.round(px(rows)));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = total;
  try {
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, total);
    let y = 0;
    for (const [i, cut] of cuts.entries()) {
      const r = ranges[i];
      const dh = px(Math.max(0, r.to - r.from));
      if (dh > 0) {
        const img = await createImageBitmap(cut.blob);
        try {
          const k = img.width / STRIP_W; // source px per strip row
          ctx.drawImage(img, 0, r.from * k, img.width, (r.to - r.from) * k, 0, Math.round(y), width, Math.round(y + dh) - Math.round(y));
        } finally {
          img.close();
        }
      }
      y += dh;
    }
    return await toBlob(c);
  } finally {
    c.width = 0;
  }
}
