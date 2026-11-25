import { releaseCanvas } from '../imaging/render';
import { toGray } from '../imaging/gray';
import { MAX_CANVAS_PIXELS } from '../export/rasterize';
import { detectQuad } from './detectQuad';
import { enhance, type ScanLook } from './enhance';
import { applyHomography, homography, warpSize, type Quad } from './quad';

/** A decoded camera photo: upright (EXIF applied) bitmap plus an object URL for display. */
export interface Photo {
  width: number;
  height: number;
  url: string;
  bitmap: ImageBitmap;
  close(): void;
}

/** Longest side of the copy the sheet is searched in. */
const DETECT_SIDE = 320;
/**
 * Working size of a camera photo (longest side). Phones shoot 12–50 MP; keeping that decoded
 * several times over (preview, detection, warp) ran Android out of memory. 2400 px is ~300 dpi on A4.
 */
export const WORK_SIDE = 2400;
/** The crop screen shows a small copy, not the original photo. */
const PREVIEW_SIDE = 1600;
/** Longest side of the source copy the warp samples from (iPad memory). */
const SOURCE_SIDE = 3200;
const JPEG_QUALITY = 0.85;

function canvas(w: number, h: number): HTMLCanvasElement {
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

async function decodeFull(file: Blob): Promise<ImageBitmap> {
  // e.g. HEIC where createImageBitmap cannot decode it but <img> can (Safari)
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Shrinks a bitmap whose longest side is over the working size; the big one is freed at once. */
async function shrink(bmp: ImageBitmap): Promise<ImageBitmap> {
  const long = Math.max(bmp.width, bmp.height);
  // resizeWidth fixes only the width, so a portrait photo may come back 2400×3200: that is fine
  if (long <= (WORK_SIDE * 4) / 3) return bmp;
  const k = WORK_SIDE / long;
  const c = canvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  try {
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await createImageBitmap(c);
  } finally {
    releaseCanvas(c);
  }
}

async function decode(file: Blob): Promise<ImageBitmap> {
  let bmp: ImageBitmap;
  try {
    // decode straight at the working size (Chrome/Android downsamples while decoding)
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: WORK_SIDE, resizeQuality: 'high' });
  } catch {
    bmp = await decodeFull(file);
  }
  return shrink(bmp);
}

async function previewUrl(bmp: ImageBitmap): Promise<string> {
  const k = Math.min(1, PREVIEW_SIDE / Math.max(bmp.width, bmp.height));
  const c = canvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  try {
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8),
    );
    return URL.createObjectURL(blob);
  } finally {
    releaseCanvas(c);
  }
}

export async function loadPhoto(file: Blob): Promise<Photo> {
  const bitmap = await decode(file);
  let url: string;
  try {
    url = await previewUrl(bitmap);
  } catch (e) {
    bitmap.close();
    throw e;
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    url,
    bitmap,
    close() {
      bitmap.close();
      URL.revokeObjectURL(url);
    },
  };
}

/** Sheet corners in photo pixels, searched in a ≤ 400 px grey copy; null when not found. */
export function findSheet(photo: Photo): Quad | null {
  const k = Math.min(1, DETECT_SIDE / Math.max(photo.width, photo.height));
  const c = canvas(Math.max(1, Math.round(photo.width * k)), Math.max(1, Math.round(photo.height * k)));
  try {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(photo.bitmap, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const q = detectQuad(toGray(px, c.width, c.height), px);
    return q && (q.map((p) => ({ x: p.x / k, y: p.y / k })) as Quad);
  } finally {
    releaseCanvas(c);
  }
}

/**
 * Straightens the sheet inside `q` (photo pixels) into an upright JPEG, at most `maxSide` px on its
 * long side, sampled from a copy at most `sourceSide` px (both within the canvas budget).
 */
export async function warpToBlob(
  photo: Photo,
  q: Quad,
  filter: ScanLook = 'whiten',
  maxSide = 2400,
  sourceSide = SOURCE_SIDE,
): Promise<Blob> {
  const { w, h } = warpSize(q, maxSide);
  // sample from a copy no larger than needed (and within the canvas budget)
  const k = Math.min(1, sourceSide / Math.max(photo.width, photo.height), Math.sqrt(MAX_CANVAS_PIXELS / 2 / (photo.width * photo.height)));
  const sw = Math.max(1, Math.round(photo.width * k));
  const sh = Math.max(1, Math.round(photo.height * k));
  const src = canvas(sw, sh);
  const out = canvas(w, h);
  try {
    const sctx = src.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(photo.bitmap, 0, 0, sw, sh);
    const s = sctx.getImageData(0, 0, sw, sh).data;
    releaseCanvas(src);

    const octx = out.getContext('2d')!;
    const o = octx.createImageData(w, h);
    // output pixel -> photo pixel (scaled copy)
    const rect: Quad = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const H = homography(rect, q.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = applyHomography(H, { x: x + 0.5, y: y + 0.5 });
        const fx = Math.min(sw - 1.001, Math.max(0, p.x - 0.5));
        const fy = Math.min(sh - 1.001, Math.max(0, p.y - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        const i00 = (y0 * sw + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + sw * 4;
        const i11 = i01 + 4;
        const di = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * ax;
          const bot = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * ax;
          o.data[di + c] = top + (bot - top) * ay;
        }
        o.data[di + 3] = 255;
      }
    }
    enhance(o.data, w, h, filter);
    octx.putImageData(o, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY),
    );
  } finally {
    releaseCanvas(src);
    releaseCanvas(out);
  }
}

/** Small straightened copy with the chosen look, for the crop screen preview (object URL). */
export async function warpPreview(photo: Photo, q: Quad, filter: ScanLook): Promise<string> {
  return URL.createObjectURL(await warpToBlob(photo, q, filter, 520));
}
