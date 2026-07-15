// lib/sweep.mjs — deterministic SWEEP MODE (zero/minimal LLM calls).
// runSweep({config, brain, runDir, log, mintId?, budget?}) -> {findings, stats}
//
// Where runSession (lib/session.mjs) asks a brain which few elements to touch,
// sweep aims for EXHAUSTIVE coverage: BFS-crawl every same-origin route, and
// per route exercise EVERY interactive element (no 30-element cap) plus run
// three input passes against every form. It shares the browser plumbing, the
// oracles, the shared finding collector, and the executeAction path with the
// session, so a sweep finding is shaped identically to an explorer finding and
// replays through the unchanged reverify pipeline. Progress is checkpointed
// into the run dir after every element so a maxMinutes hard stop resumes
// instead of restarting.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { enumerateElements } from "./elements.mjs";
import { performStep, safePageUrl, resolveLocator } from "./trace.mjs";
import { executeAction } from "./explorer.mjs";
import { attachOracles } from "./oracles.mjs";
import { createSessionBudget } from "./budget.mjs";
import { createFindingCollector } from "./collector.mjs";
import { createIdMinter } from "./session.mjs";
import { createCoverageTracker, loadCheckpoint, saveCheckpoint } from "./sweep-coverage.mjs";
import { synthesizeFieldValue, SWEEP_PASSES } from "./sweep-input.mjs";

