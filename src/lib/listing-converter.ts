// Converts an eBay listing description (old Voyagers Hook template, or the new one) into the
// new template. Runs in the browser: it relies on DOMParser.
import { EBAY_SPECS_SECTION, EBAY_TEMPLATE } from "@/lib/ebay-template";

export type SpecRow = [string, string];

export interface ParsedListing {
  ok: boolean;
  note: string;
  title: string;
  condition: string;
  free: boolean;
  product: string;
  specs: SpecRow[];
  alreadyNew: boolean;
}

export interface BuildOptions {
  title: string;
  condition: string;
  free: boolean;
  showSpecs: boolean;
  hideRepeats: boolean;
  product: string;
  specs: SpecRow[];
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}|\u{200D}/gu;
const BLANK_PRODUCT =
  "          <p>Product description goes here.</p>\n          <ul>\n            <li>Feature one</li>\n            <li>Feature two</li>\n          </ul>";

const toArr = <T extends Element = Element>(list: NodeListOf<T> | HTMLCollection): T[] =>
  Array.prototype.slice.call(list) as T[];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Clean the product block: drop Squarespace styling, flatten nested lists, and move
// "Label: value" lines out into spec rows.
function tidy(nodes: Node[], loose = false): { html: string; specs: SpecRow[] } {
  const holder = document.createElement("div");
  nodes.forEach((n) => holder.appendChild(n.cloneNode(true)));

  toArr(holder.querySelectorAll("*")).forEach((el) => {
    el.removeAttribute("style");
    el.removeAttribute("class");
    Array.from(el.attributes).forEach((a) => {
      if (a.name.indexOf("data-") === 0) el.removeAttribute(a.name);
    });
  });
  toArr(holder.querySelectorAll("h1,h2,h3,h4")).forEach((h) => {
    if (h.querySelector("p,ul,ol,li,div")) {
      const d = document.createElement("div");
      while (h.firstChild) d.appendChild(h.firstChild);
      h.replaceWith(d);
    }
  });
  toArr(holder.querySelectorAll("ul")).forEach((u) => { if (!u.textContent?.trim()) u.remove(); });

  // Stray policy headings inside the product text, e.g. a "Shipping" line at the end of a list.
  toArr(holder.querySelectorAll("*")).forEach((el) => {
    if (!holder.contains(el)) return;
    const txt = (el.textContent || "").replace(EMOJI, "").trim();
    if (/^(shipping|delivery|postage|returns|contact us)$/i.test(txt)) {
      const li = el.closest("li");
      (li && holder.contains(li) && (li.textContent || "").replace(EMOJI, "").trim() === txt ? li : el).remove();
    }
  });
  toArr(holder.querySelectorAll("gen-text, font, span:not([class])")).forEach((g) => {
    while (g.firstChild) g.parentNode!.insertBefore(g.firstChild, g);
    g.remove();
  });

  const flatten = () => {
    const ownText = (li: Element) => {
      const c = li.cloneNode(true) as Element;
      toArr(c.querySelectorAll("ul,ol")).forEach((x) => x.remove());
      return (c.textContent || "").trim();
    };
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 80) {
      changed = false;
      const lis = toArr(holder.querySelectorAll("li"));
      for (const li of lis) {
        if (!li.querySelector("ul,ol") || ownText(li)) continue;
        let moved: Node[] = [];
        const take = (node: Element) => {
          toArr(node.children).forEach((c) => {
            if (/^(UL|OL)$/.test(c.tagName)) moved = moved.concat(Array.prototype.slice.call(c.childNodes));
            else if (c.tagName === "DIV") take(c);
            else moved.push(c);
          });
        };
        take(li);
        moved.forEach((n) => li.parentNode!.insertBefore(n, li));
        li.remove();
        changed = true;
        break;
      }
    }
  };
  flatten();

  toArr(holder.querySelectorAll("ul > p, ol > p")).forEach((p) => {
    const ul = p.parentNode as Element;
    const after = ul.cloneNode(false) as Element;
    let n = p.nextSibling;
    while (n) { const nx = n.nextSibling; after.appendChild(n); n = nx; }
    ul.parentNode!.insertBefore(p, ul.nextSibling);
    if (after.childNodes.length) p.parentNode!.insertBefore(after, p.nextSibling);
  });
  toArr(holder.querySelectorAll("ul > ul, ol > ol")).forEach((inner) => {
    const outer = inner.parentNode as Element;
    const after = outer.cloneNode(false) as Element;
    let n = inner.nextSibling;
    while (n) { const nx = n.nextSibling; after.appendChild(n); n = nx; }
    outer.parentNode!.insertBefore(inner, outer.nextSibling);
    if (after.childNodes.length) inner.parentNode!.insertBefore(after, inner.nextSibling);
  });
  toArr(holder.querySelectorAll("ul,ol")).forEach((u) => { if (!u.textContent?.trim()) u.remove(); });
  toArr(holder.querySelectorAll("h1,h2,h3,h4")).forEach((h) => { h.textContent = (h.textContent || "").replace(EMOJI, "").trim(); });
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    t.nodeValue = (t.nodeValue || "").replace(EMOJI, "").replace(/^\s+(?=\S)/, (m) => (m.indexOf("\n") > -1 ? m : " "));
  }

  // Spec lines into rows.
  const specs: SpecRow[] = [];
  toArr(holder.querySelectorAll("li")).forEach((li) => {
    if (!holder.contains(li) || li.querySelector("ul,ol")) return;
    const ps = toArr(li.querySelectorAll("p"));
    if (ps.length === 2 && li.children.length === 2) {
      const a = (ps[0].textContent || "").replace(/\s+/g, " ").trim();
      const b = (ps[1].textContent || "").replace(/\s+/g, " ").trim();
      const ma = a.match(/^([^:]{2,32}):\s*(.{1,60})$/);
      if (ma && !/[.!?]$/.test(ma[2])) {
        specs.push([ma[1].trim(), ma[2].trim()]);
        const wb = b.match(/^(\d+\s*(?:years?|months?))\s+warranty$/i);
        if (wb) { specs.push(["Warranty", wb[1]]); li.remove(); } else { li.innerHTML = ""; li.appendChild(ps[1]); }
        return;
      }
      if (a.length <= 32 && b && b.length <= 60 && !/[.!?]$/.test(b)) { specs.push([a.replace(/:$/, ""), b]); li.remove(); return; }
    }
    const txt = (li.textContent || "").replace(/\s+/g, " ").trim();
    const w = txt.match(/^(\d+\s*(?:years?|months?))\s+warranty$/i);
    if (w) { specs.push(["Warranty", w[1]]); li.remove(); return; }
    const m = txt.match(/^([^:]{2,32}):\s*(.{1,60})$/);
    if (m && !/[.!?]$/.test(m[2])) { specs.push([m[1].trim(), m[2].trim()]); li.remove(); }
  });

  let seenKF = false;
  toArr(holder.querySelectorAll("h1,h2,h3,h4,p")).forEach((h) => {
    if (!holder.contains(h)) return;
    if (/^key features:?$/i.test((h.textContent || "").trim())) { if (seenKF) h.remove(); seenKF = true; }
  });
  let tidyEmpty = true;
  while (tidyEmpty) {
    tidyEmpty = false;
    toArr(holder.querySelectorAll("ul,ol,li")).forEach((u) => {
      if (holder.contains(u) && !u.textContent?.trim()) { u.remove(); tidyEmpty = true; }
    });
  }
  toArr(holder.querySelectorAll("li")).forEach((li) => {
    if (!holder.contains(li) || li.querySelector("ul,ol")) return;
    if (/^(size|specifications?|specs|details|dimensions):?$/i.test((li.textContent || "").trim())) li.remove();
  });
  toArr(holder.querySelectorAll("h1,h2,h3,h4,p")).forEach((h) => {
    if (!holder.contains(h)) return;
    if (/^(product )?(specifications?|specs):?$/i.test((h.textContent || "").trim())) {
      const nx = h.nextElementSibling;
      const listFollows = !!nx && /^(UL|OL)$/.test(nx.tagName) && !!nx.textContent?.trim();
      // In a loose (no template) description, keep the heading over any leftover spec bullets.
      if (!listFollows || (specs.length && !loose)) h.remove();
    }
  });
  toArr(holder.querySelectorAll("li")).forEach((li) => { if (holder.contains(li) && !li.textContent?.trim()) li.remove(); });
  flatten();
  toArr(holder.querySelectorAll("div")).forEach((d) => {
    if (holder.contains(d) && !d.attributes.length) {
      while (d.firstChild) d.parentNode!.insertBefore(d.firstChild, d);
      d.remove();
    }
  });
  toArr(holder.querySelectorAll("ul,ol")).forEach((u) => { if (holder.contains(u) && !u.textContent?.trim()) u.remove(); });
  return { html: holder.innerHTML.trim(), specs };
}

