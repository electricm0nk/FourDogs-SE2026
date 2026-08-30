// Southeast Pet 2026 Order Builder
// Single-file app. Loaded as <script type="module">.

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

const { PDFDocument } = window.PDFLib;

const PDF_URL = "assets/2026-Trade-Show-Book.pdf";
const DATA_URL = "data/data.json";
const STORE_KEY = "sepet2026_order_v1";
const SCHEMA_VERSION = 1;
const ORDER_MIN = 700;

// === State ===
const state = window._state = {
  data: null,
  pdfBytes: null,
  pdfBytesForLib: null,
  pdfjsDoc: null,
  currentVendor: null,
  order: {}, // key "page|widget" -> qty string
  vendorMeta: {}, // vendorName -> { notes }
  textFields: {}, // key "page|widget" -> text string
  checkboxFields: {}, // key "page|widget" -> checked
  buyer: { storeName: "", city: "" },
  master: { hiddenVendors: {} }, // vendorName -> bool (true = hidden in sidebar)
  filesHandle: null, // FileSystemFileHandle for iPad Safari auto-save
  filesHandleName: null,
};

// === DOM helpers ===
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, ms = 1800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function setSaveState(label, kind = "") {
  const el = $("#saveState");
  el.textContent = label;
  el.classList.remove("ok", "warn");
  if (kind) el.classList.add(kind);
}

function showModal(html) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.add("open");
}

function hideModal() {
  $("#modal").classList.remove("open");
}

// === Persistence ===
function loadOrder() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.version === SCHEMA_VERSION) {
      state.order = parsed.order || {};
      state.vendorMeta = parsed.vendorMeta || {};
      state.textFields = parsed.textFields || {};
      state.checkboxFields = parsed.checkboxFields || {};
      state.buyer.storeName = parsed.buyer?.storeName || "";
      state.buyer.city = parsed.buyer?.city || "";
      state.master = parsed.master || { hiddenVendors: {} };
      if (!state.master.hiddenVendors) state.master.hiddenVendors = {};
    }
  } catch (e) {
    console.warn("failed to load order:", e);
  }
 }
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
  setSaveState("Saving…");
}

function persist() {
  try {
    const payload = JSON.stringify({
      version: SCHEMA_VERSION,
      order: state.order,
      vendorMeta: state.vendorMeta,
      textFields: state.textFields,
      checkboxFields: state.checkboxFields,
      buyer: state.buyer,
      master: state.master,
      savedAt: new Date().toISOString(),
    });
    localStorage.setItem(STORE_KEY, payload);
    // If we have a Files handle, also write silently to iPad Files / iCloud Drive
    if (state.filesHandle) {
      writeToFilesHandle(payload).catch((e) => {
        console.warn("Files auto-save failed:", e);
      });
    }
  } catch (e) {
    console.warn("persist failed", e);
    setSaveState("Save failed — backup now!", "warn");
  }
}

// === Files app integration (iPad Safari) ===
function filesApiSupported() {
  return typeof window.showSaveFilePicker === "function" ||
         typeof window.showOpenFilePicker === "function";
}