const CONSOLE_TAIL_MAX = 20;
const ORACLE_GRACE_MS = 2000;
const OVERLAY_GUARD = 4; // max close attempts before we force-move-on
const DENY_KIND_RE = /blocked by denyActionKinds/;

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export async function runSweep({ config, brain = null, runDir, log = defaultLog, mintId = createIdMinter(), budget }) {
  const startedMs = Date.now();
  const stats = {
    mode: "sweep",
    routesVisited: 0,
    actionsExecuted: 0,
    llmCalls: 0,
    turnsOk: 0,
    turnsFailed: 0,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: null,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    coverage: null,
  };
  budget = budget ?? createSessionBudget(config.budget);
  const origin = new URL(config.target.url).origin;
  const maxRoutes = config.target.maxRoutes ?? 12;
  const selectorDenylist = config.target.selectorDenylist ?? [];
  const denyActionKinds = config.target.denyActionKinds ?? [];
  const navTimeoutMs = config.reverify?.navTimeoutMs ?? 15000;
  const seeds = (config.target.routes?.length ? config.target.routes : ["/"]).map((r) =>
    stripHash(new URL(r, origin).href),
  );

  const frontier = [...new Set(seeds)];
  const enqueued = new Set(frontier);
  const visited = [];
  const navAllowList = new Set(seeds.map((u) => pathSearchOf(u)));

  const coverage = createCoverageTracker();
  const checkpoint = loadCheckpoint(runDir) ?? { version: 1, routesDone: [], current: null, coverage: { routes: [] } };
  const routesDone = new Set(checkpoint.routesDone ?? []);
  for (const r of checkpoint.coverage?.routes ?? []) coverage.restore(r);

  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Same fail-closed off-origin abort as the session: a click on an external
  // anchor lands on the foreign origin before anything notices, so abort
  // off-origin main-frame navigations before they commit.
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
      let reqOrigin;
      try {
        reqOrigin = new URL(request.url()).origin;
      } catch {
        reqOrigin = null;
      }
      if (reqOrigin !== origin) return route.abort("aborted");
    }
    return route.continue();
  });
  const oracles = attachOracles(context, { origin, oraclesConfig: config.oracles, navAllowList });
  const consoleTail = [];
  const onConsole = (msg) => {
    consoleTail.push("[" + msg.type() + "] " + msg.text());
    if (consoleTail.length > CONSOLE_TAIL_MAX) consoleTail.shift();
  };
  context.on("console", onConsole);

  const collector = createFindingCollector({ oracles, consoleTail, runDir, log, mintId });

  const harvestLinks = async (page) => {
    let hrefs = [];
    try {
      hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
    } catch {
      return;
    }
    for (const href of hrefs) {
      let u;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (u.origin !== origin) continue;
      navAllowList.add(u.pathname + u.search);
      const route = stripHash(u.href);
      if (!enqueued.has(route)) {
        enqueued.add(route);
        frontier.push(route);
      }
    }
  };

  const persist = (currentRoute, elementsDone) => {
    saveCheckpoint(runDir, {
      version: 1,
      routesDone: [...routesDone],
      current: currentRoute ? { route: currentRoute, elementsDone } : null,
      coverage: coverage.summary(),
    });
  };

  // Return to the route base whenever an action navigated the page away — the
  // element queue was enumerated against the route, so a nav-away (same-origin
  // link, or an aborted off-origin click that still changed the URL) would make
  // the remaining descriptors resolve against the wrong page. Recorded as a
  // trace step so replays stay identical.
  const restoreRoute = async (page, route, trace) => {
    if (stripHash(safePageUrl(page)) === route) return;
    const i = trace.length;
    oracles.setStep(i);
    const step = await performStep(page, { i, kind: "goto", value: route }, { navTimeoutMs });
    trace.push(step);
    await collector.collectOracleFindings(page, trace);
  };

  const sweepRoute = async (page, route, startIndex) => {
    const trace = [];
    oracles.setStep(0);
    const step0 = await performStep(page, { i: 0, kind: "goto", value: route }, { navTimeoutMs });
    trace.push(step0);
    await harvestLinks(page);
    await collector.collectOracleFindings(page, trace);
    if (!step0.ok) {
      coverage.setFound(route, 0);
      log("warn", "sweep: route failed to load: " + route + " — " + step0.error);
      return true;
    }

    const allowed = await enumerateElements(page, Infinity, selectorDenylist);
    const total = await enumerateElements(page, Infinity, []);
    coverage.setFound(route, total.length);
    const deniedByDenylist = total.length - allowed.length;
    if (startIndex === 0 && deniedByDenylist > 0) coverage.recordSkipped(route, deniedByDenylist);

    for (let i = startIndex; i < allowed.length; i++) {
      if (!budget.timeLeft()) {
        log("info", "sweep: time budget exhausted mid-route " + route);
        persist(route, i);
        return false;
      }
      await restoreRoute(page, route, trace);
      const el = allowed[i];
      const action = await actionForElement(page, el, i);
      const stepIndex = trace.length;
      oracles.setStep(stepIndex);
      const step = await executeAction(page, action, allowed, { origin, denyActionKinds });
      step.i = stepIndex;
      trace.push(step);
      stats.actionsExecuted += 1;
      await harvestLinks(page);
      await collector.collectOracleFindings(page, trace);
      classify(coverage, route, step);
      await handleOverlay(page, route, trace, { oracles, collector, denyActionKinds });
      persist(route, i + 1);
    }

    await sweepForms(page, route, trace, {
      oracles,
      collector,
      coverage,
      denyActionKinds,
      selectorDenylist,
      budget,
      navTimeoutMs,
      restoreRoute,
      harvestLinks,
    });

    // End-of-route grace + final drain (mirrors the session): slow failing
    // responses from the last action must land while this trace is current.
    try {
      await page.waitForTimeout(ORACLE_GRACE_MS);
    } catch {
      // page/context died — drain whatever already landed
    }
    await collector.collectOracleFindings(page, trace);
    routesDone.add(route);
    persist(null, 0);
    return true;
  };

  try {
    const page = await context.newPage();
    while (frontier.length > 0 && visited.length < maxRoutes && budget.timeLeft()) {
      const route = frontier.shift();
      visited.push(route);
      if (routesDone.has(route)) {
        log("info", "sweep: skipping already-swept route (resumed): " + route);
        continue;
      }
      const startIndex =
        checkpoint.current && checkpoint.current.route === route ? checkpoint.current.elementsDone : 0;
      log("info", "sweep: route " + visited.length + "/" + maxRoutes + ": " + route);
      const keepGoing = await sweepRoute(page, route, startIndex);
      if (!keepGoing) break;
    }
  } finally {
    context.off("console", onConsole);
    oracles.dispose();
    await browser.close().catch(() => {});
  }

  stats.routesVisited = visited.length;
  stats.coverage = coverage.summary();
  stats.endedAt = new Date().toISOString();
  stats.durationMs = Date.now() - startedMs;
  log(
    "info",
    "sweep done: " + collector.findings.length + " candidate(s), " + stats.routesVisited + " route(s), " +
      stats.coverage.totals.coveragePct + "% element coverage",
  );
  return { findings: collector.findings, stats };
}

