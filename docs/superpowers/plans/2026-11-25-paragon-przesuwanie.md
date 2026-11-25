# Paragon: przesuwanie na żywo — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tryb „Paragon” w aparacie nagrywa paragon podczas przesuwania telefonu i składa go w jedno zdjęcie, bez dublowanych i brakujących linii.

**Architecture:** Czyste algorytmy na szarych tablicach w `src/scan/sweep.ts`: brzegi paragonu, śledzenie przesunięcia, układ klatek. Testowane na sztucznym paragonie. Klej z canvasem w `src/scan/sweepFrame.ts`: zmniejszona klatka, wycięcie ostrej klatki, złożenie JPEG. Hak `useReceiptSweep` w `src/ui/receiptSweep.ts` steruje nagrywaniem. `camera.tsx` tylko go podłącza. Stara ścieżka „Paragon ze zdjęć” znika.

**Tech Stack:** React 18, TypeScript, Vite, Vitest + jsdom (bez canvasu, więc canvas jest mockowany).

**Spec:** `docs/superpowers/specs/2026-11-25-paragon-przesuwanie-design.md`

## Global Constraints
- Prettier: `--single-quote --print-width 140`. Komentarze w kodzie po angielsku, prostym językiem, jak w reszcie repo.
- Teksty: nowe klucze w `src/i18n/pl.ts`, `en.ts`, `de.ts`, `es.ts` (typ wymusza wszystkie cztery).
- Wynik: jeden JPEG o szerokości do 1240 px (`WIDTH` jak w starym `receipt.ts`), jakość 0.9.
- Słaby telefon (`isWeakDevice()`): klatka do śledzenia o szerokości 160 px zamiast 240 px, śledzenie co najmniej 4 razy na sekundę.
- iOS: każdy tymczasowy canvas zwalniany przez `canvas.width = 0`.
- Push na duckfix-v2 i żywy DuckFix tylko po „Tak” użytkownika.

## Review Focus
1. Długi ciąg identycznych linii („1 szt. x 4,99”): śledzenie nie może przeskoczyć o jeden okres linii. Test w Task 2.
2. Puste fragmenty papieru (koniec paragonu): brak treści nie może dawać fałszywego ruchu ani stanu „zgubiony”. Test w Task 2.
3. Telefon przybliżany i oddalany w trakcie (zmiana skali o ±10%): długość wyniku nadal z błędem ≤ 2%. Test w Task 3.
4. Paragon niewidoczny albo na jasnym tle (brak brzegów): czytelna podpowiedź zamiast nagrywania śmieci. Test w Task 1 i Task 4.
5. „Gotowe” lub „✕” w trakcie nagrywania: „Gotowe” najpierw kończy paragon, „✕” pyta jak dziś, a pętla śledzenia jest zatrzymana. Test w Task 4.

---

### Task 1: Brzegi paragonu i wyprostowany pas

**Files:**
- Create: `src/scan/sweep.ts`
- Test: `tests/scan/sweep.test.ts`

**Interfaces:**
- Produces:
  - `type Strip = { topL: number; topR: number; botL: number; botR: number }` (kolumny brzegów w górnym i dolnym pasie klatki, px);
  - `findStrip(gray: Uint8ClampedArray, w: number, h: number): Strip | null`;
  - `unwarpStrip(gray, w, h, strip: Strip, outW = 96): { data: Uint8ClampedArray; w: number; h: number }`. Paragon jest sprowadzony do szerokości `outW`, wiersze przeskalowane tym samym współczynnikiem, każdy wiersz próbkowany między brzegami interpolowanymi liniowo z góry na dół. To jest jednostka położenia „wiersz pasa”, używana w Task 2 i 3.
  - Generator sztucznych klatek w `tests/scan/sweepFixture.ts`:
    - `makeReceipt(w, h, { seed, repeatFrom?, repeatTo? })`: szare piksele paragonu, z opcjonalnym blokiem identycznych linii;
    - `frameOf(receipt, rw, rh, { y, frameW, frameH, paperW, tiltDeg?, noise? })`: paragon na ciemnym stole (tło ok. 70), papier ok. 245, widoczny pas paragonu od wiersza `y`, przeskalowany do szerokości `paperW`.