async function saveToFiles() {
  if (!filesApiSupported()) {
    showModal(
      "<h3>Files app not supported</h3>" +
      "<p>Your browser doesn't support saving directly to the Files app. Use <strong>Backup JSON</strong> instead and drop the file into Files / iCloud Drive manually.</p>" +
      '<div class="modal-actions"><button id="cm-ok">OK</button></div>'
    );
    document.getElementById("cm-ok").onclick = hideModal;
    return;
  }
  try {
    const payload = JSON.stringify({
      version: SCHEMA_VERSION,
      order: state.order,
      vendorMeta: state.vendorMeta,
      buyer: state.buyer,
      savedAt: new Date().toISOString(),
    }, null, 2);
    const handle = await window.showSaveFilePicker({
      suggestedName: state.filesHandleName || "sepet2026-order.json",
      types: [{ description: "Order JSON", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(payload);
    await writable.close();
    state.filesHandle = handle;
    state.filesHandleName = handle.name || "sepet2026-order.json";
    setSaveState("Saved ✓ to " + state.filesHandleName, "ok");
    toast("Saved to Files: " + state.filesHandleName, 2500);
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelled
    console.warn("saveToFiles failed", e);
    showModal(
      "<h3>Save to Files failed</h3>" +
      "<p>" + escapeHtml(e.message || String(e)) + "</p>" +
      "<p>Try again, or use Backup JSON as a fallback.</p>" +
      '<div class="modal-actions"><button id="cm-ok">OK</button></div>'
    );
    document.getElementById("cm-ok").onclick = hideModal;
  }
}

async function writeToFilesHandle(payload) {
  if (!state.filesHandle) return;
  try {
    // verify permission (may have been revoked)
    if (state.filesHandle.queryPermission) {
      const perm = await state.filesHandle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        const req = await state.filesHandle.requestPermission({ mode: "readwrite" });
        if (req !== "granted") {
          setSaveState("Files permission needed — tap Save to Files", "warn");
          return;
        }
      }
    }
    const writable = await state.filesHandle.createWritable();
    await writable.write(payload);
    await writable.close();
  } catch (e) {
    console.warn("writeToFilesHandle failed:", e);
    throw e;
  }
}

async function restoreFromFiles() {
  if (!filesApiSupported()) {
    showModal(
      "<h3>Files picker not supported</h3>" +
      "<p>Use the regular Restore JSON button and pick from Files.</p>" +
      '<div class="modal-actions"><button id="cm-ok">OK</button></div>'
    );
    document.getElementById("cm-ok").onclick = hideModal;
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Order JSON", accept: { "application/json": [".json"] } }],
    });
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.version !== SCHEMA_VERSION) {
      toast("Backup version mismatch", 2500);
      return;
    }
    state.order = parsed.order || {};
    state.vendorMeta = parsed.vendorMeta || {};
    Object.assign(state.buyer, parsed.buyer || {});
    persist();
    $("#main").innerHTML = "";
    renderToolbarIntoMain();
    renderVendorView(state.currentVendor);
    updateVendorNavIndicators();
    toast("Restored from " + file.name);
  } catch (e) {
    if (e && e.name === "AbortError") return;
    console.warn("restoreFromFiles failed", e);
    toast("Restore failed", 2500);
  }
}

// === Boot ===
async function boot() {
  setSaveState("Loading data…");
  console.log("[boot] start");
   try {
    const [pdfResp, dataResp] = await Promise.all([
      fetch(PDF_URL, { cache: "force-cache" }),
      fetch(DATA_URL, { cache: "force-cache" }),
    ]);
    if (!pdfResp.ok) throw new Error("PDF fetch failed: " + pdfResp.status);
    if (!dataResp.ok) throw new Error("data.json fetch failed: " + dataResp.status);
    state.pdfBytes = await pdfResp.arrayBuffer();
    state.data = await dataResp.json();
  } catch (e) {
    console.error(e);
    setSaveState("Failed to load — check connection", "warn");
    showModal(
      "<h3>Couldn't load data</h3>" +
      "<p>" + escapeHtml(e.message) + "</p>" +
      "<p>Make sure you're connected to wifi and reload. If this persists, restore from a backup JSON.</p>" +
      '<div class="modal-actions"><button class="secondary" id="cm-close">Close</button></div>'
    );
    document.getElementById("cm-close").onclick = hideModal;
    return;
  }

  loadOrder();

  // load PDF.js doc (clone bytes because pdf.js consumes them)
  state.pdfjsDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice(0) }).promise;
  state.pdfBytesForLib = state.pdfBytes.slice(0);

  buildVendorList();
  selectMaster();

  setSaveState("Ready ✓", "ok");
  $("#sidebarToggle").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
  });

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (e) {
      console.warn("SW registration failed", e);
    }
  }
}

// === Vendor grouping ===
function vendorPages() {
  const map = {};
  for (const p of state.data.pages) {
    if (p.widget_count === 0) continue;
    const v = p.vendor || "Other";
    if (!map[v]) map[v] = [];
    map[v].push(p);
  }
  for (const v of Object.keys(map)) map[v].sort((a, b) => a.index - b.index);
  return map;
}

