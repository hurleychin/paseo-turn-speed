import type { PluginClientContext } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { createAgentSpeedStore, type AgentSpeedStore } from "./client/store";
import { bindPill } from "./client/pill";
import { makeSpeedDetails } from "./client/details";
import { parentAgentIdOf } from "./client/links";
import { summarizeTeam, type TeamMemberInput } from "./client/team";
import { makeSettingsScreen } from "./client/settings";
import {
  DEFAULT_METER_STATE,
  DEFAULT_PREFERENCES,
  meterState,
  preferences,
  type MeterStateDoc,
  type Preferences,
} from "./shared/preferences";
import { DEFAULT_CHARS_PER_TOKEN, CAL_MAX } from "./client/meter";

// Structural type derivation keeps `@getpaseo/client` out of the client
// bundle: only types provided through the plugin context are used.
type AgentsApi = PluginClientContext["paseo"]["agents"];type AgentHandle = ReturnType<AgentsApi["ref"]>;
type TimelineEvent = Parameters<Parameters<AgentHandle["timeline"]["subscribe"]>[0]>[0];
type StreamEvent = TimelineEvent["event"];
type AgentUpdate = Parameters<Parameters<AgentHandle["subscribe"]>[0]>[0];
type AgentSnapshot = Extract<AgentUpdate, { kind: "upsert" }>["agent"];
type AgentListResult = Awaited<ReturnType<AgentsApi["list"]>>;
type AgentEntry = AgentListResult["entries"][number];

interface Attachment {
  store: AgentSpeedStore;
  detach(): void;
}

/** Paseo normalizes subagent-spawning tool calls to the name "subagent";
 * providers that map them richly use the `sub_agent` detail type instead.
 * (Measured on Paseo 0.12 + OpenCode: name="subagent", detail.type="unknown".) */
const SUB_AGENT_TOOL_NAME = /^sub[-_. ]?agent$/i;

function isSubAgentCall(item: { name: string; detail: { type?: string } }): boolean {
  return item.detail.type === "sub_agent" || SUB_AGENT_TOOL_NAME.test(item.name);
}

