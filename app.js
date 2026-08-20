(function () {
  "use strict";

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";

  const dropzone = document.getElementById("dropzone");
  const pickBtn = document.getElementById("pick-btn");
  const fileInput = document.getElementById("file-input");
  const fileListEl = document.getElementById("file-list");
  const resultsSection = document.getElementById("results-section");
  const txTbody = document.getElementById("tx-tbody");
  const footerTotal = document.getElementById("footer-total");
  const totalsSummary = document.getElementById("totals-summary");
  const addRowBtn = document.getElementById("add-row-btn");
  const resetBtn = document.getElementById("reset-btn");
  const exportBtn = document.getElementById("export-btn");
  const toast = document.getElementById("toast");

  let rowCounter = 0;
  let toastTimer = null;

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatDateForCell(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  }

  function formatDateForFilename(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  }

  function parseDateCellText(text) {
    const m = String(text).trim().match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function parseAmountCellText(text) {
    const cleaned = String(text).replace(/[,\s円¥]/g, "");
    const num = parseInt(cleaned, 10);
    return Number.isNaN(num) ? 0 : num;
  }

  // ---------- File list UI ----------

  function fileListItemEl(name) {
    return fileListEl.querySelector(`[data-file="${CSS.escape(name)}"]`);
  }

  function addFileListItem(name) {
    const li = document.createElement("li");
    li.className = "file-item";
    li.dataset.file = name;
    li.innerHTML = `
      <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="status-pill pending">待機中</span>
    `;
    const progress = document.createElement("div");
    progress.className = "progress-track";
    progress.innerHTML = `<div class="progress-fill"></div>`;
    li.appendChild(progress);
    fileListEl.appendChild(li);
    return li;
  }

  function updateFileListItem(name, status, detailText) {
    const li = fileListItemEl(name);
    if (!li) return;
    const pill = li.querySelector(".status-pill");
    const labels = { ok: "OK", warn: "要確認", error: "失敗", busy: "OCR処理中" };
    pill.className = `status-pill ${status === "busy" ? "pending" : status}`;
    pill.textContent = labels[status] || status;
    let detail = li.querySelector(".file-detail");
    if (!detail) {
      detail = document.createElement("div");
      detail.className = "file-detail";
      li.appendChild(detail);
    }
    detail.textContent = detailText || "";
    if (status !== "busy") {
      const track = li.querySelector(".progress-track");
      if (track) track.remove();
    }
  }

  function updateFileProgress(name, fraction, label) {
    const li = fileListItemEl(name);
    if (!li) return;
    const fill = li.querySelector(".progress-fill");
    if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    updateFileListItem(name, "busy", label);
  }

  // ---------- Table rendering ----------

  function makeRow(tx) {
    const id = ++rowCounter;
    const tr = document.createElement("tr");
    tr.dataset.id = String(id);
    tr.innerHTML = `
      <td class="col-del"><button type="button" class="row-del-btn" title="この行を削除">✕</button></td>
      <td class="col-date" contenteditable="true">${escapeHtml(formatDateForCell(tx.date))}</td>
      <td class="col-holder" contenteditable="true">${escapeHtml(tx.cardholder || "")}</td>
      <td class="col-merchant" contenteditable="true">${escapeHtml(tx.merchant || "")}</td>
      <td class="col-category" contenteditable="true">${escapeHtml(tx.category || "")}</td>
      <td class="col-amount" contenteditable="true" data-role="amount">${(tx.amount || 0).toLocaleString("ja-JP")}</td>
      <td class="col-source" title="${escapeHtml(tx.sourceFile || "")}">${escapeHtml(tx.sourceFile || "")}</td>
    `;
    return tr;
  }

  function appendTransactionsToTable(transactions) {
    const frag = document.createDocumentFragment();
    for (const tx of transactions) frag.appendChild(makeRow(tx));
    txTbody.appendChild(frag);
    resultsSection.hidden = false;
    recalcTotals();
  }

  function addBlankRow() {
    const tr = makeRow({
      date: new Date(),
      cardholder: "",
      merchant: "",
      category: "",
      amount: 0,
      sourceFile: "(手動入力)",
    });
    txTbody.appendChild(tr);
    resultsSection.hidden = false;
    recalcTotals();
    tr.querySelector(".col-merchant").focus();
  }

  function recalcTotals() {
    let total = 0;
    let count = 0;
    txTbody.querySelectorAll("tr").forEach((tr) => {
      const amtCell = tr.querySelector('[data-role="amount"]');
      total += parseAmountCellText(amtCell.textContent);
      count++;
    });
    footerTotal.textContent = total.toLocaleString("ja-JP");
    totalsSummary.textContent = count > 0
      ? `取引 ${count.toLocaleString("ja-JP")} 件 / 合計 ¥${total.toLocaleString("ja-JP")}`
      : "";
    exportBtn.disabled = count === 0;
  }

  txTbody.addEventListener("input", (e) => {
    if (e.target.closest('[data-role="amount"]')) recalcTotals();
  });

  txTbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".row-del-btn");
    if (!btn) return;
    btn.closest("tr").remove();
    recalcTotals();
  });

  // ---------- File processing ----------

  function buildFileDetailText(result) {
    const parts = [];
    if (result.period) {
      const p = result.period;
      parts.push(`${p.startYear}/${pad2(p.startMonth)}/${pad2(p.startDay)}〜${p.endYear}/${pad2(p.endMonth)}/${pad2(p.endDay)}`);
    }
    parts.push(`取引 ${result.transactions.length} 件`);
    const parsedTotal = result.transactions.reduce((s, t) => s + t.amount, 0);
    if (result.grandTotal !== null && result.grandTotal !== undefined) {
      const ok = result.grandTotal === parsedTotal;
      parts.push(`合計 ${parsedTotal.toLocaleString("ja-JP")}円 ${ok ? "✓ 明細書記載額と一致" : `⚠ 明細書記載額(${result.grandTotal.toLocaleString("ja-JP")}円)と不一致`}`);
    } else {
      parts.push(`合計 ${parsedTotal.toLocaleString("ja-JP")}円`);
    }
    return parts.join(" / ");
  }

  const TESSERACT_STATUS_JA = {
    "loading tesseract core": "OCRエンジンを読み込み中",
    "initializing tesseract": "OCRエンジンを初期化中",
    "loading language traineddata": "言語データを読み込み中",
    "initializing api": "準備中",
    "recognizing text": "文字を認識中",
  };

  async function processFile(file) {
    addFileListItem(file.name);
    try {
      const buf = await file.arrayBuffer();
      const lines = await window.AmexParser.extractLinesFromPdf(buf, {
        onProgress: (info) => {
          const overall = ((info.page - 1) + (info.tesseract && info.tesseract.progress || 0)) / info.numPages;
          const statusJa = (info.tesseract && TESSERACT_STATUS_JA[info.tesseract.status]) || "処理中";
          updateFileProgress(file.name, overall, `${statusJa}...（ページ ${info.page}/${info.numPages}）`);
        },
      });
      const result = window.AmexParser.parseLines(lines, file.name);

      if (result.transactions.length === 0) {
        updateFileListItem(file.name, "warn", "取引明細を検出できませんでした。このカード種別/レイアウトには対応していない可能性があります。");
        console.warn(`[${file.name}] no transactions detected. Extracted lines:`, lines.map((l) => l.text));
        return;
      }

      updateFileListItem(file.name, "ok", buildFileDetailText(result));
      appendTransactionsToTable(result.transactions);
    } catch (err) {
      console.error(err);
      updateFileListItem(file.name, "error", `PDFの解析に失敗しました（${err && err.message ? err.message : err}）`);
    }
  }

  async function handleFiles(fileListLike) {
    const files = Array.from(fileListLike).filter(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
    );
    if (files.length === 0) {
      showToast("PDFファイルを選択してください");
      return;
    }
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await processFile(file);
    }
  }

  // ---------- Drag & drop / file picker ----------

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // ---------- Toolbar actions ----------

  addRowBtn.addEventListener("click", addBlankRow);

  resetBtn.addEventListener("click", () => {
    if (txTbody.children.length && !confirm("読み込んだ内容をすべて消去して最初からやり直しますか？")) return;
    txTbody.innerHTML = "";
    fileListEl.innerHTML = "";
    resultsSection.hidden = true;
    recalcTotals();
  });

  exportBtn.addEventListener("click", () => {
    const rows = [];
    txTbody.querySelectorAll("tr").forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      const dateText = cells[1].textContent.trim();
      const parsedDate = parseDateCellText(dateText);
      rows.push({
        dateValue: parsedDate || dateText,
        holder: cells[2].textContent.trim(),
        merchant: cells[3].textContent.trim(),
        category: cells[4].textContent.trim(),
        amount: parseAmountCellText(cells[5].textContent),
        source: cells[6].textContent.trim(),
      });
    });
    if (rows.length === 0) return;

    const wb = XLSX.utils.book_new();

    const header = ["日付", "利用者", "利用先", "カテゴリ", "金額（円）", "明細書"];
    const aoa = [header, ...rows.map((r) => [r.dateValue, r.holder, r.merchant, r.category, r.amount, r.source])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 30 }, { wch: 24 }, { wch: 13 }, { wch: 30 }];
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: header.length - 1 } }) };
    for (let r = 1; r < aoa.length; r++) {
      const amtRef = XLSX.utils.encode_cell({ r, c: 4 });
      if (ws[amtRef]) ws[amtRef].z = "#,##0";
      const dateRef = XLSX.utils.encode_cell({ r, c: 0 });
      if (ws[dateRef] && ws[dateRef].t === "d") ws[dateRef].z = "yyyy/mm/dd";
    }
    XLSX.utils.book_append_sheet(wb, ws, "取引明細");

    const byHolder = new Map();
    const byCategory = new Map();
    let grand = 0;
    for (const r of rows) {
      byHolder.set(r.holder || "(未設定)", (byHolder.get(r.holder || "(未設定)") || 0) + r.amount);
      const cat = r.category || "(未分類)";
      byCategory.set(cat, (byCategory.get(cat) || 0) + r.amount);
      grand += r.amount;
    }
    const summaryAoa = [
      ["利用者別集計"],
      ["利用者", "金額（円）"],
      ...Array.from(byHolder.entries()),
      [],
      ["カテゴリ別集計"],
      ["カテゴリ", "金額（円）"],
      ...Array.from(byCategory.entries()),
      [],
      ["合計", grand],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(summaryAoa);
    ws2["!cols"] = [{ wch: 28 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws2, "集計");

    XLSX.writeFile(wb, `Amex利用明細_${formatDateForFilename(new Date())}.xlsx`);
    showToast("Excelファイルをダウンロードしました");
  });

  recalcTotals();
})();