function buildVendorList() {
  const ul = $("#vendorList");
  ul.innerHTML = "";
  // Master entry first
  const masterLi = document.createElement("li");
  const masterBtn = document.createElement("button");
  masterBtn.textContent = "Master";
  masterBtn.dataset.master = "1";
  masterBtn.classList.add("master-btn");
  masterBtn.addEventListener("click", () => {
    selectMaster();
    $("#sidebar").classList.remove("open");
  });
  masterLi.appendChild(masterBtn);
  ul.appendChild(masterLi);
  const map = vendorPages();
  // Filter out hidden vendors for sidebar display (export still uses all)
  const vendors = Object.keys(map).filter((v) => !state.master.hiddenVendors[v]).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  for (const v of vendors) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = v;
    btn.dataset.vendor = v;
    btn.addEventListener("click", () => {
      selectVendor(v);
      $("#sidebar").classList.remove("open");
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}
function selectMaster() {
  state.currentVendor = null;
  $$("#vendorList button").forEach((b) => {
    b.classList.toggle("active", b.dataset.master === "1");
  });
  const main = $("#main");
  main.innerHTML = "";
  renderBuyerHeader();
  const tpl = $("#masterPanelTemplate");
  const node = tpl.content.firstElementChild.cloneNode(true);
  main.appendChild(node);
  renderToolbarIntoMain();
  $("#main").scrollTop = 0;
}

function selectVendor(vendor) {
  state.currentVendor = vendor;
  $$("#vendorList button").forEach((b) => {
    b.classList.toggle("active", b.dataset.vendor === vendor);
  });
  renderVendorView(vendor);
  $("#main").scrollTop = 0;
}

// === Render: buyer header ===
function renderBuyerHeader() {
  const m = $("#main");
  const div = document.createElement("div");
  div.className = "buyer-header";
  div.innerHTML =
    '<div>' +
      '<label>Store name (writes to all pages)</label>' +
      '<input id="bh-store" placeholder="My Pet Store" value="' + escapeAttr(state.buyer.storeName) + '" />' +
    '</div>' +
    '<div>' +
      '<label>City / State</label>' +
      '<input id="bh-city" placeholder="Atlanta, GA" value="' + escapeAttr(state.buyer.city) + '" />' +
    '</div>';
  div.querySelector("#bh-store").addEventListener("input", (e) => {
    state.buyer.storeName = e.target.value;
    updateBuyerOverlays();
    scheduleSave();
  });
  div.querySelector("#bh-city").addEventListener("input", (e) => {
    state.buyer.city = e.target.value;
    updateBuyerOverlays();
    scheduleSave();
  });
  m.insertBefore(div, m.firstChild);
}

// === Render: toolbar (subtotal + actions) ===
function renderToolbarIntoMain() {
  const m = $("#main");
  // remove old toolbar
  const old = m.querySelector(".toolbar");
  if (old) old.remove();
  const div = document.createElement("div");
  div.className = "toolbar";
  div.innerHTML =
    '<button id="btnSubmit">Submit & Export</button>' +
    '<button class="secondary" id="btnSaveFiles">Save to Files</button>' +
    '<button class="secondary" id="btnBackup">Backup JSON</button>' +
    '<button class="secondary" id="btnRestore">Restore JSON</button>' +
    '<button class="secondary" id="btnClear">Clear Vendor</button>' +
    '<div class="total">' +
      '<div class="label">Subtotal</div>' +
      '<div class="amount" id="subtotalAmt">$0.00</div>' +
      '<div class="min-warn" id="minWarn" style="display:none">Min $' + ORDER_MIN + ' — add more</div>' +
    '</div>';
  m.insertBefore(div, m.children[1]); // after buyer-header
  div.querySelector("#btnSubmit").addEventListener("click", submitOrder);
  div.querySelector("#btnSaveFiles").addEventListener("click", saveToFiles);
  div.querySelector("#btnBackup").addEventListener("click", backupJson);
  div.querySelector("#btnRestore").addEventListener("click", restoreJson);
  div.querySelector("#btnClear").addEventListener("click", clearCurrentVendor);
  recomputeTotals();
}

function renderVendorView(vendor) {
  const main = $("#main");
  // remove everything past the buyer-header + toolbar
  for (const child of Array.from(main.children)) {
    if (!child.classList.contains("buyer-header") && !child.classList.contains("toolbar")) {
      main.removeChild(child);
    }
  }
  if (!vendor) return;

  const map = vendorPages();
  const pages = map[vendor] || [];

  const head = document.createElement("div");
  head.className = "vendor-header";
  const titleRow = document.createElement("div");
  titleRow.className = "vendor-title-row";
  titleRow.innerHTML =
    "<h2>" + escapeHtml(vendor) + "</h2>" +
    '<div class="pages">' + pages.length + " page" + (pages.length !== 1 ? "s" : "") + "</div>";
  head.appendChild(titleRow);
  main.appendChild(head);

  // placeholder area for pages
  const pagesArea = document.createElement("div");
  pagesArea.id = "pagesArea";
  main.appendChild(pagesArea);

  // render pages sequentially (avoid blasting pdf.js)
  renderPagesSequential(pages, pagesArea);
}

async function renderPagesSequential(pages, container) {
  for (const p of pages) {
    const block = await renderPageBlock(p);
    container.appendChild(block);
  }
}

async function renderPageBlock(pageData) {
  const block = document.createElement("div");
  block.className = "page-block";
  block.id = "page-" + pageData.index;
  const title = document.createElement("div");
  title.className = "page-title";
  title.textContent = "Page " + pageData.index + " · " + (pageData.vendor || "—") + " · " + pageData.widget_count + " fields";
  block.appendChild(title);

  const wrap = document.createElement("div");
  wrap.className = "page-canvas-wrap";
  block.appendChild(wrap);

  if (!pageData.has_text && pageData.widget_count === 0) {
    wrap.textContent = "(Empty page — no inputs)";
    return block;
  }

  try {
    const pdfPage = await state.pdfjsDoc.getPage(pageData.index);
    const scale = 1.5;
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // Maintain aspect ratio via CSS. Overlays use % so they scale with the wrap.
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    wrap.style.aspectRatio = viewport.width + " / " + viewport.height;
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    overlayWidgets(wrap, pageData, viewport);
  } catch (e) {
    console.error("render failed for page", pageData.index, e);
    wrap.textContent = "(Failed to render this page)";
  }

  return block;
}

function positionOverlay(el, rect, pageW, pageH) {
  const [x0, y0, x1, y1] = rect;
  el.style.left = (x0 / pageW) * 100 + "%";
  el.style.top = (y0 / pageH) * 100 + "%";
  el.style.width = ((x1 - x0) / pageW) * 100 + "%";
  el.style.height = ((y1 - y0) / pageH) * 100 + "%";
}

function buyerLine() {
  return [state.buyer.storeName, state.buyer.city].filter(Boolean).join(" — ");
}

function updateBuyerOverlays() {
  const value = buyerLine();
  $$(".buyer-overlay").forEach((input) => {
    input.value = value;
  });
}

function setVendorNote(vendor, side, value, source) {
  if (!state.vendorMeta[vendor]) state.vendorMeta[vendor] = { notes: "", noteLeft: "", noteRight: "" };
  state.vendorMeta[vendor][side === "left" ? "noteLeft" : "noteRight"] = value;
  $$(".vendor-note-overlay").forEach((note) => {
    if (note !== source && note.dataset.vendor === vendor && note.dataset.side === side) {
      note.value = value;
    }
  });
  scheduleSave();
}

function addVendorNoteOverlays(wrap, pageData, pageW, pageH) {
  const vendor = pageData.vendor || "Other";
  if (vendor === "Fromm") return;
  const meta = state.vendorMeta[vendor] || {};
  const noteRects = [
    { side: "left", rect: [130, 15, 270, 31] },
    { side: "right", rect: [460, 15, pageW - 17, 31] },
  ];
  for (const { side, rect } of noteRects) {
    const note = document.createElement("input");
    note.type = "text";
    note.className = "vendor-note-overlay";
    note.placeholder = "";
    note.value = side === "left" ? (meta.noteLeft || "") : (meta.noteRight || "");
    note.dataset.vendor = vendor;
    note.dataset.side = side;
    note.setAttribute("aria-label", vendor + " " + side + " note");
    positionOverlay(note, rect, pageW, pageH);
    note.addEventListener("input", () => setVendorNote(vendor, side, note.value, note));
    wrap.appendChild(note);
  }
}

function addFrommControl(wrap, pageData, widget, pageW, pageH) {
  const key = pageData.index + "|" + widget.name;
  if (widget.field_type === "CheckBox") {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "fromm-checkbox-overlay";
    checkbox.checked = Boolean(state.checkboxFields[key]);
    checkbox.dataset.page = pageData.index;
    checkbox.dataset.widget = widget.name;
    checkbox.setAttribute("aria-label", "Fromm page " + pageData.index + " checkbox");
    positionOverlay(checkbox, widget.rect, pageW, pageH);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.checkboxFields[key] = true;
      else delete state.checkboxFields[key];
      scheduleSave();
    });
    wrap.appendChild(checkbox);
    return;
  }
  if (widget.field_type !== "Text") return;

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "text";
  input.className = "fromm-text-overlay";
  input.value = state.textFields[key] || "";
  input.placeholder = "";
  input.dataset.page = pageData.index;
  input.dataset.widget = widget.name;
  input.setAttribute("aria-label", "Fromm page " + pageData.index + " text field");
  positionOverlay(input, widget.rect, pageW, pageH);
  input.addEventListener("input", () => {
    if (input.value) state.textFields[key] = input.value;
    else delete state.textFields[key];
    scheduleSave();
  });
  wrap.appendChild(input);
}