export function parseListing(html: string): ParsedListing {
  const fail = (note: string): ParsedListing => ({
    ok: false, note, title: "", condition: "", free: true, product: "", specs: [], alreadyNew: false,
  });
  if (!html || !html.trim()) return fail("This listing has no description.");
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Already on the new template: lift the product block and spec rows straight out.
  const vhp = doc.querySelector(".vh-product");
  if (vhp) {
    const t = doc.querySelector(".vh-title");
    const c = doc.querySelector(".vh-condition strong");
    const tiles = doc.querySelectorAll(".vh-tile-big");
    const specs = toArr(doc.querySelectorAll(".vh-specs tr"))
      .map((tr) => {
        const td = tr.querySelectorAll("td");
        return [td[0]?.textContent?.trim() || "", td[1]?.textContent?.trim() || ""] as SpecRow;
      })
      .filter((r) => r[0]);
    return {
      ok: true,
      alreadyNew: true,
      note: "This listing already uses the new template. Sending it again refreshes it with the latest version.",
      title: t ? (t.textContent || "").replace(/[.\s]+$/, "").trim() : "",
      condition: c ? (c.textContent || "").trim() : "",
      free: tiles[1] ? /free/i.test(tiles[1].textContent || "") : true,
      product: tidy(Array.prototype.slice.call(vhp.childNodes)).html,
      specs,
    };
  }

  const titleEl = doc.querySelector(".product-title");
  const root = doc.querySelector(".content") || doc.body;
  const kids = toArr(root.children);
  const isHead = (e: Element) => /^H[1-4]$/.test(e.tagName);
  let start = kids.findIndex((e) => isHead(e) && !e.classList.contains("product-title") && /about this/i.test(e.textContent || ""));
  if (start < 0 && titleEl) start = kids.indexOf(titleEl);
  const isPolicy = (e: Element) => {
    const txt = (e.textContent || "").replace(EMOJI, "").trim();
    if (isHead(e) && /^(shipping|delivery|postage|returns?|contact us)\b/i.test(txt)) return true;
    if (e.tagName === "P" && /^we ship fast/i.test(txt)) return true;
    if (e.tagName === "A" && e.classList.contains("link-button")) return true;
    return false;
  };
  let end = kids.findIndex((e, i) => i > start && isPolicy(e));
  if (end < 0) end = kids.length;
  if (start < 0) {
    // No Voyagers Hook template at all: use the whole description as the product text.
    let nodes = toArr(doc.body.children);
    const isEmpty = (e: Element) => !(e.textContent || "").trim();
    for (let guard = 0; guard < 10; guard++) {
      while (nodes.length && isEmpty(nodes[0])) nodes = nodes.slice(1); // old banner images and spacer lines
      while (nodes.length && isEmpty(nodes[nodes.length - 1])) nodes = nodes.slice(0, -1);
      if (nodes.length === 1 && nodes[0].tagName === "DIV" && nodes[0].children.length) nodes = toArr(nodes[0].children);
      else break;
    }
    const cut = nodes.findIndex((e) => isPolicy(e));
    if (cut === 0) nodes = [];
    else if (cut > 0) nodes = nodes.slice(0, cut);
    if (!nodes.length || !nodes.some((e) => (e.textContent || "").trim())) {
      return fail("This listing's description is empty, so there's nothing to convert.");
    }
    const lr = tidy(nodes, true);
    return {
      ok: true,
      alreadyNew: false,
      note: "This listing doesn't use either Voyagers Hook template, so the whole description has gone in as the product text. Check it carefully before sending.",
      title: "",
      condition: "",
      free: true,
      product: lr.html,
      specs: lr.specs,
    };
  }
  if (end <= start + 1) {
    return fail("Couldn't find the product section in this listing's description. It doesn't look like either Voyagers Hook template.");
  }
  let block = kids.slice(start + 1, end);
  let condition = "";
  block = block.filter((e) => {
    const m = (e.textContent || "").match(/^\s*condition\s*:\s*(.+)$/i);
    if (m && (e.textContent || "").length < 80) { condition = m[1].replace(/[[\]]/g, "").trim(); return false; }
    return true;
  });
  const r = tidy(block);
  return {
    ok: true,
    alreadyNew: false,
    note: "Found the product section. Check the details, then send it to eBay.",
    title: titleEl ? (titleEl.textContent || "").trim() : "",
    condition,
    free: true,
    product: r.html,
    specs: r.specs,
  };
}

