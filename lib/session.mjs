// lib/session.mjs — orchestrates one QA session end to end.
// runSession({config, brain, runDir, log}) -> {findings, stats}
// Returns candidates only (status "candidate"); the caller wires reverify —
// that separation keeps replay LLM-free.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { enumerateElements } from "./elements.mjs";
import { performStep, safePageUrl } from "./trace.mjs";
import { executeAction } from "./explorer.mjs";
import { attachOracles } from "./oracles.mjs";
import { createSessionBudget } from "./budget.mjs";
import { createFindingCollector } from "./collector.mjs";
import { buildSystemPrompt, buildTurnPrompt } from "./brain/prompts.mjs";

const CONSOLE_TAIL_MAX = 20;
const PAGE_TEXT_EXCERPT_MAX = 1500;
// End-of-route grace before the final oracle drain (mirrors reverify's
// GRACE_MS): a slow failing response triggered by the route's LAST action must
// land while THIS trace is still current — without it the event attaches to
// the next route's trace (reverify then replays the wrong steps) or, after the
// final route, is never collected at all.
const ORACLE_GRACE_MS = 2000;

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

// Finding-id minting is PER RUN DIR, not per session: `nightshift overnight`
// aggregates several sessions into one run dir, and a per-session counter
// would mint NS-001 twice — overwriting screenshots and shipping a report
// whose two NS-001 entries point at one repro script (misattributed evidence).
export function createIdMinter(start = 1) {
  let next = start;
  return () => "NS-" + String(next++).padStart(3, "0");
}