function overlayWidgets(wrap, pageData) {
  const pageW = state.data.page_size[0];
  const pageH = state.data.page_size[1];
  for (const w of pageData.widgets || []) {
    if (pageData.vendor === "Fromm" && w.kind !== "qty") {
      addFrommControl(wrap, pageData, w, pageW, pageH);
      continue;
    }
    if (w.kind === "store_name") {
      const input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.className = "buyer-overlay";
      input.value = buyerLine();
      input.placeholder = "Store name — City / State";
      input.setAttribute("aria-label", "Store name and city or state");
      positionOverlay(input, w.rect, pageW, pageH);
      wrap.appendChild(input);
      continue;
    }
    if (w.kind !== "qty") continue;

    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.className = "qty-overlay";
    input.min = "0";
    input.step = "1";
    positionOverlay(input, w.rect, pageW, pageH);
    input.dataset.page = pageData.index;
    input.dataset.widget = w.name;
    const key = pageData.index + "|" + w.name;
    const existing = state.order[key];
    if (existing !== undefined && existing !== "" && existing !== null) {
      input.value = existing;
      input.classList.add("has-value");
    }
    input.addEventListener("input", () => {
      const v = input.value;
      if (v === "" || v === "0") {
        delete state.order[key];
        input.classList.remove("has-value");
      } else {
        state.order[key] = v;
        input.classList.add("has-value");
      }
      scheduleSave();
      recomputeTotals();
      updateVendorNavIndicators();
    });
    wrap.appendChild(input);
  }
  addVendorNoteOverlays(wrap, pageData, pageW, pageH);
}

