import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../src/ui/App';
import { createAppStore } from '../../src/ui/store';
import { strings } from '../../src/ui/strings';
import { storageKey } from '../../src/config';
import { fakeDeps, page, source } from './fixtures';

vi.mock('../../src/imaging/render', () => ({
  renderPage: vi.fn(() => new Promise(() => {})),
  releaseCanvas: vi.fn(),
  getPdf: vi.fn(),
  forgetPdf: vi.fn(async () => {}),
}));
// decoding and the perspective warp need a real canvas; jsdom has none
vi.mock('../../src/scan/warp', () => ({
  loadPhoto: vi.fn(async () => ({ width: 4000, height: 3000, url: 'blob:photo', bitmap: {}, close: vi.fn() })),
  findSheet: vi.fn(() => null),
  warpToBlob: vi.fn(async () => new Blob(['jpg'], { type: 'image/jpeg' })),
  warpPreview: vi.fn(async () => 'blob:preview'),
}));

// what the live camera "sees" in each frame (a real canvas is needed for that)
const frame = vi.hoisted(() => ({ current: null as null | { quad: unknown; width: number; height: number; light: number } }));
vi.mock('../../src/scan/liveFrame', () => ({ analyzeFrame: vi.fn(() => frame.current) }));
const fullSheet = {
  quad: [
    { x: 40, y: 20 },
    { x: 360, y: 20 },
    { x: 360, y: 280 },
    { x: 40, y: 280 },
  ],
  width: 400,
  height: 300,
  light: 150,
};

vi.mock('../../src/scan/receipt', async (orig) => ({
  ...(await orig<typeof import('../../src/scan/receipt')>()),
  composeReceipt: vi.fn(async () => new Blob(['long'], { type: 'image/jpeg' })),
}));

// "Paragon": what the sweep sees and decides, set by each test (the real sums are tested in tests/scan)
const sweepCtl = vi.hoisted(() => ({
  strip: { topL: 60, topR: 180, botL: 60, botR: 180 } as null | { topL: number; topR: number; botL: number; botR: number },
  light: 150,
  out: { pos: 0, state: 'moving' as 'moving' | 'fast' | 'lost' | 'blank', capture: false },
  /** Each push keeps a frame (for the "too many frames" case). */
  alwaysKeep: false,
  pushes: 0,
}));
vi.mock('../../src/scan/sweepFrame', () => ({
  grabGray: vi.fn(() => ({ gray: new Uint8ClampedArray(240 * 180), w: 240, h: 180, light: sweepCtl.light })),
  cutKey: vi.fn(async () => ({ blob: new Blob(['key'], { type: 'image/jpeg' }), thumb: 'data:image/jpeg;base64,key' })),
  composeSweep: vi.fn(async () => new Blob(['receipt'], { type: 'image/jpeg' })),
}));
vi.mock('../../src/scan/sweep', async (orig) => ({
  ...(await orig<typeof import('../../src/scan/sweep')>()),
  findStrip: vi.fn(() => sweepCtl.strip),
  unwarpStrip: vi.fn(() => ({ data: new Uint8ClampedArray(96 * 10), w: 96, h: 10 })),
  rowFeatures: vi.fn(() => new Float32Array(240)),
  createSweep: vi.fn(() => {
    let first = true;
    return {
      push: () => {
        sweepCtl.pushes++;
        const capture = first || sweepCtl.alwaysKeep || sweepCtl.out.capture;
        first = false;
        return { ...sweepCtl.out, capture };
      },
      captured: vi.fn(),
    };
  }),
  layoutSweep: vi.fn((keys: { rows: number }[]) => keys.map((k) => ({ from: 0, to: k.rows }))),
}));

vi.mock('../../src/scan/card', async (orig) => ({
  ...(await orig<typeof import('../../src/scan/card')>()),
  composeIdCard: vi.fn(async () => new Blob(['a4'], { type: 'image/jpeg' })),
}));

const photo = () => new File(['x'], 'IMG_0001.jpg', { type: 'image/jpeg' });