// One interactive element -> the systematic action for its kind: fill editable
// textboxes (a plausible value), select an option for <select>, click
// everything else (buttons, links, checkboxes, radios — click toggles them).
async function actionForElement(page, el, id) {
  if (el.tag === "select") {
    const value = await firstChoosableOption(page, el);
    return { kind: "select", elementId: id, value };
  }
  if (el.editable) {
    const field = { type: roleToInputType(el.role), name: el.name ?? "", placeholder: "" };
    return { kind: "fill", elementId: id, value: synthesizeFieldValue(field, "valid") };
  }
  return { kind: "click", elementId: id };
}

function roleToInputType(role) {
  if (role === "searchbox") return "search";
  if (role === "spinbutton") return "number";
  return "text";
}

// The first option value that differs from the current selection (so the
// select actually changes), falling back to the first option. null when the
// element is unreadable — executeAction then records the failure.
async function firstChoosableOption(page, el) {
  try {
    const opts = await resolveLocator(page, el.locator).evaluate((sel) => ({
      current: sel.value,
      values: Array.from(sel.options).map((o) => o.value),
    }));
    return opts.values.find((v) => v !== opts.current) ?? opts.values[0] ?? null;
  } catch {
    return null;
  }
}

function classify(coverage, route, step) {
  if (step.ok) coverage.recordExercised(route);
  else if (DENY_KIND_RE.test(String(step.error ?? ""))) coverage.recordSkipped(route, 1);
  else coverage.recordFailed(route);
}

// After an action opens a modal/overlay, exercise its controls once and then
// close it (close control, else Escape) before continuing — an open modal must
// never mask the rest of the queue. Best-effort and never throws.
//
// Overlay controls are transient (no stable role/name/css we can replay), so
// their clicks are NOT pushed onto the route trace — recording an
// un-replayable step there would break reverify for every finding that clones
// the trace afterward. Any oracle signal the overlay raises is still collected
// against the base trace (the action that opened it).
async function handleOverlay(page, route, trace, { oracles, collector, denyActionKinds }) {
  if (denyActionKinds.includes("click")) return;
  const dialogSel = '[role="dialog"], [aria-modal="true"], dialog[open]';
  for (let guard = 0; guard < OVERLAY_GUARD; guard++) {
    const dialog = page.locator(dialogSel).first();
    let visible = false;
    try {
      visible = await dialog.isVisible({ timeout: 250 });
    } catch {
      visible = false;
    }
    if (!visible) break;

    let controls = [];
    try {
      controls = await dialog.locator("button, [role=button]").all();
    } catch {
      controls = [];
    }
    // Exercise non-closing controls once (bounded), then close via a close-ish
    // control, else Escape.
    let closer = null;
    for (const control of controls.slice(0, 10)) {
      if (await isCloseControl(control)) {
        closer = closer ?? control;
        continue;
      }
      await bestEffortClick(control);
    }
    if (closer) {
      await bestEffortClick(closer);
    } else {
      try {
        await page.keyboard.press("Escape");
      } catch {
        // nothing focused / page gone — next guard iteration re-checks
      }
    }
  }
  // Drain any oracle events the overlay raised, attributed to the base trace.
  oracles.setStep(trace.length);
  await collector.collectOracleFindings(page, trace);
}

async function isCloseControl(control) {
  try {
    const label = ((await control.getAttribute("aria-label")) || (await control.textContent()) || "").trim();
    return /close|dismiss|cancel|×|✕|x$/i.test(label);
  } catch {
    return false;
  }
}

async function bestEffortClick(control) {
  try {
    await control.click({ timeout: 2000 });
  } catch {
    // control detached / not clickable — ignore, hygiene only
  }
}