// === Totals ===
function computeSubtotal() {
  let total = 0;
  for (const [key, qtyStr] of Object.entries(state.order)) {
    if (!qtyStr) continue;
    const qty = parseInt(qtyStr, 10);
    if (!qty || qty <= 0) continue;
    const parts = key.split("|");
    const pageIdx = parseInt(parts[0], 10);
    const widgetName = parts[1];
    const page = state.data.pages.find((p) => p.index === pageIdx);
    if (!page) continue;
    const w = page.widgets.find((ww) => ww.name === widgetName);
    if (!w || !w.row || w.row.net_price == null) continue;
    total += qty * w.row.net_price;
  }
  return total;
}

function computeVendorSubtotals() {
  // Returns { vendorName: subtotal } for each vendor that has any qty inputs.
  const result = {};
  for (const [key, qtyStr] of Object.entries(state.order)) {
    if (!qtyStr) continue;
    const qty = parseInt(qtyStr, 10);
    if (!qty || qty <= 0) continue;
    const parts = key.split("|");
    const pageIdx = parseInt(parts[0], 10);
    const widgetName = parts[1];
    const page = state.data.pages.find((p) => p.index === pageIdx);
    if (!page) continue;
    const w = page.widgets.find((ww) => ww.name === widgetName);
    if (!w || !w.row || w.row.net_price == null) continue;
    const vendor = page.vendor || "Other";
    result[vendor] = (result[vendor] || 0) + qty * w.row.net_price;
  }
  return result;
}