function norm(t: string): string {
  return t.toLowerCase().replace(/[–—]/g, "-").replace(/(\d)\s+(?=[a-z])/g, "$1").replace(/\s+/g, " ").trim();
}

// Remove feature bullets that only repeat something already in the spec table.
export function hideRepeatedFeatures(html: string, rows: SpecRow[]): string {
  if (!rows.length) return html;
  let terms: string[] = [];
  rows.forEach((r) => {
    const label = norm(r[0]);
    const val = norm(r[1]).replace(/\(.*?\)/g, "").trim();
    if (/^(brand|colou?r|type|product type|discipline)$/.test(label) || val === "-" || !val) return;
    if (label.length >= 5) terms.push(label.replace(/\s*\(.*?\)/g, "").trim());
    val.split("/").forEach((v) => { v = v.trim(); if (v.length >= 3 || /\d[a-z]/.test(v)) terms.push(v); });
    if (/section|piece/.test(label) && /^\d+$/.test(val)) { terms.push(val + "-piece"); terms.push(val + " piece"); }
  });
  terms = terms.filter((t) => t && t.length >= 2);
  if (!terms.length) return html;
  const box = document.createElement("div");
  box.innerHTML = html;
  toArr(box.querySelectorAll("li")).forEach((li) => {
    if (!box.contains(li) || li.querySelector("ul,ol")) return;
    const t = " " + norm(li.textContent || "") + " ";
    const hit = terms.some((term) => {
      const e = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^a-z0-9])" + e + "($|[^a-z0-9])").test(t);
    });
    if (hit) li.remove();
  });
  toArr(box.querySelectorAll("ul,ol")).forEach((u) => { if (box.contains(u) && !u.textContent?.trim()) u.remove(); });
  toArr(box.querySelectorAll("h1,h2,h3,h4,p")).forEach((h) => {
    if (/^key features:?$/i.test((h.textContent || "").trim())) {
      const nx = h.nextElementSibling;
      if (!nx || !/^(UL|OL)$/.test(nx.tagName)) h.remove();
    }
  });
  return box.innerHTML.trim();
}

