// lib/elements.mjs — interactive-element enumeration + stable locator descriptors.
// Contract: enumerateElements(page, max=30) -> ElementDescriptor[]
//   { id, role, name, tag, locator: {strategy: "role"|"text"|"css", ...}, disabled, editable }
// Visible + enabled only, document order, deduped. Prefers role+accessible-name,
// falls back to text, then a computed unique css path.

// Exported so lib/reprogen.mjs can embed the enumeration verbatim into a
// standalone expected-element repro script (parity-tested byte-identical).
export const CANDIDATE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"]';

export async function enumerateElements(page, max = 30, selectorDenylist = []) {
  let raw;
  try {
    raw = await page.evaluate(collectCandidates, {
      selector: CANDIDATE_SELECTOR,
      denylist: Array.isArray(selectorDenylist) ? selectorDenylist : [],
    });
  } catch {
    // A navigation racing the evaluate destroys the execution context
    // ("Execution context was destroyed..."). An empty element table degrades
    // the turn gracefully; throwing here would kill the whole session (and,
    // overnight, discard every candidate found so far without a report).
    return [];
  }
  const out = [];
  // nth counts include visible-but-disabled elements: they stay in the ARIA
  // tree, so getByRole(...).nth(n) counts them — skipping them here would make
  // recorded locators resolve to the wrong element on replay.
  const nthCounts = new Map();
  for (const r of raw) {
    const key = locatorKey(r);
    const nth = key === null ? 0 : (nthCounts.get(key) ?? 0);
    if (key !== null) nthCounts.set(key, nth + 1);
    if (r.disabled || r.denied || out.length >= max) continue;
    out.push({
      id: out.length,
      role: r.role || null,
      name: r.name || null,
      tag: r.tag,
      locator: buildLocator(r, nth),
      disabled: false,
      editable: r.editable,
    });
  }
  return out;
}

// Exported for lib/reprogen.mjs embedding (see CANDIDATE_SELECTOR).
export function locatorKey(r) {
  if (r.role && r.name) return "role|" + r.role + "|" + r.name;
  if (r.text) return "text|" + r.text;
  return null;
}

export function buildLocator(r, nth) {
  if (r.role && r.name) return { strategy: "role", role: r.role, name: r.name, nth };
  if (r.text) return { strategy: "text", text: r.text, nth };
  return { strategy: "css", css: r.css, nth: 0 };
}

// Runs inside the page. Must stay self-contained (it is serialized).
// Exported for lib/reprogen.mjs embedding (see CANDIDATE_SELECTOR).
export function collectCandidates({ selector, denylist }) {
  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();

  const visible = (el) => {
    if (el.closest("[hidden]")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const roles = {
        button: "button", submit: "button", reset: "button", image: "button",
        checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
        search: "searchbox", email: "textbox", tel: "textbox", url: "textbox",
        text: "textbox", password: "textbox",
      };
      return roles[type] || "";
    }
    return "";
  };

  // innerText reflects CSS rendering (text-transform can change case: "Your
  // name" renders "YOUR NAME") but getByRole matches the spec accname computed
  // from DOM text — a case-only difference means a CSS transform, so prefer the
  // DOM casing. When they differ beyond case, innerText's hidden-content
  // filtering (display:none) is closer to the spec than raw textContent.
  const domText = (el) => {
    const rendered = collapse(el.innerText);
    const raw = collapse(el.textContent);
    if (rendered && raw && rendered.toLowerCase() === raw.toLowerCase()) return raw;
    return rendered || raw;
  };

  // Approximate accname. When unsure, return "" — an empty name safely falls
  // back to css, while a wrong name breaks getByRole resolution on replay.
  // Text is read via domText so a CSS text-transform (uppercase field labels)
  // never leaks a rendered-case name that getByRole's DOM-case accname can't
  // match on replay.
  const accessibleName = (el) => {
    const ariaLabel = collapse(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? domText(ref) : "";
        })
        .join(" ");
      if (collapse(text)) return collapse(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (el.labels && el.labels.length > 0) {
        const text = Array.from(el.labels)
          .map((l) => domText(l))
          .join(" ");
        if (collapse(text)) return collapse(text);
      }
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && (type === "button" || type === "submit" || type === "reset")) {
        return collapse(el.getAttribute("value"));
      }
      return collapse(el.getAttribute("placeholder")) || collapse(el.getAttribute("title"));
    }
    return domText(el) || collapse(el.getAttribute("title"));
  };

  const cssPath = (el) => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      let nth = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) nth += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
      node = node.parentElement;
    }
    return "html > " + parts.join(" > ");
  };

  const isDisabled = (el) =>
    el.disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    Boolean(el.closest("fieldset[disabled]"));

  const isEditable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return !el.readOnly;
    if (tag === "select") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const nonEditable = ["button", "submit", "reset", "image", "checkbox", "radio", "hidden", "file"];
      return !el.readOnly && !nonEditable.includes(type);
    }
    return el.isContentEditable === true;
  };

  const records = [];
  for (const el of document.querySelectorAll(selector)) {
    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") continue;
    if (!visible(el)) continue;
    records.push({
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accessibleName(el),
      text: collapse(el.innerText || ""),
      css: cssPath(el),
      disabled: isDisabled(el),
      editable: isEditable(el),
      denied: (denylist || []).some((sel) => {
        try {
          return el.matches(sel);
        } catch (e) {
          return false;
        }
      }),
    });
  }
  return records;
}
