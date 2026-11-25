import type { ScanFilter } from '../scan/enhance';
import { storageKey } from '../config';
import { currentLanguage, formatSize, type Lang } from '../i18n';
import { createOcrEngine, type OcrEngine } from '../export/ocr';
import { exportImages } from '../export/images';
import { pageLines, pageText } from '../export/pageText';
import { watermarkLine, watermarkPng } from '../export/watermark';
import { findPersonal, type OcrLine } from '../edit/personal';
import { SIZE_LIMIT, SIZE_START, loadExportOptions, saveExportOptions, type ExportOptions } from '../export/options';
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import {
  applyAnalysis,
  deletePages,
  insertPages,
  movePage,
  rotatePages,
  setPageFilter,
  addStamp as addStampTo,
  moveStamp as moveStampOn,
  removeStamp as removeStampFrom,
  addMark as addMarkTo,
  updateMark as updateMarkOn,
  removeMark as removeMarkFrom,
  removeMarks as removeMarksFrom,
  copyMarkToPages,
  copyStampToPages,
  setCrop as setCropOn,
  type Stamp,
  type Mark,
  type MarkPatch,
  type Box,
  type Doc,
  type Page,
} from '../model/document';
import { createHistory, type History } from '../model/history';
import { importFiles, type SourceFile } from '../import/importFiles';
import { ImportError } from '../import/errors';
import { forgetPdf, releaseCanvas, renderPage } from '../imaging/render';
import { ANALYSIS_MAX_SIDE, analyzePages, canvasToGrayImage, type PageAnalysis } from '../pipeline/analyze';
import { createTesseractDetector, tesseractPaths } from '../orientation/tesseract';
import type { OrientationDetector } from '../orientation/detector';
import { DEFAULT_THRESHOLDS } from '../orientation/policy';
import { exportFileName, exportPdf } from '../export/exportPdf';
import { MAX_LEVEL, browserRasterizer } from '../export/rasterize';
import { canShareFiles, downloadFile, pdfFile, prefersShareSheet, shareOrDownload } from '../export/share';
import { createMetrics } from '../diagnostics/metrics';
import { docNameFrom, indexedDbLibrary, sizeOf, type DocLibrary, type DocMeta } from '../storage/library';
import { docThumbnail } from '../storage/docThumb';
import { strings } from './strings';

export type Phase = 'home' | 'analyzing' | 'review';