function recomputeTotals() {

  const subtotal = computeSubtotal();
  const amt = $("#subtotalAmt");
  const warn = $("#minWarn");
  const hdr = $("#headerTotal");
  if (hdr) hdr.textContent = "TOTAL ORDER: $" + subtotal.toFixed(2);
  if (amt) amt.textContent = "$" + subtotal.toFixed(2);
  const belowMin = subtotal > 0 && subtotal < ORDER_MIN;
  if (amt) amt.classList.toggle("below-min", belowMin);
  if (warn) warn.style.display = belowMin ? "" : "none";
  renderMasterTable();
  renderItemsTable();
}
function renderMasterTable() {
  const tbody = $("#m-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  const map = vendorPages();
  const vendors = Object.keys(map).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const subtotals = computeVendorSubtotals();
  let total = 0;
  let visibleCount = 0;
  for (const v of vendors) {
    const subtotal = subtotals[v] || 0;
    total += subtotal;
    const isHidden = !!state.master.hiddenVendors[v];
    if (!isHidden) visibleCount++;
    const tr = document.createElement("tr");
    if (isHidden) tr.style.opacity = "0.45";
    tr.innerHTML =
      '<td>' + escapeHtml(v) + '</td>' +
      '<td class="mp-num">$' + subtotal.toFixed(2) + '</td>' +
      '<td style="text-align:center"><input type="checkbox" data-vendor="' + v.replace(/'/g, '&apos;') + '"' + (isHidden ? ' checked' : '') + '></td>';
    tbody.appendChild(tr);
  }
  // Footer row with grand total
  const footer = document.createElement("tr");
  footer.innerHTML = '<td><strong>TOTAL</strong></td><td class="mp-num"><strong>$' + total.toFixed(2) + '</strong></td><td></td>';
  tbody.appendChild(footer);
  // Event delegation for hide checkboxes (avoid stacking listeners on re-render)
  if (!tbody.dataset.boundHide) {
    tbody.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.type === "checkbox" && t.dataset.vendor) {
        const vendor = t.dataset.vendor;
        if (t.checked) state.master.hiddenVendors[vendor] = true;
        else delete state.master.hiddenVendors[vendor];
        scheduleSave();
        renderMasterTable();
        buildVendorList();
      }
    });
    tbody.dataset.boundHide = "1";
  }
  if (visibleCount === 0) {
    const tr = document.createElement("tr");
    tr.className = "mp-empty";
    tr.innerHTML = '<td colspan="3">All vendors hidden</td>';
    tbody.appendChild(tr);
  }
}

function renderItemsTable() {
  const tbody = $("#m-items-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  const items = [];
  for (const [key, qtyStr] of Object.entries(state.order)) {
    const qty = parseInt(qtyStr, 10);
    if (!qty || qty <= 0) continue;
    const parts = key.split("|");
    const pageIdx = parseInt(parts[0], 10);
    const widgetName = parts[1];
    const page = state.data.pages.find((p) => p.index === pageIdx);
    if (!page) continue;
    const w = page.widgets.find((ww) => ww.name === widgetName);
    if (!w) continue;
    items.push({ key, qty, page, widget: w });
  }
  items.sort((a, b) => (a.page.vendor || "").localeCompare(b.page.vendor || "") || a.page.index - b.page.index);
  for (const it of items) {
    const tr = document.createElement("tr");
    const upc = (it.widget.row && it.widget.row.upc) || "";
    const desc = (it.widget.row && it.widget.row.description) || "";
    tr.innerHTML =
      '<td style="font-family:monospace;font-size:11px">' + escapeHtml(upc) + '</td>' +
      '<td>' + escapeHtml(desc) + '</td>' +
      '<td class="mp-num"><input type="number" min="0" value="' + it.qty + '" data-key="' + it.key.replace(/'/g, '&apos;') + '"></td>' +
      '<td><button class="mp-del" data-key="' + it.key.replace(/'/g, '&apos;') + '" title="Remove">×</button></td>';
    tbody.appendChild(tr);
  }
  // Use event delegation to avoid stacking listeners on re-render.
  // Listen once on the table body — check inputs/buttons at event time.
  if (!tbody.dataset.bound) {
    tbody.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.type === "number" && t.dataset.key) {
        const key = t.dataset.key;
        const v = t.value;
        if (v === "" || v === "0" || parseInt(v, 10) <= 0) {
          delete state.order[key];
        } else {
          state.order[key] = String(parseInt(v, 10));
        }
        scheduleSave();
        recomputeTotals();
      }
    });
    tbody.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("mp-del") && t.dataset.key) {
        const key = t.dataset.key;
        delete state.order[key];
        scheduleSave();
        recomputeTotals();
      }
    });

    tbody.dataset.bound = "1";
  }
  if (items.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" style="color:var(--muted);font-style:italic;padding:12px 4px;text-align:center">No items yet — type quantities in a vendor page</td>';
    tbody.appendChild(tr);
  }
}