- [ ] **Step 1: Testy**
  - `findStrip` na `frameOf(..., {frameW:200, frameH:150, paperW:120})` daje brzegi ±2 px od prawdziwych (40 i 160).
  - Przy `tiltDeg: 3` różnica `topL - botL` ma właściwy znak i wartość ±2 px.
  - Jednolicie jasna klatka (papier na całą szerokość, brak tła) daje `null`. Jednolicie ciemna też `null`.
  - `unwarpStrip` z `outW=96` daje `w === 96`, a wysokość ≈ `150 * 96 / 120` (±1).
- [ ] **Step 2:** `npx vitest run tests/scan/sweep.test.ts`. Oczekiwane: FAIL (brak modułu).
- [ ] **Step 3: Implementacja.** Profil jasności kolumn osobno dla górnych i dolnych 25% wierszy. Próg Otsu między tłem a papierem. Najdłuższy jasny ciąg kolumn musi mieć ≥ 25% i ≤ 95% szerokości, inaczej `null`. Różnica jasności papier−tło musi wynosić ≥ 40, inaczej `null`.
- [ ] **Step 4:** ten sam test. Oczekiwane: PASS.
- [ ] **Step 5:** commit `feat(sweep): find the receipt's edges and straighten its strip`.

### Task 2: Śledzenie przesunięcia i maszyna stanów

**Files:**
- Modify: `src/scan/sweep.ts`
- Test: `tests/scan/sweep.test.ts`

**Interfaces:**
- Consumes: `unwarpStrip`, `rowFeatures` (przeniesione ze starego `src/scan/receipt.ts` do `sweep.ts`, z `BINS = 24`).
- Produces:
  - `trackShift(prev: Float32Array, next: Float32Array, predicted: number, maxFrac = 0.35): { shift: number; score: number; blank: boolean }`. `shift` to liczba wierszy pasa, o które treść przesunęła się do góry. Spośród kandydatów z wynikiem ≤ 1.15 × najlepszy wybierany jest ten najbliższy `predicted`.
  - `createSweep(opts?: { keyFrac?: number; fastFrac?: number; lostTicks?: number })` zwraca obiekt z metodami:
    - `push(feats: Float32Array): { pos: number; state: SweepState; capture: boolean }`;
    - `captured(feats: Float32Array): void`.
  - `type SweepState = 'moving' | 'fast' | 'lost' | 'blank'`.
  - Domyślne opcje: `keyFrac = 0.45`, `fastFrac = 0.2`, `lostTicks = 3`.
  - Pierwsze `push` zwraca `capture: true`. Kolejne `capture` przychodzi, gdy `pos − posOstatniejKlatki ≥ keyFrac × wysokość`. W stanie `lost` nic nie jest łapane, a każda nowa klatka jest porównywana z cechami ostatniej złapanej klatki w oknie całej wysokości. Po dopasowaniu stan wraca do `moving`, a `pos` jest ustawiane od tamtej klatki.
  - `score` ≥ 0.25 przez `lostTicks` kolejnych klatek daje `lost`. Przesunięcie > `fastFrac` × wysokość daje `fast`, ale klatka i tak jest liczona. Pusty papier daje `blank`: `pos` stoi i stan nie zmienia się w `lost`.

- [ ] **Step 1: Testy**
  - Symulacja klatek co 6 wierszy paragonu (`frameOf` → `findStrip` → `unwarpStrip` → `rowFeatures`). Suma `shift` odpowiada prawdziwemu ruchowi ±2%.
  - Ten sam test na paragonie z blokiem 40 identycznych linii (`repeatFrom/repeatTo`): błąd ≤ 2%, nigdy przeskok o okres linii.
  - Skok o 60% wysokości daje `lost` po 3 klatkach. Powrót do miejsca ostatniej klatki przywraca `moving` z poprawnym `pos` (±2).
  - Klatki samego papieru (koniec paragonu) dają `blank`, a `pos` się nie zmienia.
  - `capture` pojawia się przy pierwszej klatce i potem co ~45% wysokości.
- [ ] **Step 2:** uruchomić. Oczekiwane: FAIL.
- [ ] **Step 3:** implementacja według Interfaces.
- [ ] **Step 4:** uruchomić. Oczekiwane: PASS.
- [ ] **Step 5:** commit `feat(sweep): track the receipt frame to frame and pick key frames`.

### Task 3: Układ klatek w jeden paragon

**Files:**
- Modify: `src/scan/sweep.ts`
- Test: `tests/scan/sweep.test.ts`

