// lib/elements.mjs — interactive-element enumeration + stable locator descriptors.
// Contract: enumerateElements(page, max=30) -> ElementDescriptor[]
//   { id, role, name, tag, locator: {strategy: "role"|"text"|"css", ...}, disabled, editable }
// Visible + enabled only, document order, deduped. Prefers role+accessible-name,
// falls back to text, then a computed unique css path.

const CANDIDATE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"]';

export async function enumerateElements(page, max = 30) {
  let raw;
  try {
    raw = await page.evaluate(collectCandidates, CANDIDATE_SELECTOR);
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
    if (r.disabled || out.length >= max) continue;
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

function locatorKey(r) {
  if (r.role && r.name) return "role|" + r.role + "|" + r.name;
  if (r.text) return "text|" + r.text;
  return null;
}

function buildLocator(r, nth) {
  if (r.role && r.name) return { strategy: "role", role: r.role, name: r.name, nth };
  if (r.text) return { strategy: "text", text: r.text, nth };
  return { strategy: "css", css: r.css, nth: 0 };
}

// Runs inside the page. Must stay self-contained (it is serialized).
function collectCandidates(selector) {
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

  // Approximate accname. When unsure, return "" — an empty name safely falls
  // back to css, while a wrong name breaks getByRole resolution on replay.
  const accessibleName = (el) => {
    const ariaLabel = collapse(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? ref.innerText || ref.textContent || "" : "";
        })
        .join(" ");
      if (collapse(text)) return collapse(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (el.labels && el.labels.length > 0) {
        const text = Array.from(el.labels)
          .map((l) => l.innerText || l.textContent || "")
          .join(" ");
        if (collapse(text)) return collapse(text);
      }
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && (type === "button" || type === "submit" || type === "reset")) {
        return collapse(el.getAttribute("value"));
      }
      return collapse(el.getAttribute("placeholder")) || collapse(el.getAttribute("title"));
    }
    return collapse(el.innerText || el.textContent) || collapse(el.getAttribute("title"));
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
    });
  }
  return records;
}