const CAL_FLUSH_MS = 2000;

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const attached = new Map<string, Attachment>();
  const calibration = new Map<string, number>();
  const pendingCalibration = new Map<string, number>();
  // Subagent topology, fed by the agent-list subscription: the latest
  // snapshot per agent, which agent is whose child, which provider session
  // id belongs to which agent, and each attachment's team-change callback.
  const snapshots = new Map<string, AgentSnapshot>();
  const childParents = new Map<string, string>();
  const sessionOwners = new Map<string, string>();
  const teamWatchers = new Map<string, Set<() => void>>();
  let prefs: Preferences = DEFAULT_PREFERENCES;
  let calFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let listSubscription: { release(): Promise<void> } | null = null;

  const aborted = () => lifetime.signal.aborted;
  const logError = (...args: unknown[]) => {
    if (!aborted()) console.error("turn-speed:", ...args);
  };

  const notifyTeam = (parentId: string): void => {
    for (const listener of teamWatchers.get(parentId) ?? []) {
      try {
        listener();
      } catch (error) {
        logError(`team update failed for ${parentId}`, error);
      }
    }
  };

  const linkChild = (childId: string, parentId: string): void => {
    if (childId === parentId) return;
    const current = childParents.get(childId);
    if (current === parentId) return;
    childParents.set(childId, parentId);
    console.log(`turn-speed: linked child ${childId.slice(0, 8)} -> parent ${parentId.slice(0, 8)}`);
    notifyTeam(parentId);
    if (current) notifyTeam(current);
  };

  /** Fold a fresh agent snapshot into the topology maps. */
  const remember = (agent: AgentSnapshot): void => {
    const previous = snapshots.get(agent.id);
    snapshots.set(agent.id, agent);
    const sessionId = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
    if (sessionId) sessionOwners.set(sessionId, agent.id);
    const parent = parentAgentIdOf(agent);
    if (parent) linkChild(agent.id, parent);
    // A child starting or finishing its turn changes the parent's team even
    // when the link itself did not change. Deferred one microtask so the
    // calling handler finishes seeding the child's own store first.
    if (
      parent &&
      previous &&
      (previous.status !== agent.status || previous.archivedAt !== agent.archivedAt)
    ) {
      queueMicrotask(() => notifyTeam(parent));
    }
  };

  /** Live attached children of `parentId`, for the team view. */
  const teamMembers = (parentId: string): TeamMemberInput[] => {
    const members: TeamMemberInput[] = [];
    for (const [childId, pid] of childParents) {
      if (pid !== parentId) continue;
      const attachment = attached.get(childId);
      const snapshot = snapshots.get(childId);
      if (!attachment || !snapshot) continue;
      if (snapshot.archivedAt || snapshot.status === "closed") continue;
      members.push({
        id: childId,
        title: snapshot.title ?? null,
        model: snapshot.model ?? null,
        store: attachment.store,
      });
    }
    return members;
  };

  const effectiveCpt = (model: string | null): number => {
    if (prefs.manualCharsPerToken !== null) return prefs.manualCharsPerToken;
    if (model) {
      const learned = calibration.get(model);
      if (learned !== undefined) return learned;
    }
    return DEFAULT_CHARS_PER_TOKEN;
  };

  const refreshPrefs = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(preferences.id).read, {});
      if (read.status === "ready") {
        const parsed = preferences.schema.safeParse(read.values);
        if (parsed.success) prefs = parsed.data;
      }
    } catch (error) {
      logError("reading preferences failed", error);
    }
  };

  const refreshCalibration = async (): Promise<void> => {
    try {
      const read = await client.rpc(settingsRpc(meterState.id).read, {});
      if (read.status === "ready") {
        const parsed = meterState.schema.safeParse(read.values);
        if (parsed.success) {
          calibration.clear();
          const saturated: string[] = [];
          for (const [model, cpt] of Object.entries(parsed.data.calibration)) {
            // Entries pinned at CAL_MAX were produced by the pre-1.2 bug
            // that charged reasoning characters against reasoning-free
            // output tokens: drop them and let them relearn cleanly.
            if (cpt >= CAL_MAX) saturated.push(model);
            else calibration.set(model, cpt);
          }
          if (saturated.length > 0) {
            void mutateDoc(meterState, (doc) => {
              const next = { ...doc.calibration };
              for (const model of saturated) delete next[model];
              return { calibration: next };
            });
          }
        }
      }
    } catch (error) {
      logError("reading calibration failed", error);
    }
  };

  /** Read-modify-write a settings document; one retry on revision conflict. */
  const mutateDoc = async (
    def: typeof meterState,
    mutate: (values: MeterStateDoc) => MeterStateDoc,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const read = await client.rpc(settingsRpc(def.id).read, {});
        if (read.status !== "ready") return;
        const parsed = def.schema.safeParse(read.values);
        const current = parsed.success ? parsed.data : DEFAULT_METER_STATE;
        const next = mutate(current);
        const write = await client.rpc(settingsRpc(def.id).write, {
          revision: read.revision,
          values: JSON.parse(JSON.stringify(next)),
        });
        if (write.status === "saved") return;
        if (write.status !== "conflict") return;
      } catch (error) {
        logError("settings write failed", error);
        return;
      }
    }
  };

  const flushCalibration = (): void => {
    calFlushTimer = null;
    if (aborted() || pendingCalibration.size === 0) return;
    const batch = Object.fromEntries(pendingCalibration);
    pendingCalibration.clear();
    void mutateDoc(meterState, (doc) => ({
      calibration: { ...doc.calibration, ...batch },
    })).then(refreshPrefs);
  };

  const onCalibration = (model: string, charsPerToken: number): void => {
    calibration.set(model, charsPerToken);
    pendingCalibration.set(model, charsPerToken);
    if (calFlushTimer === null) calFlushTimer = setTimeout(flushCalibration, CAL_FLUSH_MS);
  };

  function mapUsage(usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
  }) {
    return {
      input: usage.inputTokens,
      cached: usage.cachedInputTokens,
      output: usage.outputTokens,
      ctxMax: usage.contextWindowMaxTokens,
      ctxUsed: usage.contextWindowUsedTokens,
    };
  }

  function onStreamEvent(
    store: AgentSpeedStore,
    handle: AgentHandle,
    event: StreamEvent,
    reseed: () => void,
    waits: Set<string>,
    agentId: string,
    subCalls: Set<string>,
    onSubChange: () => void,
  ): void {
    const at = Date.now();
    switch (event.type) {
      case "turn_started": {
        waits.clear();
        subCalls.clear();
        const startedAt = handle.activeTurn?.startedAt;
        const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
        store.dispatch({
          t: "turn_started",
          at: Number.isFinite(parsed) ? parsed : at,
          turnId: event.turnId ?? handle.activeTurn?.turnId ?? null,
        });
        onSubChange();
        break;
      }
      case "turn_completed":
        waits.clear();
        subCalls.clear();
        store.dispatch({
          t: "turn_ended",
          at,
          kind: "completed",
          usage: event.usage ? mapUsage(event.usage) : undefined,
          maxTokPerSec: prefs.maxPlausibleTokPerSec,
        });
        onSubChange();
        void refreshPrefs();
        break;
      case "turn_failed":
        waits.clear();
        subCalls.clear();
        store.dispatch({ t: "turn_ended", at, kind: "failed", note: event.error });
        onSubChange();
        break;
      case "turn_canceled":
        waits.clear();
        subCalls.clear();
        store.dispatch({ t: "turn_ended", at, kind: "canceled", note: event.reason });
        onSubChange();
        break;
      case "permission_requested":
      case "permission_resolved": {
        // Any request (question, tool approval, plan) means the model is
        // asleep until the user answers; pause the meter for the whole set
        // of open requests, not per request.
        if (event.type === "permission_requested") {
          const requestId = event.request?.id;
          if (!requestId) break;
          const wasIdle = waits.size === 0;
          waits.add(requestId);
          if (wasIdle) store.dispatch({ t: "user_wait_started", at });
        } else if (waits.delete(event.requestId) && waits.size === 0) {
          store.dispatch({ t: "user_wait_ended", at });
        }
        break;
      }
      case "timeline": {
        const item = event.item;
        if (item.type === "assistant_message") {
          store.dispatch({ t: "text", at, key: item.messageId ?? "assistant", text: item.text });
        } else if (item.type === "reasoning") {
          // Per-turn key: text tails survive turn boundaries, and each turn's
          // reasoning block starts fresh.
          store.dispatch({
            t: "text",
            at,
            key: `reasoning:${event.turnId ?? "current"}`,
            text: item.text,
            kind: "reasoning",
          });
        } else if (item.type === "compaction") {
          store.dispatch({ t: "compaction", at });
        } else if (item.type === "tool_call" && isSubAgentCall(item)) {
          // A subagent call: running/closed drives the parent's delegation
          // interval, and its child session id (when the provider reports
          // one) links the child agent to this parent for the team view.
          const detail = item.detail;
          console.log(
            `turn-speed: subagent call [${agentId.slice(0, 8)}]` +
              ` ${String(item.callId).slice(0, 8)} ${item.status}`,
          );
          const childId = detail.type === "sub_agent" && detail.childSessionId
            ? sessionOwners.get(detail.childSessionId)
            : undefined;
          if (childId) linkChild(childId, agentId);
          if (item.callId) {
            if (item.status === "running") {
              if (!subCalls.has(item.callId)) {
                subCalls.add(item.callId);
                onSubChange();
              }
            } else if (subCalls.delete(item.callId)) {
              onSubChange();
            }
          }
        }
        break;
      }
      case "replacement":
      case "subscription_restored":
        // Do not replay history we never saw; the live window is local anyway.
        waits.clear();
        subCalls.clear();
        store.dispatch({ t: "reset" });
        onSubChange();
        // Provider counters kept moving while we were blind: re-read them so
        // the next delta is the new work, not the whole unseen gap.
        reseed();
        break;
      case "error":
        logError(`timeline subscription error for ${event.error}`);
        break;
      default:
        break;
    }
  }

  function attach(agent: AgentSnapshot): void {
    if (aborted() || attached.has(agent.id) || !agent.workspaceId) return;
    remember(agent);
    const workspaceId = agent.workspaceId;
    const handle = client.paseo.agents.ref(agent.id);
    const store = createAgentSpeedStore({
      agentId: agent.id,
      charsPerToken: (model) => effectiveCpt(model),
      learnedCharsPerToken: (model) => calibration.get(model),
      onCalibration,
      cacheCounting: () => prefs.cacheCounting,
      now: () => Date.now(),
    });
    store.setIdentity(agent.provider, agent.model ?? null);
    // The daemon folds provider usage into the agent snapshot: every model
    // call bumps `lastUsage` and pushes an agent_update. Track changes there.
    let lastUsageSig: string | null = null;
    const observeUsage = (usage: Parameters<typeof mapUsage>[0] | null): void => {
      if (!usage) return;
      const mapped = mapUsage(usage);
      const sig = [mapped.output, mapped.input, mapped.cached, mapped.ctxUsed, mapped.ctxMax]
        .map((v) => (v === undefined ? "" : String(v)))
        .join("|");
      if (sig === lastUsageSig) return;
      lastUsageSig = sig;
      store.dispatch({
        t: "usage",
        at: Date.now(),
        usage: mapped,
        maxTokPerSec: prefs.maxPlausibleTokPerSec,
      });
    };
    // Seed the cumulative baseline synchronously from the snapshot that
    // triggered the attach, then from the handle when it is populated.
    observeUsage(agent.lastUsage ?? null);
    observeUsage(handle.lastUsage);
    // Open permission/question requests: non-empty means the model is
    // blocked on the user and the meter must not charge that time to it.
    const pendingWaits = new Set<string>();
    const syncWaits = (snapshot: {
      pendingPermissions?: readonly { id: string }[] | null;
    }): void => {
      const pending = snapshot.pendingPermissions;
      if (!pending) return;
      pendingWaits.clear();
      for (const request of pending) pendingWaits.add(request.id);
      store.dispatch({
        t: pendingWaits.size > 0 ? "user_wait_started" : "user_wait_ended",
        at: Date.now(),
      });
    };
    syncWaits(agent);
    // Attaching mid-turn (agent created before the plugin loaded, or a fresh
    // agent whose turn_started raced the subscription): start the meter from
    // the snapshot so the pill exists for the rest of that turn.
    const seedTurn = (snapshot: {
      status?: string | null;
      activeTurn?: { turnId?: string | null; startedAt?: string | null } | null;
    }): void => {
      if (store.state.phase !== "idle" || snapshot.status !== "running" || !snapshot.activeTurn) return;
      const raw = snapshot.activeTurn.startedAt;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      store.dispatch({
        t: "turn_started",
        at: Number.isFinite(parsed) ? parsed : Date.now(),
        turnId: snapshot.activeTurn.turnId ?? null,
      });
    };
    seedTurn(agent);
    // A ref() handle starts empty: without a real snapshot, the first usage
    // event after a reload would count the session-cumulative counters as
    // one giant step. Fetch the truth for that case.
    const reseed = (): void => {
      void handle
        .refresh()
        .then((result) => {
          const snapshot = result?.agent;
          if (!snapshot || attached.get(agent.id)?.store !== store) return;
          store.setIdentity(snapshot.provider, snapshot.model ?? null);
          observeUsage(snapshot.lastUsage ?? null);
          syncWaits(snapshot);
          seedTurn(snapshot);
        })
        .catch((error) => logError(`usage reseed failed for ${agent.id}`, error));
    };
    reseed();

    // Delegation: open sub_agent tool calls (or linked children that are
    // running) mean the agent's own model is idle while subagents work, so
    // the meter parks that time like a user wait. `subCalls` survives
    // snapshot re-delivery of the same running tool item.
    const subCalls = new Set<string>();
    let delegatedNow = false;
    const syncDelegated = (): void => {
      let should = subCalls.size > 0;
      if (!should) {
        for (const member of teamMembers(agent.id)) {
          if (member.store.isRunning()) {
            should = true;
            break;
          }
        }
      }
      if (store.state.phase !== "running") {
        // Outside a turn there is no interval to open or close; drop the
        // flag so the next turn re-evaluates from scratch.
        delegatedNow = false;
        return;
      }
      if (should === delegatedNow) return;
      delegatedNow = should;
      console.log(`turn-speed: delegation ${should ? "on" : "off"} [${agent.id.slice(0, 8)}]`);
      store.dispatch({ t: should ? "delegated_started" : "delegated_ended", at: Date.now() });
    };
    const team = () => {
      const view = summarizeTeam(
        teamMembers(agent.id),
        prefs.liveWindowSec,
        Date.now(),
        prefs.maxPlausibleTokPerSec,
      );
      // Open sub_agent tool calls count too: on provider subagents (no
      // linked Paseo child) they are the only running signal.
      const running = Math.max(view.running, subCalls.size);
      if (view.members.length === 0 && running === 0) return null;
      if (view.members.length === 0) {
        return { members: [], running, liveTokPerSec: null, estTokens: 0, approx: true };
      }
      return { ...view, running };
    };
    const teamWatchersForParent = teamWatchers.get(agent.id) ?? new Set<() => void>();
    teamWatchersForParent.add(syncDelegated);
    teamWatchers.set(agent.id, teamWatchersForParent);

    const details = makeSpeedDetails(
      store,
      () => prefs,
      () => effectiveCpt(store.model),
      () => {
        void refreshPrefs();
      },
      team,
    );
    let pillHandle: { destroy(): void } | null = null;
    try {
      pillHandle = bindPill(
        (button) =>
          client.addComposerPill({ id: "speed", workspaceId, agentId: agent.id, button }),
        {
          behavior: { kind: "popover", Content: details },
        },
        store,
        () => prefs,
        () => Date.now(),
        team,
      );
    } catch (error) {
      logError(`pill registration failed for agent ${agent.id}`, error);
    }

    const releaseAgentUpdates = handle.subscribe((update) => {
      if (update.kind === "remove") {
        detach(agent.id);
        return;
      }
      const snapshot = update.agent;
      remember(snapshot);
      store.setIdentity(snapshot.provider, snapshot.model ?? null);
      observeUsage(snapshot.lastUsage ?? null);
      syncWaits(snapshot);
      seedTurn(snapshot);
      if (snapshot.archivedAt || snapshot.status === "closed") detach(agent.id);
    });

    const timelineSub = handle.timeline.subscribe((event) => {
      try {
        onStreamEvent(store, handle, event.event, reseed, pendingWaits, agent.id, subCalls, syncDelegated);
      } catch (error) {
        logError(`timeline event failed for ${agent.id}`, error);
      }
    });
    void timelineSub.ready.catch((error) => logError(`timeline subscribe failed for ${agent.id}`, error));

    attached.set(agent.id, {
      store,
      detach() {
        storeTeamWatch?.();
        storeTeamWatch = null;
        teamWatchersForParent.delete(syncDelegated);
        pillHandle?.destroy();
        releaseAgentUpdates();
        void timelineSub.release().catch(() => undefined);
      },
    });
    // A child's phase turning running/idle may not coincide with any agent
    // status update, so the parent re-evaluates delegation on every change
    // of this store too. The lookup is dynamic: links learned after attach
    // (e.g. from a sub_agent tool item) are covered as well.
    let storeTeamWatch: (() => void) | null = store.subscribe(() => {
      const parentLink = childParents.get(agent.id);
      if (parentLink) notifyTeam(parentLink);
    });
    // Children may already run (attach raced a reload): pick that up now.
    syncDelegated();
  }

  function detach(agentId: string): void {
    const attachment = attached.get(agentId);
    if (!attachment) return;
    attached.delete(agentId);
    const snapshot = snapshots.get(agentId);
    snapshots.delete(agentId);
    teamWatchers.delete(agentId);
    const parent = childParents.get(agentId);
    childParents.delete(agentId);
    if (parent) notifyTeam(parent);
    const sessionId = snapshot?.runtimeInfo?.sessionId ?? snapshot?.persistence?.sessionId ?? null;
    if (sessionId && sessionOwners.get(sessionId) === agentId) sessionOwners.delete(sessionId);
    try {
      attachment.detach();
    } catch (error) {
      logError(`detach failed for ${agentId}`, error);
    }
  }

  function syncAgents(entries: readonly AgentEntry[]): void {
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.status === "closed") detach(agent.id);
      else {
        remember(agent);
        attach(agent);
      }
    }
  }

  async function boot(): Promise<void> {
    try {
      await Promise.all([refreshPrefs(), refreshCalibration()]);
      if (aborted()) return;
      const list = await client.paseo.agents.list({
        subscribe: {},
        page: { limit: 200 },
        signal: lifetime.signal,
      });
      if (aborted()) {
        void list.subscription.release().catch(() => undefined);
        return;
      }
      listSubscription = list.subscription;
      const releaseObserver = list.subscription.subscribe({
        snapshot: (snapshot) => syncAgents(snapshot.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "remove") {
            detach(payload.agentId);
            return;
          }
          const agent = payload.agent;
          if (agent.archivedAt || agent.status === "closed") detach(agent.id);
          else {
            remember(agent);
            attach(agent);
          }
        },
        error: (error) => logError("agent list subscription failed", error),
      });
      cleanups.push(releaseObserver);
      syncAgents(list.entries);
    } catch (error) {
      if (!aborted()) logError("bootstrap failed", error);
    }
  }

  const cleanups: Array<() => void> = [];
  cleanups.push(
    client.addSettingsScreen({
      id: "preferences",
      title: "Turn speed",
      icon: "Gauge",
      Component: makeSettingsScreen(() => void refreshPrefs()),
    }),
  );

  void boot();

  return () => {
    lifetime.abort();
    if (calFlushTimer !== null) {
      clearTimeout(calFlushTimer);
      calFlushTimer = null;
    }
    for (const agentId of [...attached.keys()]) detach(agentId);
    snapshots.clear();
    childParents.clear();
    sessionOwners.clear();
    teamWatchers.clear();
    if (listSubscription) {
      void listSubscription.release().catch(() => undefined);
      listSubscription = null;
    }
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort teardown.
      }
    }
    cleanups.length = 0;
  };
}