**Interfaces:**
- Consumes: `createSweep`, `rowFeatures`.
- Produces:
  - `type SweepKey = { pos: number; rows: number; feats: Float32Array }` (`pos` i `rows` w wierszach pasa);
  - `layoutSweep(keys: SweepKey[]): { from: number; to: number }[]`: dla każdej klatki zakres wierszy pasa do wzięcia. Kolejne zakresy stykają się bez nakładki i bez dziury. Każde połączenie jest dopracowane wyszukiwaniem ±6% wysokości wokół spodziewanej zakładki (minimalny błąd, jak w starym `findOverlap`, ale w oknie). Cięcie wypada w środku zakładki. Gdy dopracowanie nic nie znajdzie (pusty papier), zostaje położenie z śledzenia.

- [ ] **Step 1: Testy**
  - Cała ścieżka na sztucznym paragonie 900 wierszy: klatki, potem `createSweep`, potem klucze, potem `layoutSweep`. Suma `to − from` w przeliczeniu na wiersze paragonu daje 900 ±2%. Złożony z wyciętych zakresów obraz zgadza się z oryginałem (średnia różnica pikseli < 12).
  - To samo przy płynnej zmianie `paperW` od 110 do 130 (przybliżanie): długość ±2%.
  - To samo z blokiem identycznych linii: brak dubli (porównanie z oryginałem jak wyżej).
- [ ] **Step 2:** uruchomić. Oczekiwane: FAIL.
- [ ] **Step 3:** implementacja.
- [ ] **Step 4:** uruchomić. Oczekiwane: PASS.
- [ ] **Step 5:** commit `feat(sweep): lay key frames out into one receipt`.

### Task 4: Nagrywanie w aparacie

**Files:**
- Create: `src/scan/sweepFrame.ts`, `src/ui/receiptSweep.ts`
- Modify: `src/ui/camera.tsx`, `src/ui/app.css`, `src/i18n/{pl,en,de,es}.ts`
- Test: `tests/ui/scan.test.tsx` (zastąpienie dwóch starych testów „Paragon”)

**Interfaces:**
- `sweepFrame.ts` (canvas, w testach UI mockowany):
  - `grabGray(video, canvas, width): { gray; w; h; light } | null`;
  - `cutKey(video, strip: Strip, smallW: number): Promise<{ blob: Blob; thumb: string }>`: pełna klatka obrócona o kąt paragonu, przycięta do jego szerokości, JPEG 0.9, z miniaturką o szerokości 48 px;
  - `composeSweep(blobs: Blob[], ranges: { from: number; to: number }[], keys: SweepKey[]): Promise<Blob>`: szerokość min(1240, najwęższa klatka), zakresy przeliczone z wierszy pasa (96 kolumn) na piksele.
- `receiptSweep.ts`: `useReceiptSweep(video: RefObject<HTMLVideoElement>, enabled: boolean)` zwraca:
  - `recording: boolean`;
  - `start(): void`;
  - `stop(): Promise<File | null>` (plik `paragon-<czas>.jpg`, dodany do `takenByHand`, żeby przycinanie wzięło cały obraz);
  - `hint: string`, `warn: boolean`;
  - `edges: Pt[] | null` (dwa brzegi w układzie widoku);
  - `thumbs: string[]`;
  - `seconds: number`.
  - Pętla: `setTimeout` z opóźnieniem `Math.min(250, Math.max(60, 2 × koszt))`. Limit 30 klatek kończy nagrywanie samo, z komunikatem `sweepFull`. Każde nowe przejście w `fast` daje `navigator.vibrate?.(30)`. `light < DARK` daje podpowiedź `sweepDark`.
- `camera.tsx`:
  - w trybie `receipt` pętla `analyzeFrame` i samoczynne zdjęcia są wyłączone (warunek efektu: `auto && mode !== 'receipt'`);
  - spust woła `start`/`stop`, a podczas nagrywania ma klasę `stop` i `aria-label={strings.sweepStop}`;
  - `stop` dodaje jeden `Shot` (miniaturka z ostatniej klatki, `file` = obietnica z `stop()`);
  - „Gotowe” w trakcie nagrywania najpierw czeka na `stop()`;
  - nakładka: dwie pomarańczowe kreski brzegów, pasek miniaturek z prawej, czerwony licznik czasu;
  - zmiana trybu w trakcie nagrywania jest zablokowana (przyciski trybów `disabled`).