function cameraInput(): HTMLInputElement {
  return document.querySelector('input[capture]') as HTMLInputElement;
}

async function takePhoto() {
  await act(async () => {
    fireEvent.change(cameraInput(), { target: { files: [photo()] } });
  });
}

describe('camera scan', () => {
  it('Home offers "Zrób zdjęcie" that opens the rear camera', () => {
    render(<App store={createAppStore(fakeDeps())} />);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    expect(click).toHaveBeenCalled();
    expect(cameraInput().getAttribute('capture')).toBe('environment');
    expect(cameraInput().getAttribute('accept')).toBe('image/*');
    click.mockRestore();
  });

  it('a photo opens the crop screen with 4 corners; Gotowe adds the straightened page', async () => {
    const deps = fakeDeps({
      importFiles: vi.fn(async () => ({ sources: [source], pages: [page('s1', { analyzed: false, autoRotation: null })] })),
    });
    render(<App store={createAppStore(deps)} />);
    await takePhoto();
    expect(await screen.findByRole('dialog', { name: strings.cropTitle })).toBeTruthy();
    expect(screen.getAllByRole('slider')).toHaveLength(4);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
    const [files] = vi.mocked(deps.importFiles).mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name.startsWith(strings.scanName)).toBe(true);
    expect(files[0].type).toBe('image/jpeg');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull());
    expect(screen.getByRole('button', { name: strings.save })).toBeTruthy(); // review screen
  });

  it('"Następna strona" saves this page and opens the camera again', async () => {
    const deps = fakeDeps();
    render(<App store={createAppStore(deps)} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNext })));
    expect(click).toHaveBeenCalled();
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
    click.mockRestore();
  });

  it('the camera tile is off while a PDF is being saved (a photo then would be lost)', async () => {
    const deps = fakeDeps({ exportPdf: vi.fn(() => new Promise<Uint8Array>(() => {})) });
    const store = createAppStore(deps);
    store.load({ pages: [page('p1')] }, [source]);
    render(<App store={store} />);
    const tile = () => screen.getAllByRole('button', { name: strings.takePhoto })[0] as HTMLButtonElement;
    expect(tile().disabled).toBe(false);
    act(() => void store.export({ size: 'best', ocr: false, format: 'pdf' }));
    expect(tile().disabled).toBe(true);
  });

  it('one photo from "Wybierz pliki" (Android offers the camera there too) also goes through the crop screen', async () => {
    const deps = fakeDeps();
    render(<App store={createAppStore(deps)} />);
    const picker = document.querySelector('.home input[type=file]:not([capture])') as HTMLInputElement;
    await act(async () => fireEvent.change(picker, { target: { files: [photo()] } }));
    expect(await screen.findByRole('dialog', { name: strings.cropTitle })).toBeTruthy();
    expect(deps.importFiles).not.toHaveBeenCalled();
  });

  it('a PDF or several photos from the picker are added straight away', async () => {
    const deps = fakeDeps();
    render(<App store={createAppStore(deps)} />);
    const picker = document.querySelector('.home input[type=file]:not([capture])') as HTMLInputElement;
    await act(async () => fireEvent.change(picker, { target: { files: [photo(), photo()] } }));
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
  });

  it('a photo inserted with "+" between pages lands at that place after cropping', async () => {
    const deps = fakeDeps();
    const store = createAppStore(deps);
    store.load({ pages: [page('p1'), page('p2')] }, [source]);
    render(<App store={store} />);
    const picker = document.querySelector('.grid-wrap input[type=file]') as HTMLInputElement;
    store.setScanPhoto(photo(), 1);
    await screen.findByRole('dialog', { name: strings.cropTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
    expect(picker).not.toBeNull();
    await waitFor(() => expect(store.getState().doc.pages.map((p) => p.id)).toEqual(['p1', 'n1', 'p2']));
  });

  it('the crop screen offers Auto / Kolor / Wybielony / Czarno-biały (Auto first time); the choice is used and remembered', async () => {
    const { warpToBlob } = await import('../../src/scan/warp');
    localStorage.clear();
    render(<App store={createAppStore(fakeDeps())} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const opt = (name: string) => screen.getByRole('button', { name });
    expect(opt(strings.filterAuto).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(opt(strings.filterBw));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    expect(vi.mocked(warpToBlob).mock.calls.at(-1)![2]).toBe('bw');
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(opt(strings.filterBw).getAttribute('aria-pressed')).toBe('true');
  });

  it('a small preview shows the straightened page with the chosen look, and follows the choice', async () => {
    const { warpPreview } = await import('../../src/scan/warp');
    localStorage.clear();
    render(<App store={createAppStore(fakeDeps())} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const img = await screen.findByRole('img', { name: strings.cropPreview });
    expect(img.getAttribute('src')).toBe('blob:preview');
    expect(vi.mocked(warpPreview).mock.calls.at(-1)![2]).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: strings.filterBw }));
    await waitFor(() => expect(vi.mocked(warpPreview).mock.calls.at(-1)![2]).toBe('bw'));
  });

  it('"Całe zdjęcie" puts the corners on the corners of the photo; "Wykryj kartkę" looks for the sheet again', async () => {
    const warp = await import('../../src/scan/warp');
    const found = [
      { x: 500, y: 400 },
      { x: 3500, y: 420 },
      { x: 3480, y: 2600 },
      { x: 520, y: 2580 },
    ];
    vi.mocked(warp.findSheet).mockReturnValue(found as never);
    render(<App store={createAppStore(fakeDeps())} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const corner = () => screen.getAllByRole('slider')[0].getAttribute('aria-valuetext');
    await waitFor(() => expect(corner()).toBe('500, 400'));
    fireEvent.click(screen.getByRole('button', { name: strings.cropWhole }));
    expect(corner()).toBe('0, 0');
    fireEvent.click(screen.getByRole('button', { name: strings.cropDetect }));
    expect(corner()).toBe('500, 400');
    vi.mocked(warp.findSheet).mockReturnValue(null);
  });

  it('dragging a corner with a finger shows a magnifier of the photo around it', async () => {
    render(<App store={createAppStore(fakeDeps())} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const corner = (await screen.findAllByRole('slider'))[0];
    const t = { pointerId: 2, pointerType: 'touch' };
    fireEvent.pointerDown(corner, { ...t, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(corner, { ...t, clientX: 20, clientY: 25 });
    const loupe = document.querySelector('.loupe') as HTMLElement;
    expect(loupe).not.toBeNull();
    expect(loupe.style.backgroundImage).toContain('blob:photo');
    fireEvent.pointerUp(corner, t);
    expect(document.querySelector('.loupe')).toBeNull();
  });

  it('Anuluj closes the crop screen without adding anything', async () => {
    const deps = fakeDeps();
    render(<App store={createAppStore(deps)} />);
    await takePhoto();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    fireEvent.click(screen.getByRole('button', { name: strings.cancel }));
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
    expect(deps.importFiles).not.toHaveBeenCalled();
  });
});

describe('built-in camera', () => {
  const stop = vi.fn();
  const applyConstraints = vi.fn(async () => {});
  const track = { stop, applyConstraints, getCapabilities: () => ({ torch: true }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };

  beforeEach(() => {
    stop.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
  });
  afterEach(() => {
    // @ts-expect-error back to jsdom's "no camera API"
    delete navigator.mediaDevices;
    vi.restoreAllMocks();
  });

  it('a weak phone asks the camera for a lighter live picture (about 2 MP); a strong one for the full one', async () => {
    const cores = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });
    render(<App store={createAppStore(fakeDeps())} />);
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    await screen.findByRole('dialog', { name: strings.cameraTitle });
    const ask = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls[0][0] as MediaStreamConstraints;
    expect((ask.video as { width: { ideal: number } }).width.ideal).toBeLessThanOrEqual(1920);
    // @ts-expect-error back to the browser's own
    delete navigator.hardwareConcurrency;
    if (cores) Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', cores);
  });

  it('"Zrób zdjęcie" opens the camera inside the app (the page is not left); ✕ turns it off', async () => {
    render(<App store={createAppStore(fakeDeps())} />);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    expect(click).not.toHaveBeenCalled();
    const cam = await screen.findByRole('dialog', { name: strings.cameraTitle });
    await waitFor(() => expect((screen.getByRole('button', { name: strings.cameraShoot }) as HTMLButtonElement).disabled).toBe(false));
    expect(cam.querySelector('video')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings.cameraTorch }));
    await waitFor(() => expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }));
    fireEvent.click(screen.getByRole('button', { name: strings.close }));
    expect(screen.queryByRole('dialog', { name: strings.cameraTitle })).toBeNull();
    expect(stop).toHaveBeenCalled();
  });

  async function openLive(deps = fakeDeps()) {
    render(<App store={createAppStore(deps)} />);
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    await screen.findByRole('dialog', { name: strings.cameraTitle });
    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { value: 1600 });
    Object.defineProperty(video, 'videoHeight', { value: 1200 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(new Blob(['jpg'], { type: 'image/jpeg' }));
    });
    await waitFor(() => expect((screen.getByRole('button', { name: strings.cameraShoot }) as HTMLButtonElement).disabled).toBe(false));
    return deps;
  }
  const shoot = () => act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraShoot })));

  beforeEach(() => {
    frame.current = null;
    localStorage.clear();
    localStorage.setItem(storageKey('duckfix-tour2'), '1'); // the duck tour has its own "Dalej" / "Pomiń"
  });

  it('shots stay in the camera; "Gotowe (2)" opens the crop screen page by page', async () => {
    const deps = await openLive();
    await shoot();
    await shoot();
    expect(screen.getByRole('dialog', { name: strings.cameraTitle })).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy(); // count on the thumbnail
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(2) })));
    expect(screen.queryByRole('dialog', { name: strings.cameraTitle })).toBeNull();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(screen.getByText(strings.cropPageOf(1, 2))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNextQueued })));
    expect(await screen.findByText(strings.cropPageOf(2, 2))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull());
  });

  it('a tap on the counter shows the photos of the series; a bad one is taken out there, the rest go on', async () => {
    const deps = await openLive();
    await shoot();
    await shoot();
    await shoot();
    fireEvent.click(screen.getByRole('button', { name: strings.shotsReview(3) }));
    const review = screen.getByRole('dialog', { name: strings.shotsTitle(3) });
    expect(review.querySelectorAll('.shot-tile')).toHaveLength(3);
    fireEvent.click(within(review).getByRole('button', { name: strings.shotRemove(2) }));
    expect(screen.getByRole('dialog', { name: strings.shotsTitle(2) }).querySelectorAll('.shot-tile')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: strings.shotsBack }));
    expect(screen.queryByRole('dialog', { name: strings.shotsTitle(2) })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(2) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(screen.getByText(strings.cropPageOf(1, 2))).toBeTruthy();
    void deps;
  });

  it('taking out every photo closes the review; the camera has none left', async () => {
    await openLive();
    await shoot();
    fireEvent.click(screen.getByRole('button', { name: strings.shotsReview(1) }));
    fireEvent.click(screen.getByRole('button', { name: strings.shotRemove(1) }));
    expect(screen.queryByRole('dialog', { name: strings.shotsTitle(0) })).toBeNull();
    expect(screen.queryByRole('button', { name: strings.cameraDone(1) })).toBeNull();
  });

  it('"Dodaj wszystkie" adds the rest with the found outline, without asking page by page', async () => {
    const deps = await openLive();
    await shoot();
    await shoot();
    await shoot();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(3) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropAddAll })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
  });

  it('"Pomiń" leaves a photo out', async () => {
    const deps = await openLive();
    await shoot();
    await shoot();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(2) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropSkip })));
    expect(await screen.findByText(strings.cropPageOf(2, 2))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
  });

  it('✕ on the crop screen in the middle of a round asks before dropping the rest', async () => {
    await openLive();
    await shoot();
    await shoot();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(2) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: strings.cancel }));
    expect(ask).toHaveBeenCalledWith(strings.cameraDiscard(2));
    expect(screen.getByRole('dialog', { name: strings.cropTitle })).toBeTruthy();
    ask.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: strings.cancel }));
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
  });

  it('✕ with photos taken asks first', async () => {
    await openLive();
    await shoot();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: strings.close }));
    expect(ask).toHaveBeenCalledWith(strings.cameraDiscard(1));
    expect(screen.getByRole('dialog', { name: strings.cameraTitle })).toBeTruthy();
  });

  it('the sheet is outlined live and taken by itself when the phone is held still (Auto)', async () => {
    frame.current = fullSheet;
    await openLive();
    expect(screen.getByRole('button', { name: strings.modeAuto }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.querySelector('.live-camera-outline polygon')).not.toBeNull());
    expect(await screen.findByRole('button', { name: strings.cameraDone(1) }, { timeout: 3000 })).toBeTruthy();
  });

  it('the new look: corner marks on the sheet, the modes and buttons in one panel, the shutter ring fills while held', async () => {
    frame.current = fullSheet;
    await openLive();
    await waitFor(() => expect(document.querySelectorAll('.live-camera-outline .live-camera-corner')).toHaveLength(4));
    const panel = document.querySelector('.live-camera-panel') as HTMLElement;
    expect(panel.querySelector('[role="group"]')).not.toBeNull(); // the modes
    expect(panel.contains(screen.getByRole('button', { name: strings.cameraShoot }))).toBe(true);
    await waitFor(() => expect(document.querySelector('.live-camera-shutter .live-camera-progress')).not.toBeNull());
  });

  it('"Ręcznie": no outline, nothing taken by itself, the crop starts from the whole photo; remembered', async () => {
    const warp = await import('../../src/scan/warp');
    vi.mocked(warp.findSheet).mockClear();
    frame.current = fullSheet;
    await openLive();
    fireEvent.click(screen.getByRole('button', { name: strings.modeManual }));
    expect(screen.getByRole('button', { name: strings.modeManual }).getAttribute('aria-pressed')).toBe('true');
    await new Promise((r) => setTimeout(r, 1500));
    expect(document.querySelector('.live-camera-outline')).toBeNull();
    expect(screen.queryByRole('button', { name: strings.cameraDone(1) })).toBeNull();
    await shoot();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(1) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    // the photo's own corners (4000 × 3000), no search for the sheet
    await waitFor(() => expect(screen.getAllByRole('slider')[2].getAttribute('aria-valuetext')).toBe('4000, 3000'));
    expect(warp.findSheet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: strings.cancel }));
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    expect((await screen.findByRole('button', { name: strings.modeManual })).getAttribute('aria-pressed')).toBe('true');
  });

  it('"Dowód": two shots (front, back) go to the crop screen by themselves and become ONE page', async () => {
    const card = await import('../../src/scan/card');
    vi.mocked(card.composeIdCard).mockClear();
    const deps = await openLive();
    fireEvent.click(screen.getByRole('button', { name: strings.modeCard }));
    expect(screen.getByText(strings.cardFront)).toBeTruthy();
    await shoot();
    expect(screen.getByText(strings.cardBack)).toBeTruthy();
    await shoot();
    // after the back the crop screen opens by itself
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(screen.getByText(strings.cropCardFront)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNextQueued })));
    expect(await screen.findByText(strings.cropCardBack)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(card.composeIdCard).mock.calls[0][0]).toHaveLength(2);
    expect(vi.mocked(deps.importFiles).mock.calls[0][0]).toHaveLength(1);
  });

  it('"Auto" straightens a card side in colour (a card is never whitened)', async () => {
    const warp = await import('../../src/scan/warp');
    await openLive();
    fireEvent.click(screen.getByRole('button', { name: strings.modeCard }));
    await shoot();
    await shoot();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNextQueued })));
    await waitFor(() => expect(vi.mocked(warp.warpToBlob).mock.calls.at(-1)![2]).toBe('auto-card'));
  });

  describe('"Paragon": the receipt is filmed while the phone moves', () => {
    beforeEach(() => {
      sweepCtl.strip = { topL: 60, topR: 180, botL: 60, botR: 180 };
      sweepCtl.light = 150;
      sweepCtl.out = { pos: 0, state: 'moving', capture: false };
      sweepCtl.alwaysKeep = false;
      sweepCtl.pushes = 0;
    });
    const openReceipt = async () => {
      const deps = await openLive();
      fireEvent.click(screen.getByRole('button', { name: strings.modeReceipt }));
      return deps;
    };
    const shutter = () => screen.getByRole('button', { name: new RegExp(`^(${strings.cameraShoot}|${strings.sweepStop})$`) });

    it('aim, press: the shutter becomes "Zakończ paragon" and says to move down; no photo is taken by itself', async () => {
      const liveFrame = await import('../../src/scan/liveFrame');
      vi.mocked(liveFrame.analyzeFrame).mockClear();
      frame.current = fullSheet; // a sheet held still would be taken by itself in "Auto"
      await openReceipt();
      expect(await screen.findByText(strings.sweepStart)).toBeTruthy();
      await act(async () => fireEvent.click(shutter()));
      expect(shutter().getAttribute('aria-label')).toBe(strings.sweepStop);
      expect(await screen.findByText(strings.sweepMove)).toBeTruthy();
      await new Promise((r) => setTimeout(r, 300));
      expect(vi.mocked(liveFrame.analyzeFrame)).not.toHaveBeenCalled();
      expect(screen.queryByText('1')).toBeNull(); // no photo counted
    });

    it('too fast: "Wolniej" and a short buzz; lost: "Wróć trochę wyżej"', async () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      await openReceipt();
      await act(async () => fireEvent.click(shutter()));
      sweepCtl.out = { pos: 30, state: 'fast', capture: false };
      expect(await screen.findByText(strings.sweepFast)).toBeTruthy();
      expect(vibrate).toHaveBeenCalled();
      sweepCtl.out = { pos: 30, state: 'lost', capture: false };
      expect(await screen.findByText(strings.sweepLost)).toBeTruthy();
    });

    it('no receipt in view: says so, and nothing is followed', async () => {
      sweepCtl.strip = null;
      await openReceipt();
      expect(await screen.findByText(strings.sweepNoReceipt)).toBeTruthy();
      await act(async () => fireEvent.click(shutter()));
      await new Promise((r) => setTimeout(r, 300));
      expect(sweepCtl.pushes).toBe(0);
    });

    it('"Zakończ paragon": one photo; "Gotowe" and "Dodaj": one page made of the kept frames', async () => {
      const sf = await import('../../src/scan/sweepFrame');
      vi.mocked(sf.composeSweep).mockClear();
      const deps = await openReceipt();
      await act(async () => fireEvent.click(shutter()));
      await waitFor(() => expect(sweepCtl.pushes).toBeGreaterThan(1));
      await act(async () => fireEvent.click(shutter()));
      expect(shutter().getAttribute('aria-label')).toBe(strings.cameraShoot);
      expect(await screen.findByText('1')).toBeTruthy(); // one photo in the series
      await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(1) })));
      await screen.findByRole('dialog', { name: strings.cropTitle });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
      await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(1));
      expect(vi.mocked(sf.composeSweep)).toHaveBeenCalledTimes(1);
    });

    it('"Gotowe" while filming: the receipt is finished first, then the crop screen with it', async () => {
      await openReceipt();
      await act(async () => fireEvent.click(shutter()));
      await waitFor(() => expect(sweepCtl.pushes).toBeGreaterThan(1));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(1) })));
      expect(await screen.findByRole('dialog', { name: strings.cropTitle })).toBeTruthy();
    });

    it('the modes cannot be changed while filming', async () => {
      await openReceipt();
      await act(async () => fireEvent.click(shutter()));
      expect((screen.getByRole('button', { name: strings.modeAuto }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('a very long receipt: after 30 frames the filming ends by itself and says so', async () => {
      sweepCtl.alwaysKeep = true;
      await openReceipt();
      await act(async () => fireEvent.click(shutter()));
      expect(await screen.findByText(strings.sweepFull, undefined, { timeout: 5000 })).toBeTruthy();
      expect(shutter().getAttribute('aria-label')).toBe(strings.cameraShoot);
      expect(await screen.findByText('1')).toBeTruthy();
    });
  });

  it('a normal photo first, then "Dowód": the card still needs its own front and back; the photo stays its own page', async () => {
    const card = await import('../../src/scan/card');
    vi.mocked(card.composeIdCard).mockClear();
    const deps = await openLive();
    await shoot(); // an ordinary page
    fireEvent.click(screen.getByRole('button', { name: strings.modeCard }));
    expect(screen.getByText(strings.cardFront)).toBeTruthy(); // not "Teraz tył"
    await shoot();
    expect(screen.getByText(strings.cardBack)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
    await shoot();
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(screen.getByText(strings.cropPageOf(1, 3))).toBeTruthy(); // the ordinary page
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNextQueued })));
    expect(await screen.findByText(strings.cropCardFront)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropNextQueued })));
    expect(await screen.findByText(strings.cropCardBack)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cropDone })));
    // two pages: the ordinary one and the card page
    await waitFor(() => expect(deps.importFiles).toHaveBeenCalledTimes(2));
    expect(vi.mocked(card.composeIdCard).mock.calls[0][0]).toHaveLength(2);
  });

  it('a photo counts at the flash; "Gotowe" pressed while it is still being saved waits for it and keeps it', async () => {
    await openLive();
    let save: BlobCallback | null = null;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      save = cb; // the full-size picture is still being written
    });
    await shoot();
    expect(screen.getByText('1')).toBeTruthy(); // counted at once
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(1) })));
    const wait = screen.getByRole('button', { name: strings.cameraSaving });
    expect((wait as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('dialog', { name: strings.cropTitle })).toBeNull();
    await act(async () => save!(new Blob(['jpg'], { type: 'image/jpeg' })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
  });

  it('"Gotowe" while the sheet is held in frame (the outline filling up) takes that page too, then goes on', async () => {
    await openLive();
    await shoot(); // one page already
    frame.current = fullSheet;
    await waitFor(() => expect(document.querySelector('.live-camera-progress')).not.toBeNull());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: strings.cameraDone(1) })));
    await screen.findByRole('dialog', { name: strings.cropTitle });
    expect(screen.getByText(strings.cropPageOf(1, 2))).toBeTruthy();
  });

  it('hints: find the sheet, come closer, too dark', async () => {
    frame.current = { ...fullSheet, quad: null };
    await openLive();
    expect(await screen.findByText(strings.hintFind)).toBeTruthy();
    frame.current = {
      ...fullSheet,
      quad: [
        { x: 180, y: 130 },
        { x: 240, y: 130 },
        { x: 240, y: 180 },
        { x: 180, y: 180 },
      ],
    };
    expect(await screen.findByText(strings.hintCloser)).toBeTruthy();
    frame.current = { ...fullSheet, quad: null, light: 30 };
    expect(await screen.findByText(strings.hintDark)).toBeTruthy();
  });

  it('when the camera cannot start (no permission), the phone camera is offered', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NotAllowedError'));
    render(<App store={createAppStore(fakeDeps())} />);
    fireEvent.click(screen.getByRole('button', { name: strings.homeScan }));
    expect(await screen.findByText(strings.cameraFailed)).toBeTruthy();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getAllByRole('button', { name: strings.cameraPhone })[0]);
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: strings.cameraTitle })).toBeNull();
  });
});

describe('shortcut "Skanuj" on the app icon', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    // @ts-expect-error back to jsdom's "no camera API"
    delete navigator.mediaDevices;
  });

  it('?go=scan opens the camera straight away', async () => {
    const track = { stop: vi.fn(), applyConstraints: vi.fn(), getCapabilities: () => ({}) };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] })) },
    });
    window.history.replaceState(null, '', '/?go=scan');
    render(<App store={createAppStore(fakeDeps())} />);
    expect(await screen.findByRole('dialog', { name: strings.cameraTitle })).toBeTruthy();
    expect(window.location.search).toBe('');
  });
});
