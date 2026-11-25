/**
 * "Paragon": the canvas side of the sweep. A small grey frame to follow the receipt with, a sharp
 * straightened frame kept on the way, and the kept frames put together into one tall JPEG.
 */
import { STRIP_W, stripTilt, type Strip } from './sweep';

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

/**
 * The live picture at full size, turned so the receipt stands straight and cut to its width (the
 * whole height of the frame). `strip` was found in a frame `smallW` px wide.
 */
export async function cutKey(video: HTMLVideoElement, strip: Strip, smallW: number): Promise<{ blob: Blob; thumb: string }> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const f = vw / smallW;
  const smallH = vh / f;
  const paperW = ((strip.topR - strip.topL + strip.botR - strip.botL) / 2) * f;
  const cx = ((strip.topL + strip.topR + strip.botL + strip.botR) / 4) * f;
  const tilt = stripTilt(strip, smallH);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(paperW));
  c.height = vh;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(-tilt);
  ctx.drawImage(video, -cx, -vh / 2);
  const t = document.createElement('canvas');
  t.width = THUMB_W;
  t.height = Math.max(1, Math.round((vh * THUMB_W) / c.width));
  t.getContext('2d')?.drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.6);
  t.width = 0;
  const blob = await toBlob(c);
  c.width = 0; // free the picture memory at once (iOS)
  return { blob, thumb };
}

/** The kept frames (top first) put together: from each, the rows `ranges` says (rows of the strip). */
export async function composeSweep(blobs: Blob[], ranges: { from: number; to: number }[]): Promise<Blob> {
  const imgs = await Promise.all(blobs.map((b) => createImageBitmap(b)));
  try {
    const width = Math.min(WIDTH, ...imgs.map((i) => i.width));
    const px = (rows: number) => (rows * width) / STRIP_W;
    const total = Math.max(1, Math.round(ranges.reduce((n, r) => n + px(r.to - r.from), 0)));
    const c = document.createElement('canvas');
    c.width = width;
    c.height = total;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, total);
    let y = 0;
    imgs.forEach((img, i) => {
      const r = ranges[i];
      const k = img.width / STRIP_W; // source px per strip row
      const sy = r.from * k;
      const sh = (r.to - r.from) * k;
      const dh = px(r.to - r.from);
      if (sh > 0) ctx.drawImage(img, 0, sy, img.width, sh, 0, Math.round(y), width, Math.round(y + dh) - Math.round(y));
      y += dh;
    });
    const out = await toBlob(c);
    c.width = 0;
    return out;
  } finally {
    imgs.forEach((i) => i.close());
  }
}