- Nowe klucze i18n (pl): `sweepStart: 'Ustaw górę paragonu i naciśnij spust'`, `sweepMove: 'Przesuwaj powoli w dół'`, `sweepFast: 'Wolniej'`, `sweepLost: 'Wróć trochę wyżej'`, `sweepDark: 'Za ciemno — włącz latarkę'`, `sweepNoReceipt: 'Nie widzę paragonu — połóż go na ciemniejszym tle'`, `sweepFull: 'Paragon jest bardzo długi — zakończyłem nagrywanie'`, `sweepStop: 'Zakończ paragon'`. Plus odpowiedniki en/de/es.

- [ ] **Step 1: Testy UI** (mock `src/scan/sweepFrame` i `src/scan/sweep`, `createSweep` sterowany z testu)
  - Tryb „Paragon” pokazuje `sweepStart`. Po kliknięciu spustu przycisk ma etykietę `sweepStop`, a podpowiedź `sweepMove`.
  - Stan `fast` daje podpowiedź `sweepFast` i woła `navigator.vibrate`. Stan `lost` daje `sweepLost`.
  - Brak brzegów (`findStrip` zwraca `null`) daje `sweepNoReceipt`, bez łapania klatek.
  - Kliknięcie „Zakończ paragon” dodaje 1 zdjęcie (licznik 1). „Gotowe” otwiera przycinanie, „Dodaj” woła `importFiles` raz, a `composeSweep` jest wołane raz.
  - „Gotowe” w trakcie nagrywania: najpierw koniec paragonu, potem przycinanie z 1 zdjęciem.
  - W trybie „Paragon” `analyzeFrame` nie jest wołane i samoczynne zdjęcie nie powstaje.
  - 30 klatek kończy nagrywanie samo i pokazuje `sweepFull`.
- [ ] **Step 2:** `npx vitest run tests/ui/scan.test.tsx`. Oczekiwane: FAIL.
- [ ] **Step 3:** implementacja według Interfaces. Style w `app.css` w bloku „camera, look A” (zmienne `--cam-*`, `var(--accent)`).
- [ ] **Step 4:** uruchomić. Oczekiwane: PASS.
- [ ] **Step 5:** commit `feat(camera): Paragon records the receipt while the phone moves`.

### Task 5: Usunięcie starej ścieżki „Paragon ze zdjęć”

**Files:**
- Delete: `src/scan/receipt.ts`, `tests/scan/receipt.test.ts`
- Modify: `src/ui/ScanCrop.tsx` (usunąć `receiptParts`, `finishReceipt`, `isReceipt`/`receiptLater`/`receiptPart` i etykietę części), `src/ui/store.ts` (usunąć `scanReceiptFiles` i parametr `receiptFiles` w `setScanPhotos`), `src/ui/camera.tsx` (`onDone` bez `receiptFiles`, `Shot.receipt` zostaje tylko jeśli potrzebne do miniaturki), i18n (usunąć `receiptStep`, `cropReceiptPart`)
- Test: `tests/ui/scan.test.tsx` (mock `src/scan/receipt` usunięty)

**Interfaces:**
- Consumes: plik z `useReceiptSweep().stop()`, oznaczony w `takenByHand`.

- [ ] **Step 1:** `grep -rn "composeReceipt\|scanReceiptFiles\|receiptStep\|cropReceiptPart\|receiptParts" src tests`. Oczekiwane: lista miejsc do usunięcia.
- [ ] **Step 2:** usunąć i uprościć. Paragon na przycinaniu to zwykłe zdjęcie z ramką na całym obrazie.
- [ ] **Step 3:** `npx tsc --noEmit -p .` i `timeout 400 npx vitest run`. Oczekiwane: 0 błędów, wszystkie testy PASS. Ten sam `grep` nic nie zwraca.
- [ ] **Step 4:** commit `refactor: drop the photo-by-photo Paragon`.

### Task 6: Sprawdzenie końcowe

- [ ] `npx prettier --check` na zmienionych plikach, `npx tsc --noEmit -p .`, `timeout 400 npx vitest run`, `npx vite build`. Oczekiwane: bez błędów.
- [ ] Podgląd `wduck-dev`: tryb „Paragon” się otwiera, spust zmienia się w „Zakończ paragon”, w konsoli brak błędów. Udawana kamera w panelu daje obraz 2×2, więc samego składania tu nie widać.
- [ ] Zrzut ekranu dla użytkownika. Prośba o test na prawdziwym paragonie i Redmi. Pytanie o wysyłkę na v2.
