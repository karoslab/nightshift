// lib/budget.mjs — call/time/session budget guards (agent A).
// Pure factories with an injectable clock (ms epoch) for tests.

const DEFAULTS = {
  maxLlmCalls: 40,
  maxMinutes: 45,
  maxSessionsPerNight: 4,
  stopAtHour: 6,
};

// PER-SESSION scope: the overnight loop creates a fresh one per session.
export function createSessionBudget(budgetConfig = {}, clock = Date.now) {
  const maxLlmCalls = budgetConfig.maxLlmCalls ?? DEFAULTS.maxLlmCalls;
  const maxMinutes = budgetConfig.maxMinutes ?? DEFAULTS.maxMinutes;
  const startedAt = clock();
  let llmCalls = 0;

  return {
    tryConsumeCall() {
      if (llmCalls >= maxLlmCalls) return false;
      llmCalls += 1;
      return true;
    },
    timeLeft() {
      return clock() - startedAt < maxMinutes * 60_000;
    },
    summary() {
      const minutes = Math.round(((clock() - startedAt) / 60_000) * 10) / 10;
      return { llmCalls, minutes };
    },
  };
}

// NIGHT scope: created ONCE by the overnight loop.
export function createNightBudget(budgetConfig = {}, clock = Date.now) {
  const maxSessionsPerNight = budgetConfig.maxSessionsPerNight ?? DEFAULTS.maxSessionsPerNight;
  const stopAtHour = budgetConfig.stopAtHour ?? DEFAULTS.stopAtHour;

  return {
    sessionAllowed(nSessionsSoFar) {
      return nSessionsSoFar < maxSessionsPerNight;
    },
    // Midnight wrap (pinned): false when hour >= stopAtHour && hour < 12, true
    // otherwise — a run starting 23:00 with stopAtHour 6 runs through midnight
    // and stops at 06:00. This formula only expresses MORNING stop hours
    // (0-11); config.mjs rejects 12-23, for which the window would be empty
    // and the stop hour silently ignored.
    beforeStopHour() {
      const hour = new Date(clock()).getHours();
      return !(hour >= stopAtHour && hour < 12);
    },
  };
}