export async function runSession({ config, brain, runDir, log = defaultLog, mintId = createIdMinter() }) {
  const startedMs = Date.now();
  const stats = {
    routesVisited: 0,
    actionsExecuted: 0,
    llmCalls: 0,
    turnsOk: 0,
    turnsFailed: 0,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: null,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
  const budget = createSessionBudget(config.budget);
  const origin = new URL(config.target.url).origin;
  const maxRoutes = config.target.maxRoutes ?? 12;
  const actionsPerPage = config.target.actionsPerPage ?? 6;
  const selectorDenylist = config.target.selectorDenylist ?? [];
  const denyActionKinds = config.target.denyActionKinds ?? [];
  const navTimeoutMs = config.reverify?.navTimeoutMs ?? 15000;
  const seeds = (config.target.routes?.length ? config.target.routes : ["/"]).map((r) =>
    stripHash(new URL(r, origin).href),
  );

  // Frontier: seed routes + harvested same-origin anchor links, up to maxRoutes.
  const frontier = [...new Set(seeds)];
  const enqueued = new Set(frontier);
  const visited = [];
  // Live set read by the dead-link oracle: seed routes + real anchor hrefs,
  // keyed by pathname+search — pathname alone would whitelist a brain-invented
  // goto "/product" because a real "/product?id=1" anchor was harvested.
  const navAllowList = new Set(seeds.map((u) => pathSearchOf(u)));

  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Fail-closed at the network layer: a click on an external anchor has no
  // goto-style guard (unlike executeAction's brain-driven goto), so without
  // this the page actually lands on the foreign origin before anything
  // notices. Abort main-frame navigations off-origin before they commit —
  // "aborted" maps to net::ERR_ABORTED, which the request-failed oracle
  // already treats as normal (ABORT_FAMILY_RE) so this never files a false
  // nav-failure finding.
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
  const system = buildSystemPrompt();

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

  // Returns false when the session budget is exhausted (ends the session).
  const visitRoute = async (page, route) => {
    const trace = [];
    oracles.setStep(0);
    const step0 = await performStep(page, { i: 0, kind: "goto", value: route }, { navTimeoutMs });
    trace.push(step0);
    await harvestLinks(page);
    await collector.collectOracleFindings(page, trace);
    if (!step0.ok) {
      log("warn", "route failed to load: " + route + " — " + step0.error);
      return true;
    }

    let keepGoing = true;
    for (let n = 0; n < actionsPerPage; n++) {
      if (!budget.timeLeft()) {
        log("info", "session time budget exhausted");
        keepGoing = false;
        break;
      }
      if (!budget.tryConsumeCall()) {
        log("info", "session LLM call budget exhausted");
        keepGoing = false;
        break;
      }
      const elements = await enumerateElements(page, undefined, selectorDenylist);
      const user = buildTurnPrompt({
        pageUrl: safePageUrl(page),
        title: await safeTitle(page),
        elements,
        recentFailures: recentFailures(oracles.events),
        visitedUrls: [...visited],
        remainingActions: actionsPerPage - n,
        pageTextExcerpt: await pageTextExcerpt(page),
      });
      stats.llmCalls += 1;
      const reply = await brain.ask({ system, user });
      accumulateUsage(stats.usage, reply.usage);
      if (!reply.ok) {
        stats.turnsFailed += 1;
        log("warn", "brain turn failed (skipped): " + String(reply.rawText).slice(0, 200));
        continue;
      }
      stats.turnsOk += 1;
      const json = reply.json ?? {};
      const semantics = Array.isArray(json.findings) ? json.findings : [];
      for (const raw of semantics) await collector.collectSemanticFinding(page, trace, raw);

      if (json.action && typeof json.action === "object") {
        const stepIndex = trace.length;
        oracles.setStep(stepIndex);
        const step = await executeAction(page, json.action, elements, { origin, denyActionKinds });
        step.i = stepIndex;
        trace.push(step);
        stats.actionsExecuted += 1;
        await harvestLinks(page);
        await collector.collectOracleFindings(page, trace);
        // A click on an external anchor navigates the page off-origin (clicks
        // have no goto-style guard). Recover immediately — recorded as a trace
        // step so replays stay identical — instead of burning the remaining
        // action budget interacting with a foreign site the oracles ignore.
        if (!isOnOrigin(page, origin)) {
          log("warn", "left target origin (" + safePageUrl(page) + ") — returning to " + route);
          const backIndex = trace.length;
          oracles.setStep(backIndex);
          const back = await performStep(page, { i: backIndex, kind: "goto", value: route }, { navTimeoutMs });
          trace.push(back);
        }
      }
      if (json.done === true) break;
    }
    // End-of-route grace + final drain: give in-flight responses from the last
    // action ORACLE_GRACE_MS to land while this trace is still current (this
    // also runs when the budget ends the session — those events would
    // otherwise be lost entirely).
    try {
      await page.waitForTimeout(ORACLE_GRACE_MS);
    } catch {
      // page/context died during grace — drain whatever already landed
    }
    await collector.collectOracleFindings(page, trace);
    return keepGoing;
  };

  try {
    const page = await context.newPage();
    while (frontier.length > 0 && visited.length < maxRoutes && budget.timeLeft()) {
      const route = frontier.shift();
      visited.push(route);
      log("info", "visiting route " + visited.length + "/" + maxRoutes + ": " + route);
      const keepGoing = await visitRoute(page, route);
      if (!keepGoing) break;
    }
  } finally {
    context.off("console", onConsole);
    oracles.dispose();
    await browser.close().catch(() => {});
  }

  stats.routesVisited = visited.length;
  stats.endedAt = new Date().toISOString();
  stats.durationMs = Date.now() - startedMs;
  log(
    "info",
    "session done: " + collector.findings.length + " candidate(s), " +
      stats.routesVisited + " route(s), " + stats.llmCalls + " LLM call(s)",
  );
  return { findings: collector.findings, stats };
}

function recentFailures(events) {
  return events.slice(-5).map((e) => (e.oracle + ": " + firstLine(e.message)).slice(0, 200));
}

function accumulateUsage(agg, usage) {
  if (!usage) return;
  agg.inputTokens += usage.inputTokens || 0;
  agg.outputTokens += usage.outputTokens || 0;
  if (typeof usage.costUsd === "number") agg.costUsd = (agg.costUsd ?? 0) + usage.costUsd;
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

async function pageTextExcerpt(page) {
  try {
    const text = await page.innerText("body");
    return text.replace(/\s+/g, " ").trim().slice(0, PAGE_TEXT_EXCERPT_MAX);
  } catch {
    return "";
  }
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

function isOnOrigin(page, origin) {
  try {
    return new URL(safePageUrl(page)).origin === origin;
  } catch {
    return false;
  }
}

function firstLine(s) {
  return String(s ?? "").split("\n", 1)[0];
}
