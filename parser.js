/*
 * Amex Statement Parser
 * Parses text extracted from an American Express Japan
 * "ご利用代金明細書" (statement of account) PDF into structured
 * transaction rows. Designed to be resilient to the layout differences
 * between personal / business / additional (family / corporate sub-)
 * card statements, since exact wording can vary slightly by card product.
 *
 * Exposes a single global: window.AmexParser
 */
(function () {
  "use strict";

  // Converts fullwidth ASCII punctuation/digits/letters (U+FF01-FF5E) to
  // their halfwidth equivalents (offset -0xFEE0), plus a couple of special
  // cases used for negative amounts and the ideographic space. Deliberately
  // does NOT touch "ー" (U+30FC, katakana prolonged sound mark) since that is
  // a normal part of Japanese words (e.g. "コーヒー") and not a minus sign.
  function toHalfWidth(str) {
    let out = "";
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code >= 0xFF01 && code <= 0xFF5E) {
        out += String.fromCharCode(code - 0xFEE0);
      } else if (ch === "　") {
        out += " ";
      } else if (ch === "−") { // minus sign
        out += "-";
      } else {
        out += ch;
      }
    }
    return out;
  }

  function normalizeLine(line) {
    return toHalfWidth(line).replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------
  // American Express Japan statements are exported as pages made entirely
  // of embedded raster images (no real text layer at all -- confirmed by
  // inspecting the PDF's content stream, which contains only
  // paintImageXObject/paintImageMaskXObject operators). So instead of
  // pdf.js text extraction, we render each page to a canvas and run OCR
  // (Tesseract.js, fully client-side/WASM) on it. This keeps the "nothing
  // ever leaves the browser" privacy guarantee intact.
  // ---------------------------------------------------------------------

  const OCR_SCALE = 2.2;
  const OCR_LANGS = "eng+jpn";

  let workerPromise = null;
  let activeProgressHandler = null;

  function absUrl(path) {
    return new URL(path, document.baseURI).toString();
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = window.Tesseract.createWorker(OCR_LANGS, 1, {
        workerPath: absUrl("vendor/tesseract/worker.min.js"),
        corePath: absUrl("vendor/tesseract/"),
        langPath: absUrl("vendor/tessdata/"),
        gzip: true,
        logger: (m) => { if (activeProgressHandler) activeProgressHandler(m); },
      }).then(async (worker) => {
        // Whole-page uniform text block: this statement layout is a plain
        // list of rows, not a real multi-column page, so we skip Tesseract's
        // (slower, and here unnecessary) automatic layout/column analysis.
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
        return worker;
      });
    }
    return workerPromise;
  }

  async function renderPageToCanvas(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  /** Cheap sampled check to skip pages that are entirely (or almost) blank. */
  function isBlankCanvas(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
    const data = ctx.getImageData(0, 0, width, height).data;
    let sampled = 0;
    let nonWhite = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const v = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        sampled++;
        if (v < 250) nonWhite++;
      }
    }
    return sampled === 0 || nonWhite / sampled < 0.002;
  }

  /**
   * Binarizes the canvas in place using Otsu's method. Scanned/rasterized
   * statement pages tend to have anti-aliased gray noise around glyph edges;
   * collapsing everything to pure black/white substantially helps both OCR
   * speed and accuracy.
   */
  function binarizeCanvas(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const n = d.length / 4;

    const hist = new Uint32Array(256);
    const gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      gray[p] = v;
      hist[v]++;
    }

    // Otsu's method: find the threshold that maximizes inter-class variance.
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = n - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);
      if (variance > maxVar) { maxVar = variance; threshold = t; }
    }

    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const out = gray[p] < threshold ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = out;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /** Flattens Tesseract's block > paragraph > line hierarchy into ordered text lines. */
  function flattenOcrLines(data) {
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = normalizeLine(line.text || "");
          if (text) lines.push({ y: line.bbox ? line.bbox.y0 : 0, text });
        }
      }
    }
    lines.sort((a, b) => a.y - b.y);
    return lines.map((l) => l.text);
  }

  /**
   * Renders every page of the PDF and OCRs it, returning an ordered list of
   * {page, text} lines, ready for parseLines(). onProgress, if given, is
   * called with { page, numPages, tesseract } while a page is being OCR'd.
   */
  async function extractLinesFromPdf(arrayBuffer, { onProgress } = {}) {
    const loadingTask = window.pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: absUrl("vendor/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: absUrl("vendor/pdfjs/standard_fonts/"),
    });
    const pdf = await loadingTask.promise;
    const worker = await getWorker();
    const allLines = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const canvas = await renderPageToCanvas(page, OCR_SCALE);

      if (isBlankCanvas(canvas)) continue;
      binarizeCanvas(canvas);

      activeProgressHandler = (m) => {
        if (onProgress) onProgress({ page: pageNum, numPages: pdf.numPages, tesseract: m });
      };
      let data;
      try {
        ({ data } = await worker.recognize(canvas, {}, { blocks: true }));
      } finally {
        activeProgressHandler = null;
      }

      for (const line of flattenOcrLines(data)) allLines.push({ page: pageNum, text: line });
    }
    return allLines;
  }

  const RE_DATE = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日\b/;
  const RE_SECTION_START = /今月ご利用額\s*(.+?)\s*様/;
  const RE_SECTION_END = /(.+?)\s*様\s*今月ご利用額合計\s*([-]?[\d,]+)/;
  const RE_PERIOD = /明細書作成対象期間\s*(\d{4})年(\d{1,2})月(\d{1,2})日から(\d{4})年(\d{1,2})月(\d{1,2})日まで/;
  const RE_STATEMENT_DATE = /明細書作成日[^0-9]*(\d{4})年(\d{1,2})月(\d{1,2})日/;
  const RE_MEMBER_NO = /(\*{3,4}[-_]\*{5,7}-\d{3,6})/;
  const RE_GRAND_TOTAL = /今回ご利用[・･]ご請求金額合計\s*([-]?[\d,]+)/;
  const RE_TRAILING_NUMBER = /([-]?\d[\d,]*)\s*\*?\s*$/;

  function extractLastNumber(line) {
    const m = line.match(RE_TRAILING_NUMBER);
    if (!m) return null;
    const num = parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isNaN(num)) return null;
    return { value: num, matchText: m[0], index: m.index };
  }

  function resolveYear(month, period, statementDate) {
    if (period) {
      const { startYear, startMonth, endYear, endMonth } = period;
      if (month === startMonth) return startYear;
      if (month === endMonth) return endYear;
      if (startMonth <= endMonth) {
        // same-year period, e.g. Jan 20 - Feb 19
        return month >= startMonth && month <= endMonth ? startYear : endYear;
      }
      // wraps around a new year, e.g. Dec 20 - Jan 19
      return month >= startMonth ? startYear : endYear;
    }
    if (statementDate) {
      const { year, month: stMonth } = statementDate;
      return month > stMonth ? year - 1 : year;
    }
    return new Date().getFullYear();
  }

  /**
   * Parses one statement's worth of lines into transactions + metadata.
   */
  function parseLines(lines, sourceFileName) {
    const rawTexts = lines.map((l) => l.text);

    let period = null;
    let statementDate = null;
    let memberNo = null;
    let grandTotal = null;

    for (const text of rawTexts) {
      if (!period) {
        const m = text.match(RE_PERIOD);
        if (m) {
          period = {
            startYear: +m[1], startMonth: +m[2], startDay: +m[3],
            endYear: +m[4], endMonth: +m[5], endDay: +m[6],
          };
        }
      }
      if (!statementDate) {
        const m = text.match(RE_STATEMENT_DATE);
        if (m) statementDate = { year: +m[1], month: +m[2], day: +m[3] };
      }
      if (!memberNo) {
        const m = text.match(RE_MEMBER_NO);
        if (m) memberNo = m[1];
      }
      if (grandTotal === null) {
        const m = text.match(RE_GRAND_TOTAL);
        if (m) grandTotal = parseInt(m[1].replace(/,/g, ""), 10);
      }
    }

    const transactions = [];
    const sectionTotals = []; // { cardholder, statedTotal, parsedTotal }
    let currentHolder = null;
    let collecting = false;
    let currentHolderTxIndices = [];

    for (const text of rawTexts) {
      if (text.includes("合計")) {
        const endMatch = text.match(RE_SECTION_END);
        if (endMatch && collecting) {
          const stated = parseInt(endMatch[2].replace(/,/g, ""), 10);
          const parsedSum = currentHolderTxIndices.reduce(
            (sum, idx) => sum + transactions[idx].amount, 0
          );
          sectionTotals.push({
            cardholder: currentHolder,
            statedTotal: stated,
            parsedTotal: parsedSum,
          });
        }
        collecting = false;
        currentHolder = null;
        currentHolderTxIndices = [];
        continue;
      }

      const startMatch = text.match(RE_SECTION_START);
      if (startMatch) {
        currentHolder = startMatch[1].replace(/\s+/g, "");
        collecting = true;
        currentHolderTxIndices = [];
        continue;
      }

      if (!collecting) continue;

      const dateMatch = text.match(RE_DATE);
      if (!dateMatch) continue;

      const month = +dateMatch[1];
      const day = +dateMatch[2];
      const numberInfo = extractLastNumber(text);
      if (!numberInfo) continue;

      let description = text
        .slice(dateMatch[0].length, numberInfo.index)
        .replace(/[-]\s*$/, "")
        .trim();
      if (!description) description = "(内容不明)";

      const year = resolveYear(month, period, statementDate);
      const dateObj = new Date(year, month - 1, day);

      const tx = {
        cardholder: currentHolder || "(不明)",
        year, month, day,
        date: dateObj,
        merchant: description,
        category: "",
        amount: numberInfo.value,
        sourceFile: sourceFileName,
      };
      transactions.push(tx);
      currentHolderTxIndices.push(transactions.length - 1);

      // Peek: the very next non-date, non-total line is usually a category
      // label (e.g. "広告代理店/関連サービス"). We attach it in a second pass
      // below using line adjacency, since we only have flat text here.
    }

    // Second pass to attach category lines: a category line is a line that
    // immediately follows a transaction line, contains no date pattern, no
    // trailing amount, and no section markers.
    attachCategories(rawTexts, transactions);

    return { transactions, period, statementDate, memberNo, grandTotal, sectionTotals };
  }

  function attachCategories(rawTexts, transactions) {
    // Rebuild a pointer walk: find each transaction's originating line index
    // by re-scanning with the same state logic, then check the next line.
    let collecting = false;
    let txCursor = 0;
    for (let i = 0; i < rawTexts.length; i++) {
      const text = rawTexts[i];
      if (text.includes("合計")) { collecting = false; continue; }
      if (RE_SECTION_START.test(text)) { collecting = true; continue; }
      if (!collecting) continue;
      if (RE_DATE.test(text) && extractLastNumber(text)) {
        const next = rawTexts[i + 1];
        if (
          next &&
          !RE_DATE.test(next) &&
          !next.includes("合計") &&
          !RE_SECTION_START.test(next) &&
          !extractLastNumber(next)
        ) {
          if (transactions[txCursor]) transactions[txCursor].category = next.trim();
        }
        txCursor++;
      }
    }
  }

  window.AmexParser = {
    extractLinesFromPdf,
    parseLines,
    normalizeLine,
    _internal: { resolveYear, extractLastNumber, binarizeCanvas, isBlankCanvas },
  };
})();
