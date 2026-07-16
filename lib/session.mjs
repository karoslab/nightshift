// lib/session.mjs — orchestrates one QA session end to end.
// runSession({config, brain, runDir, log}) -> {findings, stats}
// Returns candidates only (status "candidate"); the caller wires reverify —
// that separation keeps replay LLM-free.
//
// Roles: exploration + journeys run ONCE PER ROLE. The implicit "anonymous"
// role always runs (a plain fresh context); each configured target.auth role
// logs in once, its storageState is persisted under the run dir, and its
// exploration context is opened from that state. Every finding is tagged with
// the role that produced it (the collector stamps role; journeys add the
// journey name). A role whose login fails is skipped with a warning — a broken
// auth block never discards the anonymous pass.

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
import { establishRoleSessions } from "./auth.mjs";
import { runJourneys } from "./journeys.mjs";

const ANONYMOUS_ROLE = "anonymous";

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

export async function runSession({ config, brain, runDir, log = defaultLog, mintId = createIdMinter(), env = process.env }) {
  const startedMs = Date.now();
  const stats = {
    routesVisited: 0,
    actionsExecuted: 0,
    llmCalls: 0,
    turnsOk: 0,
    turnsFailed: 0,
    rolesExplored: [],
    startedAt: new Date(startedMs).toISOString(),
    endedAt: null,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
  const origin = new URL(config.target.url).origin;
  const navTimeoutMs = config.reverify?.navTimeoutMs ?? 15000;
  const authRoles = config.target.auth?.roles ?? [];
  const journeys = config.target.journeys ?? [];

  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const allFindings = [];
  try {
    // Anonymous (implicit default) always runs; each configured auth role that
    // logs in adds a pass seeded with its persisted storageState.
    // establishRoleSessions owns the per-role login loop and already skips a
    // role whose login fails (logged), so it can never discard the anonymous
    // pass prepended here.
    const authSessions = authRoles.length > 0 ? await establishRoleSessions({ config, browser, runDir, env, log }) : [];
    const roleSessions = [{ name: ANONYMOUS_ROLE, storageState: undefined }, ...authSessions];

    for (const roleSession of roleSessions) {
      const findings = await exploreRole(browser, roleSession, {
        config,
        brain,
        runDir,
        log,
        mintId,
        stats,
        journeys,
        origin,
        navTimeoutMs,
      });
      allFindings.push(...findings);
      stats.rolesExplored.push(roleSession.name);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  stats.endedAt = new Date().toISOString();
  stats.durationMs = Date.now() - startedMs;
  log(
    "info",
    "session done: " + allFindings.length + " candidate(s), " +
      stats.routesVisited + " route(s) across " + stats.rolesExplored.length + " role(s), " +
      stats.llmCalls + " LLM call(s)",
  );
  return { findings: allFindings, stats };
}

// One role's pass: a fresh context (seeded with the role's storageState when
// authenticated), the same explorer loop and oracles as before, then the
// deterministic journeys. Findings are stamped with the role via the collector
// tag. Aggregate stats are accumulated onto the shared `stats` object.
async function exploreRole(browser, roleSession, { config, brain, runDir, log, mintId, stats, journeys, origin, navTimeoutMs }) {
  const maxRoutes = config.target.maxRoutes ?? 12;
  const actionsPerPage = config.target.actionsPerPage ?? 6;
  const selectorDenylist = config.target.selectorDenylist ?? [];
  const denyActionKinds = config.target.denyActionKinds ?? [];
  const budget = createSessionBudget(config.budget);
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

  const contextOpts = roleSession.storageState ? { storageState: roleSession.storageState } : {};
  const context = await browser.newContext(contextOpts);
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

  const collector = createFindingCollector({
    oracles,
    consoleTail,
    runDir,
    log,
    mintId,
    tag: { role: roleSession.name },
  });
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

  // Returns false when the session budget is exhausted (ends exploration).
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
      log("info", "[" + roleSession.name + "] visiting route " + visited.length + "/" + maxRoutes + ": " + route);
      const keepGoing = await visitRoute(page, route);
      if (!keepGoing) break;
    }
    // Deterministic journeys run every session with all oracles watching, and
    // are NOT gated by the LLM budget (they make no brain calls). A journey
    // with a `roles` scope runs only for the named roles, so a login-gated
    // journey never runs (and false-positives) under a role it isn't meant for;
    // an unscoped journey runs for every role.
    const roleJourneys = journeys.filter(
      (j) => !Array.isArray(j.roles) || j.roles.includes(roleSession.name),
    );
    await runJourneys(page, { journeys: roleJourneys, origin, collector, oracles, navTimeoutMs, log });
  } finally {
    context.off("console", onConsole);
    oracles.dispose();
    await context.close().catch(() => {});
  }

  stats.routesVisited += visited.length;
  return collector.findings;
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
