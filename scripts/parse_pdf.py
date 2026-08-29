#!/usr/bin/env python3
"""
Parse the 2026-Trade-Show-Book.pdf into a structured JSON catalog.

Output schema (v4):

{
  "version": 4,
  "source_pdf": "...",
  "page_size": [w, h],
  "pages": [
    {
      "index": 1,
      "vendor": "Acana" | null,
      "has_text": true,
      "widgets": [
        {
          "name": "8569",
          "kind": "qty" | "store_name" | "total" | "unknown",
          "rect": [x0, y0, x1, y1],
          "upc": "860000813723" | null,
          "net_price": 85.69 | null,
          "row": {...matched row data...} | null
        }
      ]
    }
  ]
}

Classification rules:
  - STORE NAME field: name contains STORE NAME / CITYSTATE / STORENAME,
    OR rect is a wide field in the bottom band of the page (y0 >= 700).
  - TOTAL field: name starts with TOTAL.
  - QTY field: name is numeric (NET price in cents, with optional _N
    disambiguator) OR rect sits in the right column (x0 >= 565) and is
    not in the bottom band.
  - Anything else: unknown.
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

PDF_PATH = Path(__file__).resolve().parents[1] / "app" / "assets" / "2026-Trade-Show-Book.pdf"
OUT_PATH = Path(__file__).resolve().parents[1] / "app" / "data" / "data.json"

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
COL_DESC = (60, 430)
COL_UM = (430, 460)
COL_LIST = (460, 500)
COL_PCT = (500, 535)
COL_NET = (535, 570)


def detect_vendor(page_text: str) -> str | None:
    lines = [ln.strip() for ln in page_text.splitlines() if ln.strip()]
    idx = 0
    for ln in lines:
        if ln.lower() in HEADER_BOILERPLATE_LINES:
            idx += 1
        else:
            break
    if idx >= len(lines):
        return None
    # Skip pure-digit lines (page numbers printed on the page)
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

def classify_widget(raw_name: str, rect) -> dict:
    name = (raw_name or "").strip()
    upper = name.upper().replace(" ", "")
    x0, y0, x1, y1 = rect

    # Store name: name says so, OR rect is wide + in bottom band
    if "STORENAME" in upper or "CITYSTATE" in upper:
        return {"kind": "store_name", "net_price": None, "occurrence": 0}
    if y0 >= 700 and (x1 - x0) > 200:
        return {"kind": "store_name", "net_price": None, "occurrence": 0}

    if upper.startswith("TOTAL"):
        return {"kind": "total", "net_price": None, "occurrence": 0}

    # Numeric name (NET price in cents, optional _N disambiguator)
    m = re.match(r"^(\d+)(?:[ _](\d+))?$", name)
    if m:
        cents = int(m.group(1))
        occ = int(m.group(2)) if m.group(2) else 0
        return {"kind": "qty", "net_price": cents / 100.0, "occurrence": occ}

    # Right column text widget (excluding footer) is a qty cell
    if x0 >= 565 and y1 < 750:
        return {"kind": "qty", "net_price": None, "occurrence": 0}

    return {"kind": "unknown", "net_price": None, "occurrence": 0}


def group_text_into_rows(page, y_tol: float = 1.5):
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


def parse_row(row_spans):
    upc = None
    for x, t in row_spans:
        if COL_UPC[0] <= x < COL_UPC[1] and re.fullmatch(r"\d{12}", t):
            upc = t
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


def main() -> int:
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

        vendor = detect_vendor(page_text) if has_text else prev_vendor
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

        widgets_sorted = sorted(
            list(page.widgets() or []),
            key=lambda w: (round(w.rect[1], 1), round(w.rect[0], 1)),
        )

        widget_records = []
        for w in widgets_sorted:
            meta = classify_widget(w.field_name, w.rect)
            field_type_counts[meta["kind"]] += 1
            widget_y = round(w.rect[1], 1)

            row_match = None
            if meta["kind"] == "qty":
                best = None
                for ry, rd in data_rows:
                    if abs(ry - widget_y) <= 6.0:
                        if best is None or abs(ry - widget_y) < abs(best[0] - widget_y):
                            best = (ry, rd)
                if best is not None and best[1]["net_price"] is not None:
                    if meta["net_price"] is None or abs(best[1]["net_price"] - meta["net_price"]) < 0.01:
                        row_match = best[1]
                        matched_qty += 1
                    else:
                        unmatched_qty += 1
                else:
                    unmatched_qty += 1

            widget_records.append({
                "name": w.field_name,
                "kind": meta["kind"],
                "upc": row_match["upc"] if row_match else None,
                "net_price": meta["net_price"],
                "occurrence": meta["occurrence"],
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
        "version": 4,
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
    print("top vendors:")
    for v, n in vendor_counts.most_common(15):
        print(f"  {n:4d}  {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
