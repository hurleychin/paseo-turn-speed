import type { PluginButton, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { approx, fmtDuration, fmtRate, fmtTokens } from "./format";
import type { AgentSpeedStore } from "./store";
import type { TeamView } from "./team";
import type { Preferences } from "../shared/preferences";

const PILL_REFRESH_MS = 500;

export interface PillView {
  label: string;
  icon: string;
  visible: boolean;
  title: string;
}

/** Number the pill leads with, per the speed-basis preference. Rates above
 * the plausibility limit are bookkeeping artifacts, not speed: show nothing
 * rather than a fabricated burst. */
function headlineTokPerSec(store: AgentSpeedStore, prefs: Preferences, now: number): number | null {
  const summary = store.summary(now);
  const plausible = (rate: number | null): number | null =>
    rate !== null && rate > prefs.maxPlausibleTokPerSec ? null : rate;
  if (store.isRunning() && prefs.numerator === "live") {
    const live = store.liveTokPerSec(prefs.liveWindowSec, prefs.maxPlausibleTokPerSec);
    if (live !== null) return live;
  }
  if (prefs.numerator === "turn")
    return plausible(summary.tokPerSecTurn ?? summary.tokPerSecDecode);
  return plausible(summary.tokPerSecDecode ?? summary.tokPerSecTurn);
}

export function computePillView(
  store: AgentSpeedStore,
  prefs: Preferences,
  now: number,
  team?: TeamView | null,
): PillView {
  const state = store.state;
  const phase = state.phase;
  if (phase === "idle") {
    return {
      label: "\u2014 tok/s",
      icon: "Gauge",
      visible: prefs.showIdlePills,
      title: "Turn speed",
    };
  }
  const summary = store.summary(now);
  const rate = headlineTokPerSec(store, prefs, now);
  const isApprox = summary.approx;
  const rateText = rate === null ? "\u2014" : `${approx(fmtRate(rate), isApprox)} tok/s`;
  const running = phase === "running";
  const waiting = summary.waiting;
  const teamRunning = team && phase === "running" && team.running > 0 ? team : null;
  // The composer track is narrow: the pill carries the decode rate only, and
  // the turn state (live vs waiting) is shown solely by the leading icon.
  // Tokens, prefill and wait time live in the popover; the full picture goes
  // into the accessible title.
  const labelParts: string[] = [rateText];
  if (teamRunning) labelParts.push(`\u00b7 ${teamRunning.running} sub`);
  if (phase === "failed") labelParts.push("\u00b7 failed");
  if (phase === "canceled") labelParts.push("\u00b7 canceled");
  const titleParts = [`Turn speed ${rateText} decode`];
  if (waiting) titleParts.push("waiting");
  if (teamRunning) {
    // Keep the sheet title on one phone line: the short `N sub` form matches
    // the pill label; the full breakdown is in the popover body.
    const teamLabel = `${teamRunning.running} sub`;
    titleParts.push(
      teamRunning.liveTokPerSec === null
        ? teamLabel
        : `${teamLabel} @ ${approx(fmtRate(teamRunning.liveTokPerSec), teamRunning.approx)} tok/s`,
    );
  }
  if (summary.estTokens > 0) {
    titleParts.push(`${approx(fmtTokens(summary.estTokens, prefs.tokenFormat), isApprox)} tok`);
  }
  if (summary.prefillMs !== null) titleParts.push(`TTFT ${fmtDuration(summary.prefillMs)}`);
  return {
    label: labelParts.join(" "),
    icon: waiting ? "Pause" : running ? "Zap" : "Activity",
    visible: true,
    title: titleParts.join(" \u00b7 "),
  };
}

export interface PillRegistrationHandle {
  destroy(): void;
}

/**
 * Registers a composer pill for one agent and keeps its label fresh: redraws
 * on store changes (throttled) and on a slow timer so the live number keeps
 * moving between events.
 */
export function bindPill(
  register: (button: PluginButton) => PluginButtonRegistration,
  buttonBase: Omit<PluginButton, "label" | "icon" | "visible" | "title">,
  store: AgentSpeedStore,
  getPrefs: () => Preferences,
  now: () => number,
  getTeam?: () => TeamView | null,
): PillRegistrationHandle {
  const view = (t: number) => computePillView(store, getPrefs(), t, getTeam ? getTeam() : null);
  const first = view(now());
  let registration = register({ ...buttonBase, ...first });
  let lastPaint = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const paint = (force: boolean) => {
    const t = now();
    if (!force && t - lastPaint < PILL_REFRESH_MS) {
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          paint(true);
        }, PILL_REFRESH_MS);
      }
      return;
    }
    lastPaint = t;
    const viewNow = view(t);
    registration.update({
      label: viewNow.label,
      icon: viewNow.icon,
      visible: viewNow.visible,
      title: viewNow.title,
    });
  };

  const unsubscribe = store.subscribe(() => paint(false));
  // A slow heartbeat keeps the live tok/s and elapsed time honest while the
  // agent streams but the reducer has not changed on a given tick.
  const heartbeat = setInterval(() => paint(false), PILL_REFRESH_MS);
  paint(true);

  return {
    destroy() {
      unsubscribe();
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      clearInterval(heartbeat);
      registration.remove();
    },
  };
}