export interface AppState {
  phase: Phase;
  doc: Doc;
  sources: Map<string, SourceFile>;
  progress: { done: number; total: number };
  selection: Set<string>;
  selecting: boolean;
  filterFlagged: boolean;
  /** Page shown in the full-screen preview. */
  previewId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  busy: 'opening' | 'exporting' | null;
  /** Pages written so far while exporting. */
  /** `shrink`: the file came out too big and is being saved again smaller. */
  exportProgress: { done: number; total: number; ocr: boolean; shrink?: boolean } | null;
  /** Exported PDF waiting for the user's tap on "Udostępnij / Zapisz". */
  exportReady: File | File[] | null;
  /** The ready file came from "Wyślij" (the button says so); else from saving on iPhone/iPad. */
  exportSend: boolean;
  /** "Wyślij" is offered (the phone's share menu takes files). */
  canShareFiles: boolean;
  /** "Zapisz PDF" opened the save options sheet. */
  saveSheetOpen: boolean;
  /** Pages the save sheet saves (select mode); null = the whole document. */
  saveSheetIds: string[] | null;
  /** Camera photo waiting on the crop screen. */
  scanPhoto: File | null;
  /** More camera photos waiting for the crop screen after this one (several pages in a row). */
  scanQueue: File[];
  /** How many photos this crop round has in all (for "Zdjęcie 2 z 3"). */
  scanTotal: number;
  /** Photos of the round that are the front and back of a card ("Dowód"): together they become one page. */
  scanCardFiles: File[];
  /** Pages the "Wygląd stron" sheet applies to (open while set). */
  filterSheetIds: string[] | null;
  /** Where the cropped photo goes: a page index, or null for the end / a new document. */
  scanIndex: number | null;
  /** Last choices in the save sheet (remembered). */
  exportOptions: ExportOptions;
  error: string | null;
  /** Short confirmation, e.g. where the saved file went. */
  notice: string | null;
  deskew: boolean;
  /** A document from an earlier visit is stored and can be restored (shown on Home). */
  restorable: boolean;
  /** "Moje dokumenty": every document kept on this phone, newest first. */
  library: DocMeta[];
  /** The "Moje dokumenty" list is open. */
  docsOpen: boolean;
  diagnostics: boolean;
  /** The text recognition is still getting ready (the first analysis waits for it). */
  preparing: boolean;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface StoreDeps {
  importFiles(files: File[]): Promise<{ sources: SourceFile[]; pages: Page[] }>;
  analyzePages: typeof analyzePages;
  createDetector(): Promise<OrientationDetector>;
  exportPdf(
    doc: Doc,
    sources: Map<string, SourceFile>,
    onProgress: (done: number, total: number) => void,
    /** `compress`: quality level, 0 = full quality. */
    opts: { compress: number; ocr: OcrEngine | null; signal: AbortSignal; watermark?: string },
  ): Promise<Uint8Array>;
  /** "JPG": every page as a JPEG picture. */
  exportImages(
    doc: Doc,
    sources: Map<string, SourceFile>,
    onProgress: (done: number, total: number) => void,
    opts: { compress: number; signal: AbortSignal; watermark?: string },
  ): Promise<Blob[]>;
  /** Text of one page (own text layer or OCR). */
  pageText(page: Page, source: SourceFile, ocr: () => Promise<OcrEngine>): Promise<string>;
  /** Lines of words of a page as saved, boxes as fractions of that picture ("Ukryj dane osobowe"). */
  pageLines(page: Page, source: SourceFile, ocr: () => Promise<OcrEngine>): Promise<OcrLine[]>;
  copyText(text: string): Promise<void>;
  /** OCR engine for "Tekst do wyszukiwania" in the given language (may download deu/spa data). */
  createOcr(lang: Lang): Promise<OcrEngine>;
  share: typeof shareOrDownload;
  /** Plain download of the exported file (Windows, Android, Mac). */
  download(file: File): void;
  /** iPhone/iPad: save through the share sheet on a separate tap instead of a download. */
  shareFirst: boolean;
  /** The phone's share menu takes files ("Wyślij" in the save sheet). */
  canShareFiles: boolean;
  /** Locks a finished PDF with a password. */
  encryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array>;
  forgetPdf(fileId: string): Promise<void>;
  storage: StorageLike | null;
  /** "Moje dokumenty": where documents are kept. */
  library: DocLibrary | null;
  /** Small picture of a page for the list. */
  docThumb(page: Page, source: SourceFile): Promise<string | null>;
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserDeps(): StoreDeps {
  return {
    importFiles,
    analyzePages,
    createDetector: () => createTesseractDetector({ basePath: import.meta.env.BASE_URL, workers: 2 }),
    exportPdf: async (doc, sources, onProgress, opts) =>
      exportPdf(doc, sources, browserRasterizer, onProgress, {
        compress: opts.compress,
        ocr: opts.ocr ?? undefined,
        signal: opts.signal,
        watermark: opts.watermark ? await watermarkPng(opts.watermark) : undefined,
      }),
    exportImages: (doc, sources, onProgress, opts) => exportImages(doc, sources, browserRasterizer, onProgress, opts),
    pageText: (page, source, ocr) => pageText(page, source, browserRasterizer, ocr),
    pageLines: (page, source, ocr) => pageLines(page, source, browserRasterizer, ocr),
    copyText: (text) => navigator.clipboard.writeText(text),
    createOcr: (lang) => createOcrEngine(lang, tesseractPaths(import.meta.env.BASE_URL)),
    share: shareOrDownload,
    download: downloadFile,
    shareFirst: prefersShareSheet(),
    canShareFiles: canShareFiles(),
    encryptPdf: (bytes, password) => import('../export/encrypt').then((m) => m.encryptPdf(bytes, password)),
    forgetPdf,
    storage: browserStorage(),
    library: indexedDbLibrary,
    docThumb: docThumbnail,
  };
}

const DESKEW_KEY = storageKey('wduck.deskew');
const ANALYZE = { concurrency: 2, maxSide: ANALYSIS_MAX_SIDE } as const;
const SAVE_DOC_DELAY_MS = 500;
/** Names of the files downloaded so far (so a repeat gets " (2)" instead of the phone's question). */
const DOWNLOADED_KEY = storageKey('duckfix-downloaded');
/** While changes keep coming (analysis progress), the doc is still saved at least this often. */
const SAVE_DOC_MAX_WAIT_MS = 2500;

/**
 * Applies an analysis result to one history state. Unanalyzed pages start at rotation 0 and only
 * user actions change it, so a non-zero rotation means the user already turned the page: keep it
 * and drop 'check-orientation' (the user's tap settled it), but still record
 * autoRotation/skew/other flags/analyzed.
 */
export function mergeAnalysis(doc: Doc, a: PageAnalysis): Doc {
  const page = doc.pages.find((p) => p.id === a.pageId);
  if (!page || page.analyzed) return doc;
  const userRotated = page.rotation !== 0;
  const next = applyAnalysis(doc, a.pageId, a);
  if (!userRotated) return next;
  return {
    pages: next.pages.map((p) =>
      p.id === a.pageId ? { ...p, rotation: page.rotation, flags: p.flags.filter((f) => f !== 'check-orientation') } : p,
    ),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof ImportError ? strings.errors[e.code] : strings.genericError;
}

/** One opened document; replaced on open/goHome so late async work can tell it is stale. */
interface Session {
  controller: AbortController;
  runs: number;
}

export function createAppStore(overrides: Partial<StoreDeps> = {}) {
  const deps: StoreDeps = { ...browserDeps(), ...overrides };
  const listeners = new Set<() => void>();
  let history: History<Doc> = createHistory<Doc>({ pages: [] });
  let session: Session = { controller: new AbortController(), runs: 0 };
  let detector: Promise<OrientationDetector> | null = null;
  let metrics = createMetrics();
  /** The open document's place in "Moje dokumenty" (null on Home). */
  let docId: string | null = null;
  /** Last doc handed to session storage, and the pending debounced save. */
  let persistedDoc: Doc = history.present;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The doc `state.exportReady` was built from; any other doc makes the file stale. */
  let exportedDoc: Doc | null = null;
  /** Aborts the running export ("Anuluj"). */
  let exportCtrl: AbortController | null = null;
  /** Straightened camera pages are added one after another, in the order they were taken. */
  let scanChain: Promise<void> = Promise.resolve();
  /** OCR engine, created on the first searchable export and kept for the open document. */
  let ocr: { lang: Lang; engine: Promise<OcrEngine> } | null = null;
  const disposeOcr = () => {
    const old = ocr;
    ocr = null;
    void old?.engine.then((e) => e.dispose()).catch(() => {});
  };
  const getOcr = (): Promise<OcrEngine> => {
    const lang = currentLanguage();
    if (ocr?.lang !== lang) {
      disposeOcr();
      const engine = deps.createOcr(lang);
      // a failed start (offline, first deu/spa download) is retried on the next export
      engine.catch(() => {
        if (ocr?.engine === engine) ocr = null;
      });
      ocr = { lang, engine };
    }
    return ocr.engine;
  };
  /** When the oldest unsaved change was scheduled (start of the max-wait window). */
  let savePendingSince: number | null = null;

  const readDeskew = (): boolean => {
    try {
      return deps.storage?.getItem(DESKEW_KEY) !== '0';
    } catch {
      return true;
    }
  };

  let state: AppState = {
    phase: 'home',
    doc: history.present,
    sources: new Map(),
    progress: { done: 0, total: 0 },
    selection: new Set(),
    selecting: false,
    filterFlagged: false,
    previewId: null,
    canUndo: false,
    canRedo: false,
    busy: null,
    exportProgress: null,
    exportReady: null,
    exportSend: false,
    canShareFiles: deps.canShareFiles,
    saveSheetOpen: false,
    saveSheetIds: null,
    scanPhoto: null,
    scanQueue: [],
    scanTotal: 0,
    scanCardFiles: [],
    filterSheetIds: null,
    scanIndex: null,
    exportOptions: loadExportOptions(deps.storage),
    notice: null,
    error: null,
    deskew: readDeskew(),
    restorable: false,
    library: [],
    docsOpen: false,
    diagnostics: false,
    preparing: false,
  };

  const cancelDocSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    savePendingSince = null;
  };

  /** Reads the list of kept documents again (after a change, on Home). */
  const refreshLibrary = () => {
    const asked = libraryChanges;
    return deps.library?.list().then(
      (list) => {
        if (asked === libraryChanges) set({ library: list, restorable: list.length > 0 }); // else a newer change is shown
      },
      () => {},
    );
  };
  /** Counts renames and deletions, so a list read before one of them is not shown after it. */
  let libraryChanges = 0;

  /** Makes the small picture of the first page for the list (in the background). */
  const updateThumb = (id: string, doc: Doc, sources: Map<string, SourceFile>) => {
    const first = doc.pages[0];
    const src = first && sources.get(first.source.fileId);
    if (!first || !src || !deps.library) return;
    const lib = deps.library;
    void deps
      .docThumb(first, src)
      .then((thumb) => (thumb ? lib.patch(id, { thumb }) : undefined))
      .then(() => (state.phase === 'home' ? refreshLibrary() : undefined))
      .catch(() => {})
      .finally(() => {
        // the document was closed meanwhile: let go of its PDF again
        if (docId !== id) void deps.forgetPdf(src.id).catch(() => {});
      });
  };

  /** Documents kept without a small picture (from an earlier version) get one, one at a time. */
  let filling = false;
  const fillThumbs = async () => {
    const lib = deps.library;
    if (filling || !lib) return;
    filling = true;
    try {
      for (const m of state.library.filter((x) => !x.thumb).slice(0, 10)) {
        const s = await lib.load(m.id);
        const first = s?.doc.pages[0];
        const src = first && s.sources.find((f) => f.id === first.source.fileId);
        if (!first || !src) continue;
        const thumb = await deps.docThumb(first, src);
        if (src.id && docId !== m.id && !state.sources.has(src.id)) void deps.forgetPdf(src.id).catch(() => {});
        if (!thumb) continue;
        await lib.patch(m.id, { thumb });
        set({ library: state.library.map((x) => (x.id === m.id ? { ...x, thumb } : x)) });
      }
    } catch {
      /* no picture: the page icon stays */
    } finally {
      filling = false;
    }
  };

  const saveDocNow = () => {
    cancelDocSave();
    persistedDoc = history.present;
    if (docId) void deps.library?.saveDoc(docId, persistedDoc, { updatedAt: Date.now(), pages: persistedDoc.pages.length });
  };

  /** Stores the doc 500 ms after the last change (but at most 2.5 s after the first unsaved one), while a document is open. */
  const scheduleDocSave = () => {
    if (!deps.library || !docId || state.sources.size === 0 || history.present === persistedDoc) return;
    const now = Date.now();
    const since = savePendingSince ?? now;
    cancelDocSave();
    savePendingSince = since;
    const delay = Math.max(0, Math.min(SAVE_DOC_DELAY_MS, since + SAVE_DOC_MAX_WAIT_MS - now));
    saveTimer = setTimeout(saveDocNow, delay);
  };

  /** Stores doc + sources at once (a new document, or the source set changed). */
  const saveAll = () => {
    cancelDocSave();
    persistedDoc = history.present;
    if (!docId || !deps.library) return;
    const sources = [...state.sources.values()];
    const s = { doc: persistedDoc, sources };
    const known = state.library.find((m) => m.id === docId);
    const meta: DocMeta = {
      id: docId,
      name: known?.name ?? docName ?? docNameFrom(sources[0]?.name ?? strings.defaultDocName),
      updatedAt: Date.now(),
      pages: persistedDoc.pages.length,
      size: sizeOf(s),
      thumb: known?.thumb ?? null,
    };
    docName = meta.name;
    void deps.library.save(meta, s).then(() => updateThumb(meta.id, s.doc, state.sources));
  };
  /** The open document's name in the list. */
  let docName: string | null = null;

  /**
   * Downloads the files under names not downloaded before: a phone asks "Download again?" for a
   * name already in Pobrane and drops the file unless the user says yes. The names used are
   * remembered; a repeat gets " (2)", " (3)"… like the phone itself would after asking.
   */
  const downloadAll = (files: File[]): File[] => {
    let used: string[] = [];
    try {
      used = JSON.parse(deps.storage?.getItem(DOWNLOADED_KEY) ?? '[]') as string[];
      if (!Array.isArray(used)) used = [];
    } catch {
      used = [];
    }
    const taken = new Set(used.map((n) => n.toLowerCase()));
    const out = files.map((f) => {
      const dot = f.name.lastIndexOf('.');
      const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
      const ext = dot > 0 ? f.name.slice(dot) : '';
      let name = f.name;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
      taken.add(name.toLowerCase());
      used.push(name);
      return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
    });
    try {
      deps.storage?.setItem(DOWNLOADED_KEY, JSON.stringify(used.slice(-300)));
    } catch {
      /* private mode: names are not remembered */
    }
    out.forEach((f) => deps.download(f));
    return out;
  };

  /** Publishes a new snapshot; doc/canUndo/canRedo always come from the history. */
  const set = (patch: Partial<AppState>) => {
    const next = { ...state, ...patch };
    if (next.exportReady && history.present !== exportedDoc) next.exportReady = null; // doc changed since export
    state = {
      ...next,
      doc: history.present,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    };
    scheduleDocSave();
    listeners.forEach((l) => l());
  };

  /** The recognition engine is loaded (no waiting before the next analysis). */
  let detectorReady = false;
  const getDetector = (): Promise<OrientationDetector> => {
    detector ??= deps.createDetector().then(
      (d) => {
        detectorReady = true;
        return d;
      },
      (e) => {
        detector = null; // allow a retry on the next document
        throw e;
      },
    );
    return detector;
  };

  const getSource = (fileId: string): SourceFile => {
    const s = state.sources.get(fileId);
    if (!s) throw new Error(`Missing source file ${fileId}`);
    return s;
  };

  const runAnalysis = async (pages: Page[]) => {
    const todo = pages.filter((p) => !p.analyzed);
    if (todo.length === 0) return;
    const own = session;
    const { signal } = own.controller;
    const current = () => own === session && !signal.aborted;
    own.runs++;
    set({
      phase: 'analyzing',
      progress: { done: state.progress.done, total: state.progress.total + todo.length },
    });
    try {
      if (!detectorReady) set({ preparing: true }); // "Przygotowuję rozpoznawanie…" instead of a stuck 0/N
      const det = await getDetector().finally(() => {
        if (state.preparing) set({ preparing: false });
      });
      if (!current()) return;
      await deps.analyzePages(
        todo,
        {
          render: renderPage,
          release: releaseCanvas,
          detector: det,
          thresholds: DEFAULT_THRESHOLDS,
          getSource,
          toGrayImage: canvasToGrayImage,
        },
        (a) => {
          if (!current()) return;
          metrics.record(a);
          history.mapAll((d) => mergeAnalysis(d, a));
          set({ progress: { ...state.progress, done: state.progress.done + 1 } });
        },
        { ...ANALYZE, deskew: state.deskew, signal },
      );
    } catch {
      if (current()) set({ error: strings.analysisError });
    } finally {
      own.runs--;
      if (own === session && own.runs === 0 && state.phase === 'analyzing') set({ phase: 'review' });
    }
  };

  const closeSession = () => {
    disposeOcr();
    session.controller.abort();
    session = { controller: new AbortController(), runs: 0 };
    for (const id of state.sources.keys()) void deps.forgetPdf(id).catch(() => {});
  };

  /** Pushes a user action onto the undo history (no-op when nothing changed). */
  const commit = (next: Doc, patch: Partial<AppState> = {}) => {
    if (next.pages === history.present.pages) return;
    history.push(next);
    set(patch);
  };

  const existing = (ids: Iterable<string>) => {
    const present = new Set(history.present.pages.map((p) => p.id));
    return [...ids].filter((id) => present.has(id));
  };

  const actions = {
    /** Shows a document right away and analyzes its unanalyzed pages in the background. */
    load(doc: Doc, sources: SourceFile[]) {
      closeSession();
      history = createHistory(doc);
      persistedDoc = doc;
      metrics = createMetrics();
      set({
        phase: 'review',
        sources: new Map(sources.map((s) => [s.id, s])),
        progress: { done: 0, total: 0 },
        selection: new Set(),
        selecting: false,
        filterFlagged: false,
        previewId: null,
        busy: null,
        exportProgress: null,
        restorable: false,
      });
      void runAnalysis(doc.pages);
    },

    async open(files: File[]) {
      if (files.length === 0 || state.busy) return;
      // The stored document is only replaced once the import succeeded (saveAll overwrites it).
      set({ busy: 'opening', error: null, docsOpen: false });
      try {
        const { sources, pages } = await deps.importFiles(files);
        actions.load({ pages }, sources);
        docId = crypto.randomUUID();
        docName = null;
        saveAll();
      } catch (e) {
        set({ busy: null, error: errorMessage(e) });
      }
    },

    /** Closes the document; it stays in "Moje dokumenty". */
    goHome() {
      if (saveTimer !== null) saveDocNow();
      if (docId) updateThumb(docId, history.present, state.sources);
      docId = null;
      docName = null;
      closeSession();
      history = createHistory<Doc>({ pages: [] });
      persistedDoc = history.present;
      set({
        phase: 'home',
        sources: new Map(),
        progress: { done: 0, total: 0 },
        selection: new Set(),
        selecting: false,
        filterFlagged: false,
        previewId: null,
        busy: null,
        exportProgress: null,
      });
      void refreshLibrary();
    },

    rotate(ids: Iterable<string>, delta: 90 | -90 | 180, aspectOf?: (id: string) => number | undefined) {
      const valid = existing(ids);
      if (valid.length) commit(rotatePages(history.present, valid, delta, aspectOf));
    },

    move(from: number, to: number) {
      const n = history.present.pages.length;
      const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
      if (!ok(from) || !ok(to) || from === to) return;
      commit(movePage(history.present, from, to));
    },

    /** Moves page `activeId` to the position of page `overId` (drag & drop). */
    moveById(activeId: string, overId: string) {
      const pages = history.present.pages;
      const from = pages.findIndex((p) => p.id === activeId);
      const to = pages.findIndex((p) => p.id === overId);
      if (from >= 0 && to >= 0) actions.move(from, to);
    },

    remove(ids: Iterable<string>) {
      const valid = existing(ids);
      if (!valid.length) return;
      // removing ends the selection mode (nothing selected is left)
      commit(deletePages(history.present, valid), {
        selection: new Set(),
        selecting: false,
        previewId: state.previewId !== null && valid.includes(state.previewId) ? null : state.previewId,
      });
    },

    setScanPhoto(file: File | null, index: number | null = null) {
      set({ scanPhoto: file, scanIndex: file ? index : null, scanQueue: [], scanTotal: file ? 1 : 0, scanCardFiles: [] });
    },

    /** Several camera photos go through the crop screen one after another. */
    setScanPhotos(files: File[], index: number | null = null, cardFiles: File[] = []) {
      if (!files.length) return actions.setScanPhoto(null);
      set({
        scanPhoto: files[0],
        scanQueue: files.slice(1),
        scanTotal: files.length,
        scanIndex: index,
        scanCardFiles: cardFiles,
      });
    },

    /** Next photo of the round; `added`: the current one became a page (the place moves on by one). */
    nextScan(added: boolean) {
      const [next, ...rest] = state.scanQueue;
      if (!next) return actions.setScanPhoto(null);
      const at = state.scanIndex === null ? null : state.scanIndex + (added ? 1 : 0);
      set({ scanPhoto: next, scanQueue: rest, scanIndex: at });
    },

    /** Adds a straightened camera page: opens a new document from Home, else appends it. */
    addScan(blob: Blob, at: number | null = null): Promise<void> {
      scanChain = scanChain
        .then(async () => {
          const day = new Date().toISOString().slice(0, 10);
          const file = new File([blob], `${strings.scanName} ${day}.jpg`, { type: 'image/jpeg' });
          if (state.phase === 'home') await actions.open([file]);
          else await actions.insertAt(at ?? history.present.pages.length, [file]);
        })
        .catch(() => set({ error: strings.genericError }));
      return scanChain;
    },

    openFilterSheet(ids: Iterable<string>) {
      const valid = existing(ids);
      if (valid.length) set({ filterSheetIds: valid });
    },

    closeFilterSheet() {
      set({ filterSheetIds: null });
    },

    /** Sets the look of pages (undoable); the sheet closes. */
    setFilter(ids: Iterable<string>, filter: ScanFilter) {
      const valid = existing(ids);
      set({ filterSheetIds: null });
      if (valid.length) commit(setPageFilter(history.present, valid, filter));
    },

    /** Places a signature on a page (fractions of the page, origin top-left). */
    addStamp(pageId: string, stamp: Stamp) {
      if (existing([pageId]).length) commit(addStampTo(history.present, pageId, stamp));
    },

    moveStamp(pageId: string, stampId: string, box: Partial<Pick<Stamp, 'x' | 'y' | 'w' | 'h' | 'rot' | 'src' | 'preset'>>) {
      commit(moveStampOn(history.present, pageId, stampId, box));
    },

    addMark(pageId: string, mark: Mark) {
      if (existing([pageId]).length) commit(addMarkTo(history.present, pageId, mark));
    },

    updateMark(pageId: string, markId: string, patch: MarkPatch) {
      commit(updateMarkOn(history.present, pageId, markId, patch));
    },

    removeMark(pageId: string, markId: string) {
      commit(removeMarkFrom(history.present, pageId, markId));
    },

    removeMarks(pageId: string, markIds: string[]) {
      if (markIds.length) commit(removeMarksFrom(history.present, pageId, markIds));
    },

    /** Copies a mark of one page onto every other page, same place (one undo step). */
    markOnAllPages(pageId: string, mark: Mark) {
      const others = history.present.pages.filter((p) => p.id !== pageId).map((p) => p.id);
      if (others.length) commit(copyMarkToPages(history.present, mark, others, () => crypto.randomUUID()));
    },

    /** Copies a signature of one page onto every other page, same place (one undo step). */
    stampOnAllPages(pageId: string, stamp: Stamp) {
      const others = history.present.pages.filter((p) => p.id !== pageId).map((p) => p.id);
      if (others.length) commit(copyStampToPages(history.present, stamp, others, () => crypto.randomUUID()));
    },

    /** "Kadruj" on the given pages (undefined = whole page). */
    setCrop(ids: string[], crop: Box | undefined) {
      const valid = existing(ids);
      if (valid.length) commit(setCropOn(history.present, valid, crop));
    },

    removeStamp(pageId: string, stampId: string) {
      commit(removeStampFrom(history.present, pageId, stampId));
    },

    /**
     * "Ukryj dane osobowe": reads the page, finds PESEL, ID and account numbers, phones and e-mails,
     * and covers each with a cover of the given colour (one undo step). Returns how many it covered.
     */
    async hidePersonal(pageId: string, color: 'black' | 'white' = 'black'): Promise<number> {
      const page = history.present.pages.find((p) => p.id === pageId);
      const source = page && state.sources.get(page.source.fileId);
      if (!page || !source) return 0;
      const hits = findPersonal(await deps.pageLines(page, source, getOcr));
      if (!hits.length || !existing([pageId]).length) return hits.length;
      // the picture read is the cropped page: back to fractions of the whole page, with a small margin
      const c = page.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      const PAD = 0.004;
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      let doc = history.present;
      for (const h of hits) {
        const x = clamp(c.x + (h.x0 - PAD) * c.w);
        const y = clamp(c.y + (h.y0 - PAD) * c.h);
        const mark: Mark = {
          id: crypto.randomUUID(),
          kind: 'cover',
          color,
          x,
          y,
          w: clamp(c.x + (h.x1 + PAD) * c.w) - x,
          h: clamp(c.y + (h.y1 + PAD) * c.h) - y,
        };
        doc = addMarkTo(doc, pageId, mark);
      }
      commit(doc);
      return hits.length;
    },

    /** Text of a page for "Kopiuj tekst". */
    pageText(pageId: string): Promise<string> {
      const page = history.present.pages.find((p) => p.id === pageId);
      const source = page && state.sources.get(page.source.fileId);
      if (!page || !source) return Promise.resolve('');
      return deps.pageText(page, source, getOcr);
    },

    copyText(text: string): Promise<void> {
      return deps.copyText(text);
    },

    showError(message: string) {
      set({ error: message });
    },

    /** "Usuń puste strony": removes every page flagged blank (undoable like any removal). */
    removeBlankPages() {
      actions.remove(history.present.pages.filter((p) => p.flags.includes('blank')).map((p) => p.id));
    },

    async insertAt(index: number, files: File[]) {
      if (files.length === 0 || state.busy) return;
      const own = session;
      set({ busy: 'opening', error: null });
      try {
        const { sources, pages } = await deps.importFiles(files);
        if (own !== session) {
          sources.forEach((s) => void deps.forgetPdf(s.id).catch(() => {}));
          return;
        }
        const at = Math.max(0, Math.min(Math.trunc(index) || 0, history.present.pages.length));
        const all = new Map(state.sources);
        sources.forEach((s) => all.set(s.id, s));
        history.push(insertPages(history.present, at, pages));
        set({ sources: all, busy: null });
        saveAll();
        void runAnalysis(pages);
      } catch (e) {
        if (own === session) set({ busy: null, error: errorMessage(e) });
      }
    },

    undo() {
      history.undo();
      set({});
    },

    redo() {
      history.redo();
      set({});
    },

    /** Opens the save sheet for the whole document, or for the given pages only. */
    openSaveSheet(ids?: Iterable<string>) {
      if (state.busy || history.present.pages.length === 0) return;
      const only = ids ? existing(ids) : null;
      if (only && only.length === 0) return;
      set({ saveSheetOpen: true, saveSheetIds: only });
    },

    closeSaveSheet() {
      set({ saveSheetOpen: false, saveSheetIds: null });
    },

    /** Suggested file name (without extension): first file's name + " (poprawiony)". */
    defaultFileName(): string {
      const first = state.sources.values().next().value as SourceFile | undefined;
      return exportFileName(docName ? `${docName}.pdf` : (first?.name ?? strings.defaultDocName)).replace(/\.pdf$/, '');
    },

    /** Stops a running export; nothing is saved and no error is shown. */
    cancelExport() {
      exportCtrl?.abort();
    },

    /** Builds the PDF; sharing is a separate tap (shareExport) with a fresh user activation. */
    async export(
      opts: ExportOptions = state.exportOptions,
      extra: {
        name?: string;
        ids?: string[] | null;
        /** Lock the PDF with this password (never remembered). */
        password?: string;
        /** One PDF per page. */
        split?: boolean;
        /** "Wyślij": the file waits for one tap that opens the share menu, instead of a download. */
        send?: boolean;
        /** "Znak wodny": this text and today's date across every page. */
        watermark?: string;
      } = {},
    ) {
      if (state.busy || history.present.pages.length === 0) return;
      saveExportOptions(deps.storage, opts);
      const own = session;
      const byId = new Map(history.present.pages.map((p) => [p.id, p]));
      // the chosen pages in the chosen order ("5-3" saves 5, 4, 3)
      const doc = extra.ids ? { pages: extra.ids.map((id) => byId.get(id)).filter((p): p is Page => !!p) } : history.present;
      const send = !!extra.send;
      const watermark = extra.watermark?.trim() ? watermarkLine(extra.watermark, currentLanguage()) : undefined;
      const ready = send || deps.shareFirst;
      if (doc.pages.length === 0) return;
      const base = (extra.name ?? '').trim().replace(/[\\/:*?"<>|]+/g, '-') || actions.defaultFileName();
      const ctrl = new AbortController();
      exportCtrl = ctrl;
      set({
        busy: 'exporting',
        exportProgress: null,
        exportReady: null,
        exportSend: false,
        error: null,
        notice: null,
        saveSheetOpen: false,
        saveSheetIds: null,
        exportOptions: opts,
      });
      try {
        // a size with a limit: saved again smaller until it fits (or the smallest is reached)
        const limit = SIZE_LIMIT[opts.size] ?? Infinity;
        let level = SIZE_START[opts.size] ?? 0;
        const smaller = (bytes: number) => {
          if (bytes <= limit || level >= MAX_LEVEL || pass >= MAX_LEVEL) return false; // never more tries than levels
          level = Math.min(MAX_LEVEL, level + (bytes / limit > 2.5 ? 2 : 1));
          return true;
        };
        let pass = 0;
        const progress = (p: { done: number; total: number; ocr: boolean }) =>
          own === session && set({ exportProgress: pass > 0 ? { ...p, shrink: true } : p });
        /** "Nie udało się zejść do 1 MB…" when even the smallest is too big. */
        const tooBig = (bytes: number) => (bytes > limit ? ` ${strings.sizeTooBig(formatSize(limit), formatSize(bytes))}` : '');
        if (opts.format === 'jpg') {
          let blobs: Blob[];
          for (;;) {
            blobs = await deps.exportImages(doc, state.sources, (done, total) => progress({ done, total, ocr: false }), {
              compress: level,
              signal: ctrl.signal,
              watermark,
            });
            if (own !== session) return;
            if (!smaller(blobs.reduce((n, b) => n + b.size, 0))) break;
            pass++;
          }
          const files = blobs.map(
            (b, i) => new File([b], blobs.length === 1 ? `${base}.jpg` : `${base} ${i + 1}.jpg`, { type: 'image/jpeg' }),
          );
          if (ready) {
            exportedDoc = history.present;
            const over = tooBig(files.reduce((s, f) => s + f.size, 0)).trim();
            set({ busy: null, exportProgress: null, exportReady: files, exportSend: send, notice: over || null });
          } else {
            const saved = downloadAll(files);
            const bytes = files.reduce((s, f) => s + f.size, 0);
            set({
              busy: null,
              exportProgress: null,
              notice:
                strings.savedNotice(saved.length === 1 ? saved[0].name : `${base} (${saved.length})`, formatSize(bytes)) + tooBig(bytes),
            });
          }
          return;
        }
        let engine: OcrEngine | null = null;
        let ocrFailed = false;
        if (opts.ocr) {
          try {
            engine = await getOcr();
          } catch {
            ocrFailed = true; // save without the text layer and say so
          }
        }
        // one file, or one per page ("Każda strona osobno")
        const parts = extra.split && doc.pages.length > 1 ? doc.pages.map((p) => ({ pages: [p] })) : [doc];
        const total = doc.pages.length;
        let files: File[];
        for (;;) {
          let before = 0;
          files = [];
          for (const [i, part] of parts.entries()) {
            let bytes = await deps.exportPdf(
              part,
              state.sources,
              (done) => progress({ done: before + done, total, ocr: engine !== null }),
              { compress: level, ocr: engine, signal: ctrl.signal, watermark },
            );
            if (own !== session) return;
            if (extra.password) bytes = await deps.encryptPdf(bytes, extra.password);
            if (own !== session) return;
            before += part.pages.length;
            files.push(pdfFile(bytes, parts.length === 1 ? `${base}.pdf` : `${base} ${i + 1}.pdf`));
          }
          if (!smaller(files.reduce((n, f) => n + f.size, 0))) break;
          pass++;
        }
        const over = tooBig(files.reduce((n, f) => n + f.size, 0)).trim();
        const out = files.length === 1 ? files[0] : files;
        if (ready) {
          exportedDoc = history.present;
          const note = [over, ocrFailed ? strings.ocrUnavailable : ''].filter(Boolean).join(' ');
          set({ busy: null, exportProgress: null, exportReady: out, exportSend: send, notice: note || null });
        } else {
          const done = downloadAll(files);
          const size = formatSize(files.reduce((n, f) => n + f.size, 0));
          const saved = strings.savedNotice(done.length === 1 ? done[0].name : `${base} (${done.length})`, size);
          set({
            busy: null,
            exportProgress: null,
            notice: [saved, over, ocrFailed ? strings.ocrUnavailable : ''].filter(Boolean).join(' '),
          });
        }
      } catch (e) {
        if (own !== session) return;
        const cancelled = ctrl.signal.aborted && (e as { name?: string })?.name === 'AbortError';
        set({ busy: null, exportProgress: null, error: cancelled ? null : strings.exportError });
      } finally {
        if (exportCtrl === ctrl) exportCtrl = null;
      }
    },

    /** Opens the share sheet (or downloads) for the exported PDF; call it from the user's tap. */
    async shareExport() {
      const file = state.exportReady;
      if (!file) return;
      try {
        const result = await deps.share(file);
        if (result !== 'cancelled' && state.exportReady === file) {
          exportedDoc = null;
          set({ exportReady: null, exportSend: false });
        }
      } catch {
        set({ error: strings.exportError });
      }
    },

    dismissNotice() {
      set({ notice: null });
    },

    openPreview(id: string) {
      set({ previewId: id });
    },

    closePreview() {
      if (state.previewId !== null) set({ previewId: null });
    },

    toggleSelecting() {
      set({ selecting: !state.selecting, selection: new Set() });
    },

    toggleSelected(id: string) {
      const selection = new Set(state.selection);
      if (!selection.delete(id)) selection.add(id);
      set({ selection });
    },

    /** Clears the selection too, so actions never touch pages hidden by the filter. */
    setFilterFlagged(filterFlagged: boolean) {
      set({ filterFlagged, selection: new Set() });
    },

    /** Applies to the next analysis run. */
    setDeskew(deskew: boolean) {
      try {
        deps.storage?.setItem(DESKEW_KEY, deskew ? '1' : '0');
      } catch {
        // private mode / blocked storage: keep the in-memory value only
      }
      set({ deskew });
    },

    dismissError() {
      set({ error: null });
    },

    /** Reopens the newest kept document ("Wróć do ostatniego dokumentu"). */
    restore() {
      const last = state.library[0];
      if (last) void actions.openStored(last.id);
    },

    /** Opens a document from "Moje dokumenty" where it was left, and finishes analyzing its pages. */
    async openStored(id: string) {
      if (state.busy || !deps.library) return;
      set({ busy: 'opening', error: null });
      const s = await deps.library.load(id);
      if (!s) {
        set({ busy: null, error: strings.docMissing });
        void refreshLibrary();
        return;
      }
      actions.load(s.doc, s.sources);
      docId = id;
      docName = state.library.find((m) => m.id === id)?.name ?? null;
      set({ docsOpen: false });
    },

    openDocs() {
      set({ docsOpen: true });
      void refreshLibrary()?.then(fillThumbs);
    },

    closeDocs() {
      set({ docsOpen: false });
    },

    async renameStored(id: string, name: string) {
      const clean = name.trim();
      if (!clean || !deps.library) return;
      if (id === docId) docName = clean;
      libraryChanges++;
      set({ library: state.library.map((m) => (m.id === id ? { ...m, name: clean } : m)) });
      await deps.library.patch(id, { name: clean });
      await refreshLibrary();
    },

    async removeStored(id: string) {
      if (!deps.library || id === docId) return;
      const library = state.library.filter((m) => m.id !== id);
      libraryChanges++;
      set({ library, restorable: library.length > 0 });
      await deps.library.remove(id);
      await refreshLibrary();
    },

    /** Writes a pending debounced doc save now (the page is being hidden / may be killed). */
    flushSession() {
      if (saveTimer !== null) saveDocNow();
    },

    /** Starts the text recognition in the background (on the home screen), so a document does not wait for it. */
    warmUp() {
      void getDetector().catch(() => {}); // no internet the first time: the document tries again
    },

    openDiagnostics() {
      set({ diagnostics: true });
    },

    closeDiagnostics() {
      set({ diagnostics: false });
    },

    /** Metrics report for the open document (analysis results since it was opened or restored). */
    metricsReport(device: string): string {
      return metrics.report(history.present, device);
    },
  };

  void refreshLibrary();

  return {
    ...actions,
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;
export type AppActions = Omit<AppStore, 'getState' | 'subscribe'>;

const StoreContext = createContext<AppStore | null>(null);

export function AppStoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useAppStore(): AppState & AppActions & { getSource(fileId: string): SourceFile | undefined } {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStore outside AppStoreProvider');
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return useMemo(() => ({ ...store, ...state, getSource: (id: string) => state.sources.get(id) }), [store, state]);
}

export const isFlagged = (p: Page): boolean => p.flags.length > 0;