function updateVendorNavIndicators() {
  const map = vendorPages();
  const vendors = Object.keys(map).filter((v) => !state.master.hiddenVendors[v]);
   for (const v of vendors) {
    const pages = map[v];
    const any = pages.some((p) => Object.keys(state.order).some((k) => k.startsWith(p.index + "|") && state.order[k]));
    const btn = $("#vendorList button[data-vendor='" + v.replace(/'/g, "&apos;") + "']");
    if (btn) btn.classList.toggle("has-input", any);
  }
}

// === Toolbar actions ===
function backupJson() {
  const payload = JSON.stringify({
    version: SCHEMA_VERSION,
    order: state.order,
    vendorMeta: state.vendorMeta,
    textFields: state.textFields,
    checkboxFields: state.checkboxFields,
    buyer: state.buyer,
    savedAt: new Date().toISOString(),
  }, null, 2);
  downloadBlob(payload, "sepet2026-order-" + Date.now() + ".json", "application/json");
  toast("Backup downloaded");
}

function restoreJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      if (parsed.version !== SCHEMA_VERSION) {
        toast("Backup version mismatch", 2500);
        return;
      }
      state.order = parsed.order || {};
      state.vendorMeta = parsed.vendorMeta || {};
      state.textFields = parsed.textFields || {};
      state.checkboxFields = parsed.checkboxFields || {};
      state.buyer.storeName = parsed.buyer?.storeName || "";
      state.buyer.city = parsed.buyer?.city || "";
      persist();
      // re-render
      $("#main").innerHTML = "";
      renderToolbarIntoMain();

      renderVendorView(state.currentVendor);
      updateVendorNavIndicators();
      toast("Restored ✓");
    } catch (e) {
      toast("Bad backup file", 2500);
    }
  };
  input.click();
}

function clearCurrentVendor() {
  if (!state.currentVendor) return;
  showModal(
    "<h3>Clear all entries for " + escapeHtml(state.currentVendor) + "?</h3>" +
    "<p>This removes qty and text inputs on this vendor's pages. Your notes, buyer info, and other vendors are kept.</p>" +
    '<div class="modal-actions">' +
      '<button class="secondary" id="cm-cancel">Cancel</button>' +
      '<button class="danger" id="cm-ok">Clear</button>' +
    '</div>'
  );
  document.getElementById("cm-cancel").onclick = hideModal;
  document.getElementById("cm-ok").onclick = () => {
    const map = vendorPages();
    for (const p of (map[state.currentVendor] || [])) {
      for (const key of Object.keys(state.order)) {
        if (key.startsWith(p.index + "|")) delete state.order[key];
      }
      for (const key of Object.keys(state.textFields)) {
        if (key.startsWith(p.index + "|")) delete state.textFields[key];
      }
      for (const key of Object.keys(state.checkboxFields)) {
        if (key.startsWith(p.index + "|")) delete state.checkboxFields[key];
      }
    }
    hideModal();
    persist();
    renderVendorView(state.currentVendor);
    toast("Cleared");
  };
}

// === Submit & Export ===
async function submitOrder() {
  if (!state.buyer.storeName) {
    showModal(
      "<h3>Buyer info missing</h3>" +
      "<p>Please enter the store name at the top before submitting.</p>" +
      '<div class="modal-actions"><button id="cm-ok">OK</button></div>'
    );
    document.getElementById("cm-ok").onclick = hideModal;
    return;
  }
  const subtotal = computeSubtotal();
  if (subtotal < ORDER_MIN) {
    showModal(
      "<h3>Below $" + ORDER_MIN + " minimum</h3>" +
      "<p>Current subtotal: $" + subtotal.toFixed(2) + "</p>" +
      "<p>You can still export for your records, but Southeast Pet requires a $" + ORDER_MIN + " minimum to submit.</p>" +
      '<div class="modal-actions">' +
        '<button class="secondary" id="cm-cancel">Keep editing</button>' +
        '<button class="danger" id="cm-ok">Export anyway</button>' +
      '</div>'
    );
    document.getElementById("cm-cancel").onclick = hideModal;
    document.getElementById("cm-ok").onclick = () => { hideModal(); doExport(); };
    return;
  }
  showModal(
    "<h3>Export filled order?</h3>" +
    "<p>Subtotal: <strong>$" + subtotal.toFixed(2) + "</strong></p>" +
    "<p>This will download the filled PDF (for submission) and a CSV (for your records).</p>" +
    '<div class="modal-actions">' +
      '<button class="secondary" id="cm-cancel">Cancel</button>' +
      '<button id="cm-ok">Export</button>' +
    '</div>'
  );
  document.getElementById("cm-cancel").onclick = hideModal;
  document.getElementById("cm-ok").onclick = () => { hideModal(); doExport(); };
}