export function specRowsWithBrand(rows: SpecRow[], title: string): SpecRow[] {
  const out = rows.filter((r) => r[0].trim());
  const base: SpecRow[] = out.length ? out : [["Type", "-"], ["Colour", "-"], ["Size", "-"], ["Warranty", "-"]];
  const hasBrand = base.some((r) => /^brand$/i.test(r[0].trim()));
  const first = (title.trim().split(/\s+/)[0] || "").replace(/[^\w&'-]/g, "");
  return hasBrand ? base : [["Brand", first || "-"], ...base];
}

export function buildListing(o: BuildOptions): string {
  const deliveryTile = o.free
    ? '<span class="vh-tile-big">Free</span><span class="vh-tile-small">UK delivery<br>2 to 5 days</span>'
    : '<span class="vh-tile-big">Tracked</span><span class="vh-tile-small">UK delivery<br>2 to 5 days</span>';
  const rows = specRowsWithBrand(o.specs, o.title);
  const tr = rows
    .map((r) => "            <tr><td>" + escapeHtml(r[0]) + "</td><td>" + escapeHtml(r[1] || "-") + "</td></tr>")
    .join("\n");
  const specs = EBAY_SPECS_SECTION.replace(/(<table class="vh-specs">)[\s\S]*?(\s*<\/table>)/, (_m, a, b) => a + "\n" + tr + b);
  const product = o.product
    ? (o.hideRepeats && o.showSpecs ? hideRepeatedFeatures(o.product, rows) : o.product)
    : BLANK_PRODUCT;
  return EBAY_TEMPLATE
    .replace("{{TITLE}}", () => escapeHtml(o.title.trim() || "Product title here"))
    .replace("{{CONDITION}}", () => escapeHtml(o.condition.trim() || "Brand new"))
    .replace("{{DELIVERY_TILE}}", () => deliveryTile)
    .replace("{{SPECS}}", () => (o.showSpecs ? specs : ""))
    .replace("{{PRODUCT}}", () => product);
}
