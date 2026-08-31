#!/usr/bin/env python3
"""
Parse the 2026-Trade-Show-Book.pdf into a structured JSON catalog.

Output schema (v9):

{
  "version": 9,
  "source_pdf": "...",
  "page_size": [w, h],
  "pages": [
    {
      "index": 1,
      "vendor": "Acana" | null,
      "has_text": true,
      "widgets": [
        { "name": "...", "kind": "qty|store_name|total|unknown",
          "rect": [x0, y0, x1, y1], "upc": "...", "net_price": 85.69, "row": {...} }
      ]
    }
  ]
}

Vendor detection:
  1. Scan page text for known strong brands (Fromm, etc.)
  2. Fall back to header heuristic (4th line after boilerplate)
  3. Carry forward previous vendor for pages with no detectable vendor

Widget classification uses page-level layout detection:
  1. Identify column header rows (QTY, PURCHASE, $, NET, #, etc.)
  2. Map those to x-ranges
  3. Classify each widget by which x-range its center falls into
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

PDF_PATH = Path(__file__).resolve().parents[1] / "assets" / "2026-Trade-Show-Book.pdf"
OUT_PATH = Path(__file__).resolve().parents[1] / "data" / "data.json"

HEADER_BOILERPLATE_LINES = {
    "email: flyer@southeastpet.com   |   phone: 770.948.7600   |    www.southeastpet.com",
    "email: orders@southeastpet.com   |   phone: 770.948.7600   |    www.southeastpet.com",
    "store name & city/state:",
    "southeast pet is not responsible for typographical errors or changes in price & availability. must ship within 30 days. may not be combined with other offers.",
}
NON_VENDOR_HEADINGS = {
    "show", "iso", "retailer", "baydog", "new line", "new", "iso bundle",
    "show bundle", "best sellers", "new items", "limited", "save", "total",
    "upc", "description", "um", "list", "%off", "net", "qty", "min",
    "dog", "cat",
}

# Column x-ranges (PDF letter, 612pt wide):
COL_UPC = (0, 60)
COL_DESC = (60, 400)
COL_UM = (400, 500)
COL_LIST = (430, 525)
COL_PCT = (460, 540)
COL_NET = (490, 600)

# Tokens that mark a user-input qty column (header text on the page)
QTY_HEADER_TOKENS = {
    "qty", "purchase", "qty.", "qty:",
    "free", "min", "purchase free", "purchase qty", "qty/purchase",
    "#",  # Fromm pages use "#" header for qty column
}
# Tokens that mark an EXCLUDED column (computed totals, prices — never user-edited)
EXCLUDED_HEADER_TOKENS = {
    "$", "net", "list", "%off", "discount", "save", "total", "tot",
}

# Pages whose title art omits a machine-readable vendor name. These assignments
# were audited against the adjacent page sequence and the products on the page.
PAGE_VENDOR_OVERRIDES = {
    1: "Catalog Cover",
    9: "Acana",
    13: "Alcott",
    23: "Austin & Kat",
    24: "Barkworthies",
    27: "Barkworthies",
    **dict.fromkeys(range(28, 33), "Baydog"),
    34: "Benebone",
    36: "Benebone",
    **dict.fromkeys(range(39, 43), "Big Country Raw"),
    43: "Big Country Raw",
    **dict.fromkeys(range(44, 47), "Bocce’s Bakery"),
    47: "Bones & Co",
    53: "Brightkins",
    **dict.fromkeys((59, 60), "Carna4"),
    49: "BoxieCat",
    70: "Dave’s",
    83: "Earth Animal",
    85: "Earthbath",
    **dict.fromkeys((94, 104), "Farmina"),
    119: "Fromm",
    135: "Furever Fierce",
    137: "Fussie Cat",
    **dict.fromkeys((145, 146, 147), "GivePet"),
    152: "Green Coast Pet",
    161: "Growl",
    178: "Honest To Goodness",
    179: "Hugglehounds",
    189: "Huxley & Kent",
    190: "Icelandic+",
    194: "Inaba",
    195: "Inaba",
    198: "IndiPets",
    200: "IndiPets",
    202: "Intersand",
    205: "K9 Granola",
    **dict.fromkeys((218, 219), "Lotus"),
    222: "Messy Mutts",
    236: "Wholesomes",
    263: "Nootie",
    282: "Open Farm",
    285: "Palz&Co",
    318: "Pure Vita",
    **dict.fromkeys((326, 328), "Raised Right"),
    **dict.fromkeys((349, 350), "Smallbatch"),
    357: "SquarePet",
    360: "Stella & Chewy’s",
    **dict.fromkeys((379, 380, 382), "Treat Planet"),
    **dict.fromkeys((384, 386), "TropiClean"),
    427: "Wondercide",
    **dict.fromkeys((447, 450), "ZIWI"),
    451: "Zymox",
}


def detect_vendor_from_content(page_text: str) -> str | None:
    """Detect vendor from page-wide content clues (branding, footers).

    Some vendor pages use generic form codes (e.g. F3856SP) as titles but
    are actually Fromm forms. We detect those via content text.

    For pages where the header heuristic returns None (because the title
    is "SHOW" + a section name), we also check the footer for the
    Southeast Pet 2026 Trade Show line that contains the vendor name.
    """
    if not page_text:
        return None
    tl = page_text.lower()
    if "fromm family foods" in tl or "fromm.com" in tl or "pick six" in tl:
        return "Fromm"
    # Many pages end with a footer like "VendorName\nSoutheast Pet 2026 Trade Show".
    # When the header is generic ("SHOW" / "UPC" / a section title), fall back
    # to the footer vendor line.
    footer_re = re.compile(r"^([A-Za-z0-9][A-Za-z0-9 &+'’\.\-]{1,40})\s*\n\s*Southeast Pet 2026 Trade Show\s*$", re.MULTILINE)
    for line in page_text.splitlines():
        line = line.strip()
        if not line or "southeast pet 2026 trade show" in line.lower():
            continue
        if line.lower() in {"southeast pet 2026 trade show"}:
            continue
    # Look at the last few non-empty lines: the vendor name is typically
    # one line above the Trade Show footer.
    lines = [l.strip() for l in page_text.splitlines() if l.strip()]
    for i in range(len(lines) - 1, -1, -1):
        if "southeast pet 2026 trade show" in lines[i].lower():
            if i > 0 and lines[i - 1] and lines[i - 1].lower() not in {"show", "u", "u pc", "upc", "u p c", "show:", "description", "um", "list", "%off", "net", "qty", "buy", "get", "blank"}:
                candidate = lines[i - 1].rstrip(":")
                if 2 <= len(candidate) <= 40 and 1 <= len(candidate.split()) <= 5:
                    if candidate.lower() in NON_VENDOR_HEADINGS:
                        return None
                    return candidate
            break
    return None


def detect_vendor(page_text):
    """Detect vendor name from the heading line below the email boilerplate.

    Returns the vendor name, or None if the page header doesn't look like a
    vendor name (e.g. it's "RETAILER", "SHOW", or a page number).
    """
    lines = [ln.strip() for ln in page_text.splitlines() if ln.strip()]
    idx = 0
    for ln in lines:
        if ln.lower() in HEADER_BOILERPLATE_LINES:
            idx += 1
        else:
            break
    if idx >= len(lines):
        return None
    while idx < len(lines) and re.fullmatch(r"\d+", lines[idx]):
        idx += 1
    if idx >= len(lines):
        return None
    candidate = lines[idx].rstrip(":")
    if candidate.lower() in NON_VENDOR_HEADINGS:
        return None
    if 2 <= len(candidate) <= 40 and 1 <= len(candidate.split()) <= 5:
        return candidate
    return None


def group_text_into_rows(page, y_tol=1.5):
    d = page.get_text("dict")
    rows = defaultdict(list)
    for blk in d.get("blocks", []):
        for line in blk.get("lines", []):
            for span in line.get("spans", []):
                x, y = span["bbox"][0], span["bbox"][1]
                rows[round(y, 1)].append((round(x, 1), span["text"].strip()))
    sorted_ys = sorted(rows.keys())
    out = []
    current_y = None
    current = defaultdict(list)
    for y in sorted_ys:
        if current_y is None or abs(y - current_y) <= y_tol:
            current_y = current_y if current_y is not None else y
            for x, t in rows[y]:
                current[x].append(t)
        else:
            merged = []
            for x in sorted(current.keys()):
                txt = " ".join(current[x]).strip()
                if txt:
                    merged.append((x, txt))
            if merged:
                out.append((current_y, merged))
            current_y = y
            current = defaultdict(list)
            for x, t in rows[y]:
                current[x].append(t)
    if current:
        merged = []
        for x in sorted(current.keys()):
            txt = " ".join(current[x]).strip()
            if txt:
                merged.append((x, txt))
        if merged:
            out.append((current_y, merged))
    return out


def detect_column_regions(rows):
    """Scan header rows for column tokens. Returns (qty_cols, excluded_cols)
    where each is a list of (x_min, x_max) bands.

    Widgets are typically 15-20pt to the LEFT of their column header text
    (the header label sits to the right of the input box).
    """
    qty_cols = []
    excluded_cols = []
    for y, spans in rows[:80]:
        for x, t in spans:
            tl = t.lower().strip().rstrip(".:").replace("  ", " ")
            if tl in QTY_HEADER_TOKENS:
                if tl == "#":
                    qty_cols.append((x - 30, x + 10))
                else:
                    qty_cols.append((x - 40, x + 30))
            elif tl in EXCLUDED_HEADER_TOKENS:
                excluded_cols.append((x - 10, x + 50))

    def merge(bands):
        if not bands:
            return []
        bands = sorted(bands, key=lambda b: b[0])
        merged = [list(bands[0])]
        for b in bands[1:]:
            if b[0] <= merged[-1][1] + 5:
                merged[-1][1] = max(merged[-1][1], b[1])
            else:
                merged.append(list(b))
        return merged
    return merge(qty_cols), merge(excluded_cols)


def classify_widget(raw_name, rect, page_columns):
    name = (raw_name or "").strip()
    upper = name.upper().replace(" ", "")
    x0, y0, x1, y1 = rect
    qty_cols, excluded_cols = page_columns
    cx = (x0 + x1) / 2

    if "STORENAME" in upper or "CITYSTATE" in upper:
        return "store_name"
    if y0 >= 700 and (x1 - x0) > 200:
        return "store_name"

    if upper.startswith("TOTAL"):
        return "total"

    m = re.match(r"^(\d+)(?:[ _](\d+))?$", name)
    if m:
        cents = int(m.group(1))
        occ = int(m.group(2)) if m.group(2) else 0
        return ("qty", cents / 100.0, occ)

    if x0 >= 565 and y1 < 750:
        return ("qty", None, 0)

    for (xmin, xmax) in excluded_cols:
        if xmin <= cx <= xmax:
            return "unknown"
    for (xmin, xmax) in qty_cols:
        if xmin <= cx <= xmax:
            return ("qty", None, 0)

    return "unknown"


def parse_row(row_spans):
    upc = None
    upc_re = re.compile(r"^(\d{12,14})")
    for x, t in row_spans:
        if COL_UPC[0] <= x < COL_UPC[1]:
            m = upc_re.match(t)
            if m:
                upc = m.group(1)
                break
    descs = []
    for x, t in row_spans:
        if COL_DESC[0] <= x < COL_DESC[1] and not re.fullmatch(r"[\d.]+", t) and t not in {"_____"}:
            descs.append(t)
    description = " ".join(descs).strip() if descs else None
    um = None
    for x, t in row_spans:
        if COL_UM[0] <= x < COL_UM[1] and re.fullmatch(r"(EA|CS|CASE|EA\.|PR|PL|BAG|BX|PK|TR)", t, re.IGNORECASE):
            um = t.upper()
            break
    list_price = None
    for x, t in row_spans:
        if COL_LIST[0] <= x < COL_LIST[1] and re.fullmatch(r"\d+\.\d{2}", t):
            list_price = float(t)
            break
    pct_off = None
    for x, t in row_spans:
        if COL_PCT[0] <= x < COL_PCT[1] and re.fullmatch(r"\d{1,3}%$", t):
            pct_off = int(t.rstrip("%"))
            break
    net_price = None
    for x, t in row_spans:
        if COL_NET[0] <= x < COL_NET[1] and re.fullmatch(r"\d+\.\d{2}", t):
            net_price = float(t)
            break
    if not upc:
        return None
    return {
        "upc": upc,
        "description": description,
        "um": um,
        "list_price": list_price,
        "discount_pct": pct_off,
        "net_price": net_price,
    }


def main():
    doc = pymupdf.open(PDF_PATH)
    pages_out = []
    field_type_counts = Counter()
    vendor_counts = Counter()
    matched_qty = 0
    unmatched_qty = 0
    prev_vendor = None

    for pno in range(len(doc)):
        page = doc[pno]
        page_text = page.get_text("text").strip()
        has_text = bool(page_text)
        content_vendor = detect_vendor_from_content(page_text) if has_text else None
        header_vendor = detect_vendor(page_text) if has_text else None
        vendor_override = PAGE_VENDOR_OVERRIDES.get(pno + 1)
        if vendor_override:
            vendor = vendor_override
        elif content_vendor:
            vendor = content_vendor
        elif header_vendor:
            vendor = header_vendor
        elif prev_vendor and prev_vendor.startswith("Fromm") and not has_text:
            vendor = prev_vendor
        else:
            vendor = None
        if vendor:
            vendor_counts[vendor] += 1
        prev_vendor = vendor if vendor else prev_vendor
        rows = group_text_into_rows(page) if has_text else []
        data_rows = []
        for y, spans in rows:
            parsed = parse_row(spans)
            if parsed:
                data_rows.append((y, parsed))
        data_rows.sort(key=lambda r: r[0])

        page_columns = detect_column_regions(rows) if has_text else ([], [])

        widgets_sorted = sorted(
            list(page.widgets() or []),
            key=lambda w: (round(w.rect[1], 1), round(w.rect[0], 1)),
        )

        widget_records = []
        for w in widgets_sorted:
            classification = classify_widget(w.field_name, w.rect, page_columns)
            if isinstance(classification, tuple):
                kind, net_price, occ = classification
            else:
                kind, net_price, occ = classification, None, 0
            field_type_counts[kind] += 1

            row_match = None
            if kind == "qty":
                widget_y = round(w.rect[1], 1)
                best = None
                for ry, rd in data_rows:
                    if abs(ry - widget_y) <= 6.0:
                        if best is None or abs(ry - widget_y) < abs(best[0] - widget_y):
                            best = (ry, rd)
                if best is not None and best[1]["net_price"] is not None:
                    # Trust the row's net_price if the widget's own price
                    # is missing or appears to be a legacy cents-coded value (< 1.0).
                    if net_price is None or net_price < 1.0 or abs(best[1]["net_price"] - net_price) < 0.01:
                        row_match = best[1]
                        matched_qty += 1
                    else:
                        unmatched_qty += 1
                else:
                    unmatched_qty += 1

            widget_records.append({
                "name": w.field_name,
                "kind": kind,
                "field_type": w.field_type_string,
                "upc": row_match["upc"] if row_match else None,
                "net_price": net_price,
                "occurrence": occ,
                "rect": [round(x, 2) for x in w.rect],
                "row": row_match,
            })

        pages_out.append({
            "index": pno + 1,
            "vendor": vendor,
            "has_text": has_text,
            "widget_count": len(widgets_sorted),
            "widgets": widget_records,
        })

    out = {
        "version": 9,
        "source_pdf": PDF_PATH.name,
        "page_size": [round(doc[0].rect.width, 2), round(doc[0].rect.height, 2)],
        "pages": pages_out,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2))

    print(f"wrote {OUT_PATH}")
    print(f"pages: {len(pages_out)}")
    print(f"pages with text: {sum(1 for p in pages_out if p['has_text'])}")
    print(f"widget kinds: {dict(field_type_counts)}")
    print(f"qty widgets matched to UPC rows: {matched_qty}")
    print(f"qty widgets unmatched: {unmatched_qty}")
    print(f"distinct vendors: {len(vendor_counts)}")
    print("Fromm pages:")
    fromm_pages = [p for p in pages_out if p["vendor"] == "Fromm"]
    for p in fromm_pages:
        qty = sum(1 for w in p["widgets"] if w["kind"] == "qty")
        print(f"  page {p['index']}: {p['widget_count']} widgets, {qty} qty")
    print("top vendors:")
    for v, n in vendor_counts.most_common(15):
        print(f"  {n:4d}  {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