// Three input passes per form: empty submit, hostile input, plausible valid
// input. Each pass reloads the route first (fresh form state) and submits
// through the shared executeAction path so denyActionKinds/selectorDenylist and
// trace recording apply exactly as they do to any other element.
async function sweepForms(page, route, trace, ctx) {
  const { collector, coverage, denyActionKinds, selectorDenylist, budget, restoreRoute, harvestLinks, oracles } = ctx;
  // The element sweep may have left the page on a post-submit URL — return to
  // the route so the form list is enumerated against the route, not wherever
  // the last click landed.
  await restoreRoute(page, route, trace);
  let forms;
  try {
    forms = await collectFormMeta(page, selectorDenylist);
  } catch {
    return;
  }
  for (let fi = 0; fi < forms.length; fi++) {
    for (const pass of SWEEP_PASSES) {
      if (!budget.timeLeft()) return;
      await restoreRoute(page, route, trace);
      let fresh;
      try {
        fresh = await collectFormMeta(page, selectorDenylist);
      } catch {
        fresh = [];
      }
      const form = fresh[fi];
      if (!form) continue;

      // Synthetic element table so form fields/submit ride the same
      // executeAction deny + recording path as enumerated elements.
      const elements = [];
      form.fields.forEach((f, j) => elements.push({ id: j, ...descriptorFromCss(f.css), editable: true }));
      const submitId = form.submit ? elements.length : -1;
      if (form.submit) elements.push({ id: submitId, ...descriptorFromCss(form.submit.css) });

      form.fields.forEach((f, j) => {
        f.elementId = j;
      });
      for (const field of form.fields) {
        if (field.denied) {
          coverage.recordSkipped(route, 1);
          continue;
        }
        const value = synthesizeFieldValue(
          { type: field.type, name: field.name, placeholder: field.placeholder },
          pass,
        );
        const stepIndex = trace.length;
        oracles.setStep(stepIndex);
        const step = await executeAction(page, { kind: "fill", elementId: field.elementId, value }, elements, {
          origin: new URL(route).origin,
          denyActionKinds,
        });
        step.i = stepIndex;
        trace.push(step);
        await collector.collectOracleFindings(page, trace);
      }

      // Submit: click the submit control, else press Enter in the first field.
      const stepIndex = trace.length;
      oracles.setStep(stepIndex);
      let submitStep;
      if (submitId >= 0) {
        submitStep = await executeAction(page, { kind: "click", elementId: submitId }, elements, {
          origin: new URL(route).origin,
          denyActionKinds,
        });
      } else if (form.fields[0]) {
        submitStep = await executeAction(page, { kind: "press", elementId: 0, value: "Enter" }, elements, {
          origin: new URL(route).origin,
          denyActionKinds,
        });
      } else {
        submitStep = null;
      }
      if (submitStep) {
        submitStep.i = stepIndex;
        trace.push(submitStep);
      }
      await harvestLinks(page);
      await collector.collectOracleFindings(page, trace);
      coverage.recordForm(route);
    }
  }
}

function descriptorFromCss(css) {
  return { locator: { strategy: "css", css, nth: 0 } };
}

// In-page: describe every form's fillable fields (a unique css path each, plus
// type/name/placeholder and a selectorDenylist verdict) and its submit control.
// The css path mirrors lib/elements.mjs so recorded steps replay identically.
function collectFormMeta(page, selectorDenylist) {
  return page.evaluate(
    ({ denylist }) => {
      const cssPath = (el) => {
        if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
          return "#" + CSS.escape(el.id);
        }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node.tagName !== "HTML") {
          let nth = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) nth += 1;
            sib = sib.previousElementSibling;
          }
          parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
          node = node.parentElement;
        }
        return "html > " + parts.join(" > ");
      };
      const denied = (el) =>
        (denylist || []).some((sel) => {
          try {
            return el.matches(sel);
          } catch {
            return false;
          }
        });
      const FILLABLE =
        "input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]), textarea, select";
      return Array.from(document.forms).map((form) => {
        const fields = Array.from(form.querySelectorAll(FILLABLE)).map((el) => ({
          css: cssPath(el),
          type: (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase(),
          name: el.name || "",
          placeholder: el.getAttribute("placeholder") || "",
          denied: denied(el),
        }));
        const submitEl =
          form.querySelector("button[type=submit], input[type=submit]") ||
          form.querySelector("button:not([type])");
        return { fields, submit: submitEl ? { css: cssPath(submitEl) } : null };
      });
    },
    { denylist: Array.isArray(selectorDenylist) ? selectorDenylist : [] },
  );
}

function stripHash(href) {
  const u = new URL(href);
  u.hash = "";
  return u.href;
}

function pathSearchOf(href) {
  const u = new URL(href);
  return u.pathname + u.search;
}
