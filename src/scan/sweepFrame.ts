/**
 * "Paragon": the canvas side of the sweep. A small grey frame to follow the camera with, the frames
 * kept on the way, and the kept frames put together into one tall JPEG of the receipt.
 */
import { MAX_CANVAS_PIXELS } from '../export/rasterize';
import { paperBox, type layoutKeys, type TrackKey } from './track';

/** Width the receipt is brought to in the result (px): sharp enough for print, light enough for a phone. */
const WIDTH = 1240;
/** Width of the small picture of a kept frame in the camera's strip (px). */
const THUMB_W = 48;
/** Widest a kept frame is kept (px): sharp enough for the 1240 px result, light on memory. */
const KEY_W = 1400;

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

/** The live picture as it is now, at most KEY_W px wide, with a small picture of it. */
export async function cutKey(video: HTMLVideoElement): Promise<{ blob: Blob; thumb: string }> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, KEY_W / vw);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vw * scale));
  c.height = Math.max(1, Math.round(vh * scale));
  c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
  const t = document.createElement('canvas');
  t.width = THUMB_W;
  t.height = Math.max(1, Math.round((c.height * THUMB_W) / c.width));
  t.getContext('2d')?.drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.6);
  t.width = 0;
  const blob = await toBlob(c);
  c.width = 0; // free the picture memory at once (iOS)
  return { blob, thumb };
}

/**
 * The kept frames put together into the receipt's picture: each drawn where tracking placed it
 * (`keys[i].global`, in small-frame pixels of the first frame), only its band of rows, then cut to
 * the paper (the table around it left out). One frame is decoded at a time; within the canvas limit.
 */
export async function composeSweep(cuts: { blob: Blob }[], keys: TrackKey[], lay: ReturnType<typeof layoutKeys>): Promise<Blob> {
  const gw = Math.max(1, lay.right - lay.left);
  const gh = Math.max(1, lay.bottom - lay.top);
  // at most WIDTH wide, and within the canvas budget
  const S = Math.min(WIDTH / gw, Math.sqrt(MAX_CANVAS_PIXELS / (gw * gh)));
  const W = Math.max(1, Math.round(gw * S));
  const H = Math.max(1, Math.round(gh * S));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  try {
    const ctx = c.getContext('2d')!;
    // where no frame reaches stays table-grey (not paper-white): the paper is found without it
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
    for (const [i, cut] of cuts.entries()) {
      const k = keys[i];
      const band = lay.bands[i];
      if (!k || !band || band.to <= band.from) continue;
      const img = await createImageBitmap(cut.blob);
      try {
        const f = k.w / img.width; // small-frame px per picture px
        const g = k.global;
        const cx = k.w / 2;
        const cy = k.h / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, Math.floor((band.from - lay.top) * S), W, Math.ceil((band.to - band.from) * S) + 1);
        ctx.clip();
        // picture px → small frame (from its middle) → the receipt's picture → this canvas
        ctx.setTransform(
          S * g[0] * f,
          S * g[3] * f,
          S * g[1] * f,
          S * g[4] * f,
          S * (g[2] - g[0] * cx - g[1] * cy - lay.left),
          S * (g[5] - g[3] * cx - g[4] * cy - lay.top),
        );
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      } finally {
        img.close();
      }
    }
    const box = paperOf(c);
    if (!box) return await toBlob(c);
    const out = document.createElement('canvas');
    out.width = box.w;
    out.height = box.h;
    try {
      out.getContext('2d')!.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      return await toBlob(out);
    } finally {
      out.width = 0;
    }
  } finally {
    c.width = 0;
  }
}

/** Where the paper is in the put-together picture (found on a small grey copy), with a little margin. */
function paperOf(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const k = Math.min(1, 200 / c.width);
  const w = Math.max(1, Math.round(c.width * k));
  const h = Math.max(1, Math.round(c.height * k));
  const s = document.createElement('canvas');
  s.width = w;
  s.height = h;
  try {
    const ctx = s.getContext('2d', { willReadFrequently: true });
    if (!ctx?.getImageData) return null;
    ctx.drawImage(c, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    const b = paperBox(gray, w, h);
    if (!b) return null;
    const m = 2; // px of the small copy around the paper
    const x0 = Math.max(0, (b.x0 - m) / k);
    const y0 = Math.max(0, (b.y0 - m) / k);
    const x1 = Math.min(c.width, (b.x1 + m) / k);
    const y1 = Math.min(c.height, (b.y1 + m) / k);
    return { x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(x1 - x0)), h: Math.max(1, Math.round(y1 - y0)) };
  } finally {
    s.width = 0;
  }
}
