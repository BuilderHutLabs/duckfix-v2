import { useEffect, useRef, useState, type RefObject } from 'react';
import { findStrip, stripEdges } from '../scan/sweep';
import { createTracker, layoutKeys, prepare, type SweepState, type TrackKey } from '../scan/track';
import { composeSweep, cutKey, grabGray } from '../scan/sweepFrame';
import type { Pt } from '../scan/quad';
import { quadToView } from '../scan/liveScan';
import { isWeakDevice } from './device';
import { strings } from './strings';

/** Width of the small frame the receipt is followed in (px); narrower on a slow phone. */
const GRAB_W = 240;
const GRAB_W_WEAK = 160;
/** Most frames kept for one receipt (memory): then the recording ends by itself. */
export const MAX_KEYS = 30;
/** Below this average light the picture is too dark to follow. */
const DARK = 55;

/** One look takes `ms`; the next comes after twice that, but at least 4 times a second. */
export function sweepDelay(ms: number): number {
  return Math.round(Math.min(250, Math.max(60, ms * 2)));
}

/** A kept frame being cut; a failure is handled where the frames are put together. */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

function safeGrab(v: HTMLVideoElement, canvas: HTMLCanvasElement, side: number): ReturnType<typeof grabGray> {
  try {
    return grabGray(v, canvas, side);
  } catch {
    return null;
  }
}

/** A receipt finished: the put-together picture (written in the background) and a small picture of it. */
export type SweepResult = { file: Promise<File | null>; thumb: string };

/**
 * "Paragon" in the camera: while `enabled`, the picture is looked at a few times a second; after
 * `start` the camera is followed over the receipt (like a panorama) and sharp frames are kept on the
 * way; `stop` (or too many frames) puts them together and hands the result to `onFinished`.
 */
export function useReceiptSweep(video: RefObject<HTMLVideoElement>, enabled: boolean, onFinished: (r: SweepResult) => void) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');
  const [warn, setWarn] = useState(false);
  const [edges, setEdges] = useState<Pt[] | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');

  const rec = useRef<{
    tracker: ReturnType<typeof createTracker>;
    keys: (TrackKey & { pos: number })[];
    cuts: Promise<{ blob: Blob }>[];
    thumbs: string[];
    state: SweepState;
  } | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  /** The small canvas the looks are drawn on (also used by the last look at "Stop"). */
  const lookCanvas = useRef<HTMLCanvasElement | null>(null);

  /** Ends the recording; the kept frames are put together in the background. */
  const stop = () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setRecording(false);
    setThumbs([]);
    // the bottom of the receipt: one more look right now, kept when it is followed well and shows more
    // (never a frame from an earlier look: the phone has moved since)
    const v = video.current;
    const lastKept = r.keys.at(-1);
    const g = v && lookCanvas.current ? safeGrab(v, lookCanvas.current, isWeakDevice() ? GRAB_W_WEAK : GRAB_W) : null;
    if (v && g && lastKept) {
      const out = r.tracker.push(prepare(g.gray, g.w, g.h));
      if ((out.state === 'moving' || out.state === 'fast') && out.pos - lastKept.pos > 2) {
        r.keys.push({ global: out.global, w: g.w, h: g.h, pos: out.pos });
        const cut = cutKey(v);
        r.cuts.push(quiet(cut));
        void cut.then((c) => r.thumbs.push(c.thumb)).catch(() => {});
      }
    }
    const thumb = r.thumbs.at(-1) ?? '';
    const file = !r.keys.length
      ? Promise.resolve(null)
      : Promise.all(r.cuts)
          .then((cuts) => composeSweep(cuts, r.keys, layoutKeys(r.keys)))
          .then((b) => new File([b], `paragon-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }))
          .catch(() => {
            setNotice(strings.sweepFailed);
            return null;
          });
    finishedRef.current({ file, thumb });
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = () => {
    if (rec.current) return;
    rec.current = { tracker: createTracker(), keys: [], cuts: [], thumbs: [], state: 'moving' };
    setRecording(true);
    setSeconds(0);
    setThumbs([]);
    setNotice('');
  };

  // "too long, stopped" or "could not put it together" stays a few seconds
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // the recording's clock
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // the camera left "Paragon" (or closed) while recording: nothing is kept
  useEffect(() => {
    if (!enabled) {
      rec.current = null;
      setRecording(false);
      setEdges(null);
      setHint('');
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = document.createElement('canvas');
    lookCanvas.current = canvas;
    const side = isWeakDevice() ? GRAB_W_WEAK : GRAB_W;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string, bad = false) => {
      setHint(text);
      setWarn(bad);
    };
    const tick = () => {
      const t0 = performance.now();
      look();
      if (alive) t = setTimeout(tick, sweepDelay(performance.now() - t0));
    };
    const look = () => {
      const v = video.current;
      if (!v) return;
      const g = safeGrab(v, canvas, side);
      if (!g) return;
      const strip = findStrip(g.gray, g.w, g.h);
      setEdges(strip ? quadToView(stripEdges(strip, g.h), g.w, g.h, v.clientWidth, v.clientHeight) : null);
      const r = rec.current;
      if (g.light < DARK) return say(strings.sweepDark, true);
      if (!r) return say(strings.sweepStart);
      const pic = prepare(g.gray, g.w, g.h);
      const out = r.tracker.push(pic);
      if (out.state === 'fast' && r.state !== 'fast') navigator.vibrate?.(30);
      r.state = out.state;
      if (out.state === 'fast') say(strings.sweepFast, true);
      else if (out.state === 'lost') say(strings.sweepLost, true);
      else if (strip && strip.y1 < g.h * 0.85)
        say(strings.sweepEnd); // the receipt's end is in view
      else say(strings.sweepMove);
      if (!out.capture) return;
      r.tracker.captured(pic, out.global);
      r.keys.push({ global: out.global, w: g.w, h: g.h, pos: out.pos });
      const cut = cutKey(v);
      r.cuts.push(quiet(cut));
      void cut
        .then((c) => {
          r.thumbs.push(c.thumb);
          if (rec.current === r) setThumbs([...r.thumbs]);
        })
        .catch(() => {});
      if (r.keys.length >= MAX_KEYS) {
        setNotice(strings.sweepFull);
        stopRef.current();
      }
    };
    t = setTimeout(tick, 0);
    return () => {
      alive = false;
      clearTimeout(t);
      canvas.width = 0;
      if (lookCanvas.current === canvas) lookCanvas.current = null;
    };
  }, [enabled, video]);

  return { recording, start, stop, hint: notice || hint, warn: warn && !notice, edges, thumbs, seconds };
}
