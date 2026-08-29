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
  buyer: { storeName: "", city: "", rep: "", email: "", phone: "" },
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
      Object.assign(state.buyer, parsed.buyer || {});
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
      buyer: state.buyer,
      savedAt: new Date().toISOString(),
    });
    localStorage.setItem(STORE_KEY, payload);
    setSaveState("Saved ✓ " + new Date().toLocaleTimeString(), "ok");
  } catch (e) {
    console.warn("persist failed", e);
    setSaveState("Save failed — backup now!", "warn");
  }
}

// === Boot ===
async function boot() {
  setSaveState("Loading data…");
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
  renderBuyerHeader();
  renderToolbarIntoMain();

  const map = vendorPages();
  const vendors = Object.keys(map).filter((v) => v !== "Other").sort();
  const firstVendor = vendors[0] || Object.keys(map)[0] || null;
  selectVendor(firstVendor);

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
  const map = vendorPages();
  const vendors = Object.keys(map).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  ul.innerHTML = "";
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
    '</div>' +
    '<div>' +
      '<label>Rep name</label>' +
      '<input id="bh-rep" placeholder="Jane Doe" value="' + escapeAttr(state.buyer.rep) + '" />' +
    '</div>' +
    '<div>' +
      '<label>Email / phone (optional)</label>' +
      '<input id="bh-contact" placeholder="jane@store.com" value="' + escapeAttr(state.buyer.email) + '" />' +
    '</div>';
  div.querySelector("#bh-store").addEventListener("input", (e) => { state.buyer.storeName = e.target.value; scheduleSave(); recomputeTotals(); });
  div.querySelector("#bh-city").addEventListener("input", (e) => { state.buyer.city = e.target.value; scheduleSave(); });
  div.querySelector("#bh-rep").addEventListener("input", (e) => { state.buyer.rep = e.target.value; scheduleSave(); });
  div.querySelector("#bh-contact").addEventListener("input", (e) => { state.buyer.email = e.target.value; scheduleSave(); });
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

  // vendor meta header
  const meta = state.vendorMeta[vendor] || { notes: "" };
  const head = document.createElement("div");
  head.className = "vendor-header";
  head.innerHTML =
    "<h2>" + escapeHtml(vendor) + "</h2>" +
    '<div class="pages">' + pages.length + " page" + (pages.length !== 1 ? "s" : "") + "</div>" +
    "<label>Notes for " + escapeHtml(vendor) + "</label>" +
    '<textarea id="vnotes" placeholder="Rep conversations, special instructions…">' + escapeHtml(meta.notes) + "</textarea>";
  head.querySelector("#vnotes").addEventListener("input", (e) => {
    if (!state.vendorMeta[vendor]) state.vendorMeta[vendor] = { notes: "" };
    state.vendorMeta[vendor].notes = e.target.value;
    scheduleSave();
  });
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
    canvas.style.aspectRatio = viewport.width + " / " + viewport.height;
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

function overlayWidgets(wrap, pageData, viewport) {
  if (!pageData.widgets || pageData.widgets.length === 0) return;
  const pageW = state.data.page_size[0];
  const pageH = state.data.page_size[1];
  for (const w of pageData.widgets) {
    if (w.kind !== "qty") continue;
    const [x0, y0, x1, y1] = w.rect;
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.className = "qty-overlay";
    input.min = "0";
    input.step = "1";
    const left = x0 * (viewport.width / pageW);
    const top = viewport.height - y1;
    const wPx = (x1 - x0) * (viewport.width / pageW);
    const hPx = (y1 - y0) * (viewport.height / pageH);
    input.style.left = left + "px";
    input.style.top = top + "px";
    input.style.width = wPx + "px";
    input.style.height = hPx + "px";
    input.style.fontSize = Math.max(11, hPx * 0.55) + "px";
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

function recomputeTotals() {
  const subtotal = computeSubtotal();
  const amt = $("#subtotalAmt");
  const warn = $("#minWarn");
  if (!amt) return;
  amt.textContent = "$" + subtotal.toFixed(2);
  const belowMin = subtotal > 0 && subtotal < ORDER_MIN;
  amt.classList.toggle("below-min", belowMin);
  if (warn) warn.style.display = belowMin ? "" : "none";
}

function updateVendorNavIndicators() {
  const map = vendorPages();
  for (const v of Object.keys(map)) {
    const pages = map[v];
    const any = pages.some((p) => Object.keys(state.order).some((k) => k.startsWith(p.index + "|") && state.order[k]));
    const btn = $("#vendorList button[data-vendor='" + cssEscapeAttr(v) + "']");
    if (btn) btn.classList.toggle("has-input", any);
  }
}

// === Toolbar actions ===
function backupJson() {
  const payload = JSON.stringify({
    version: SCHEMA_VERSION,
    order: state.order,
    vendorMeta: state.vendorMeta,
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
      Object.assign(state.buyer, parsed.buyer || {});
      persist();
      // re-render
      $("#main").innerHTML = "";
      renderBuyerHeader();
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
    "<h3>Clear all quantities for " + escapeHtml(state.currentVendor) + "?</h3>" +
    "<p>This removes only the qty inputs on this vendor's pages. Your notes, buyer info, and other vendors are kept.</p>" +
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

    // Fill qty values
    const allFields = form.getFields();
    let filled = 0;
    for (const [key, qtyStr] of Object.entries(state.order)) {
      const qty = parseInt(qtyStr, 10);
      if (!qty || qty <= 0) continue;
      const parts = key.split("|");
      const widgetName = parts[1];
      const field = allFields.find((f) => f.getName() === widgetName);
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
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}
function csvEscape(s) {
  s = String(s == null ? "" : s);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// === Go ===
boot();