async function doExport() {
  toast("Building filled PDF…", 4000);
  try {
    const pdfDoc = await PDFDocument.load(state.pdfBytesForLib);
    const form = pdfDoc.getForm();

    // Store name + city on every STORE NAME / CITYSTATE field
    const buyerLine = [state.buyer.storeName, state.buyer.city].filter(Boolean).join(" — ");
    if (buyerLine) {
      const storeFields = form.getFields().filter((f) => /STORE NAME|CITYSTATE|STORENAME/i.test(f.getName()));
      for (const f of storeFields) {
        try {
          if (typeof f.setText === "function") f.setText(buyerLine);
        } catch (e) { /* ignore non-text */ }
      }
    }

    // Fill quantities and Fromm controls using their original PDF field names.
    const allFields = form.getFields();
    const fieldsByName = new Map(allFields.map((field) => [field.getName(), field]));
    for (const [key, value] of Object.entries(state.textFields)) {
      if (!value) continue;
      const widgetName = key.slice(key.indexOf("|") + 1);
      const field = fieldsByName.get(widgetName);
      if (field && typeof field.setText === "function") {
        try {
          field.setText(value);
        } catch (e) {
          console.warn("set text failed", widgetName, e);
        }
      }
    }
    for (const key of Object.keys(state.checkboxFields)) {
      const widgetName = key.slice(key.indexOf("|") + 1);
      const field = fieldsByName.get(widgetName);
      if (field && typeof field.check === "function") {
        try {
          field.check();
        } catch (e) {
          console.warn("check field failed", widgetName, e);
        }
      }
    }
    let filled = 0;
    for (const [key, qtyStr] of Object.entries(state.order)) {
      const qty = parseInt(qtyStr, 10);
      if (!qty || qty <= 0) continue;
      const parts = key.split("|");
      const widgetName = parts[1];
      const field = fieldsByName.get(widgetName);
      if (field && typeof field.setText === "function") {
        try {
          field.setText(String(qty));
          filled++;
        } catch (e) {
          console.warn("set text failed", widgetName, e);
        }
      }
    }

    try { form.flatten(); } catch (e) { /* ignore */ }

    const bytes = await pdfDoc.save();
    window._lastPdfBytesLen = bytes.byteLength;
    window._lastPdfB64 = bytesToBase64(bytes);
    downloadBlob(bytes, "sepet2026-filled-" + Date.now() + ".pdf", "application/pdf");
    toast("Filled PDF downloaded ✓");

    const csv = generateCsv();
    window._lastCsv = csv;
    downloadBlob(csv, "sepet2026-order-" + Date.now() + ".csv", "text/csv");
  } catch (e) {
    console.error(e);
    showModal(
      "<h3>Export failed</h3>" +
      "<p>" + escapeHtml(e.message) + "</p>" +
      "<p>The PDF data may be corrupt. Try a fresh reload. Your order state in localStorage is still safe.</p>" +
      '<div class="modal-actions"><button id="cm-ok">OK</button></div>'
    );
    document.getElementById("cm-ok").onclick = hideModal;
  }
}

function generateCsv() {
  const lines = ["vendor,page,upc,description,um,net_price,qty,line_total"];
  for (const [key, qtyStr] of Object.entries(state.order)) {
    const qty = parseInt(qtyStr, 10);
    if (!qty || qty <= 0) continue;
    const parts = key.split("|");
    const pageIdx = parseInt(parts[0], 10);
    const widgetName = parts[1];
    const page = state.data.pages.find((p) => p.index === pageIdx);
    if (!page) continue;
    const w = page.widgets.find((ww) => ww.name === widgetName);
    if (!w) continue;
    const upc = w.upc || (w.row && w.row.upc) || "";
    const desc = (w.row && w.row.description) || "";
    const um = (w.row && w.row.um) || "";
    const net = (w.row && w.row.net_price != null) ? w.row.net_price : "";
    const lineTotal = (net ? (qty * net) : 0).toFixed(2);
    lines.push([
      csvEscape(page.vendor || ""),
      page.index,
      csvEscape(upc),
      csvEscape(desc),
      csvEscape(um),
      net,
      qty,
      lineTotal,
    ].join(","));
  }
  return lines.join("\n");
}

function bytesToBase64(uint8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// === Utils ===
function downloadBlob(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscapeAttr(s) {
  // Encode for CSS attribute selectors; escapes anything that isn't
  // alphanumeric, dash, or underscore. We avoid escaping pipes since
  // dataset.key reads back the literal string (no CSS selector escape).
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function csvEscape(s) {
  s = String(s == null ? "" : s);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// === Go ===
boot();
// Sat 29 Aug 2026 02:24:06 PM EDT
// trace 
