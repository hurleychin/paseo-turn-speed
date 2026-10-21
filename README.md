# turn-speed — live token-rate meter for Paseo agents

A composer pill per agent that shows how fast the model is actually decoding:
`⚡ 138 tok/s` while a turn runs, `⏸ 43 tok/s` while it waits for your answer,
`12.4 tok/s · 2 sub` while subagents do the heavy lifting, and the final rate
once the turn ends — with a popover breakdown (prefill/TTFT, in/out tokens,
prompt cache hit rate, steps, tool wait, user wait, per-subagent rates,
context occupancy). Numbers measured from real provider usage are exact; before
the first usage event they are character estimates marked with `≈`. For
reasoning models whose provider subtracts thinking from the reported output
(measured on OpenCode + local models via oMLX), the thinking tokens are
estimated from the streamed reasoning text and shown as a separate
`thinking ≈` line, so rates cover all generated tokens instead of only the
visible answer.

## Install

```bash
paseo plugin add github:Drenalol/paseo-turn-speed
# or, from npm:
paseo plugin add npm:paseo-turn-speed
```

Then open Settings → Plugins → Turn speed to tune it. See
[Requirements](#requirements) for the one provider setting that makes the
numbers exact.

## Screenshots

Desktop — the composer pill while a turn decodes, and the paused variant
(the model is waiting for your answer):

<img src="images/desktop-pill-live.png" alt="Live pill: 74.4 tok/s" width="200"> <img src="images/desktop-pill-waiting.png" alt="Waiting pill: 43.6 tok/s" width="200">

The popover behind the pill — decode and whole-turn rates, prefill/TTFT,
token totals, steps, tool wait and context occupancy:

<img src="images/desktop-popover.png" alt="Turn breakdown popover" width="420">

The same popover on mobile, with the `pill shows` basis chips:

<img src="images/mobile-popover.png" alt="Mobile popover" width="300">

## Requirements

- Paseo **0.11.0+** (daemon and app).
- Node.js with npm on the daemon host (for the one-time `npm install` here; Paseo itself
  needs no npm to run the plugin).

## Make it work

```bash
cd /path/to/paseo-turn-speed
npm install                  # dev dependencies for typechecking only
npm run typecheck
paseo plugin install "$(pwd)"
paseo plugin reload turn-speed   # after every source edit
paseo plugin logs turn-speed
```

Then open the Paseo app: every agent with a workspace gets a pill in the composer
track (next to Tasks/Subagents). Settings → Plugins → Turn speed holds the options.

### The one setting that decides accuracy: `includeUsage`

The plugin reads real token counts from the `usage` the provider reports. For
OpenCode-backed models (including local MLX servers) the provider only forwards
usage when it is enabled in the OpenCode config, e.g. in `opencode.json`:

```json
{
  "provider": {
    "mlx": {
      "options": { "includeUsage": true }
    }
  }
}
```

Without it the plugin still works: every number is estimated from streamed
characters (`≈`) and the popover shows a hint about this setting.

Also useful: a `limit.context` value for the model (the model catalog or the
provider config) — it feeds the `context 34k / 131k` line in the popover.

## How the numbers are computed

- **TTFT / prefill** — from turn start to the first streamed character. Reported
  separately, never mixed into tok/s.
- **decode tok/s** — output tokens from usage deltas divided by decode windows
  only. Tool waits, thinking pauses longer than 2 s, and the prefill of the next
  model call are excluded. This is why the pill shows ~139 tok/s on short
  answers instead of 6.
- **Whole-turn tok/s** — optional alternative basis in settings; it includes
  tool time and is always lower. Time spent waiting for you and time delegated
  to subagents are excluded.
- **Waiting for you** — when the model asks a question or waits for a permission
  or plan approval it is asleep until you answer. Those intervals are taken from
  the provider's permission/question requests (and restored from agent snapshots
  after reloads and reconnects), and are removed from decode windows, tool-wait
  time and the whole-turn rate. `turn time` stays wall-clock; the popover shows a
  separate `waiting for you` row and the pill switches to a ⏸ icon meanwhile.
- **Delegation to subagents** — while the agent's work runs in subagents, the
  parent's own model produces nothing, so that stretch is removed from its
  whole-turn rate like a user wait. A subagent's reply reaching the parent is
  a tool result: it lands in the parent's *input* tokens (`in`/`cached`),
  never in its output. Delegation is detected from the parent's timeline
  (`sub_agent` tool details where the provider reports them, and the
  normalized `subagent` tool calls Paseo emits for provider subagents such as
  OpenCode's Task) and from linked Paseo child agents. The parent's pill grows
  a `· N sub` badge and its accessible title carries the team rate. For
  linked Paseo children the popover also lists each subagent with its own
  live rate and tokens plus a `team` total; for provider subagents only the
  running count and delegated time are knowable (see Known limitations).
  Each linked subagent still gets its own pill in its own composer.
- **Prompt cache hit rate** — `cacheRead / (newInput + cacheWrite + cacheRead)`
  per model call, summed over the turn. The numerator is the prompt the model
  did not have to recompute; the denominator is the whole prompt, so cache
  writes count against the rate — they are tokens the model had to process even
  though they missed the cache. Shown in the popover, and in the pill label
  when enabled in settings.

  Providers report cache reads in two shapes: OpenAI-compatible ones fold them
  into the prompt counter, Anthropic-style ones report cache reads on top of it.
  The plugin infers the shape per call (a cache read larger than the prompt can
  only mean separate counters) and Settings → Turn speed → Prompt cache can pin
  it explicitly.

  Paseo's `AgentUsage` exposes only `inputTokens` and `cachedInputTokens`, with
  no cache-write counter, so the `cacheWrite` term is always `0` today and the
  formula collapses to `cacheRead / (newInput + cacheRead)`. For an
  Anthropic-backed model whose TTL cache is being rebuilt mid-turn the reported
  rate will therefore read high by the size of the rebuild. The term is already
  plumbed through (`UsageSnapshot.cacheWrite` → `StepRecord.cacheWriteTokens`),
  so a protocol field is a one-line change to the client's usage mapper.
- **Live number inside a model call** — real tokens only arrive at the end of a
  call, so the live value estimates tokens from characters over a 1/2/5 s
  smoothing window and is marked `≈` until the call's usage lands.
- **Implausible rates are dropped** — a step implying a decode faster than the
  configured limit (default 400 tok/s) cannot have happened on your hardware;
  it is almost always the previous (interrupted) message's usage arriving late.
  Such deltas are absorbed into the baseline instead of inflating the rate, and
  a note lands in the app log (`turn-speed: step dropped as implausible`).
- **Auto-calibration** — at every step end the observed `chars/token` ratio for
  the model is blended into a stored per-model calibration (EMA 0.7/0.3, clamped
  to 2..8, persisted in plugin settings). Samples dominated by tool-call arguments
  (far fewer visible chars than the step's output tokens) are rejected, so tool
  runs do not drag the ratio down. After 2–3 steps the live estimate tracks the
  real one closely. Settings → Turn speed shows and can override it.
- **Thinking estimate has its own ratio** — reasoning prose encodes ~3.7
  characters per token (measured against per-step reasoning-token ground truth),
  so `thinking ≈` divides streamed reasoning characters by that instead of the
  visible-text calibration.
- **The exclusion verdict belongs to its model** — detecting that a provider
  subtracts thinking from `output` is a property of the model behind the agent.
  Switching models revokes the verdict immediately; a provider config change
  under the same model (thinking suddenly inside `output`) is caught after
  three consecutive contradicting steps, and heavy-thinking evidence re-arms it
  the next step. When the agent's model identity is never reported, the verdict
  is never permanent: each new turn re-derives it from fresh evidence.

  Caveats: providers that never send usage cannot be judged at all (there is
  nothing to compare the reasoning text against), and for them a reasoning
  block delivered in one bulk after the answer text started is deliberately
  left out of the character estimate — a bulk tells when it arrived, not how
  long it took to generate. Such turns can be undercounted.

## Settings (Settings → Plugins → Turn speed)

| Option | Default | Effect |
| --- | --- | --- |
| Show pills for idle agents | off | otherwise pills appear only around observed turns |
| Speed basis | Live decode | what the pill shows: live estimate, decode-window average, or whole-turn rate |
| Token format | 1.2k | compact or grouped digits |
| Cache hit rate in the pill | off | append `· 86% cached` to the pill; the popover always shows the row |
| Cache read accounting | Auto | whether the provider reports cache reads inside or on top of the prompt counter |
| Live smoothing window | 2 s | averaging window of the live tok/s |
| Manual chars per token | off (auto-calibrated) | override the live character estimate |
| Implausible rate limit | 400 tok/s | steps implying a faster decode are dropped as misattributed usage; no pill ever shows a rate above the limit |

## Development

```bash
npm run verify      # typecheck + unit tests + client-bundle check
paseo plugin reload turn-speed
paseo plugin ls     # status of every installed plugin
```

Releasing a new version (npm + registry flow, with the gotchas): see
[RELEASE.md](RELEASE.md).

`npm run check:client` compiles the client entry with the same options Paseo's
compiler uses and rejects output the mobile app's JS engine (Hermes) cannot
parse — notably anonymous class expressions, which is exactly what a `class`
becomes after bundling. Client code therefore uses closure factories instead of
classes. With a `hermes` binary available, `HERMES_BIN=/path/to/hermes npm run
check:client` runs the real Hermes syntax check too.

## Known limitations

- Providers that subtract thinking from the reported `output` (OpenCode + local
  reasoning models) get thinking tokens only as an estimate (`thinking ≈`):
  real per-step reasoning counts never reach the plugin API. Upstream request
  — your upvote helps:
  [getpaseo/paseo#7863](https://github.com/getpaseo/paseo/discussions/7863).
- Usage arrives via agent snapshots, so step boundaries are as fine as the
  provider's per-call usage updates. Providers without usage at all stay `≈`.
- The plugin only counts what it watches live: after a reload or a reconnect the
  interrupted turn is not reconstructed (final `lastUsage` still gives totals).
- Subagent turns get their own pills; the parent's numbers stay its own and
  subagent *tokens* are never added to them — delegation time is excluded and
  team rates are shown alongside, not merged. Paseo-native (delegated) agents
  are linked through their `paseo.parent-agent-id` label, so they get the full
  per-child breakdown. Provider subagents (e.g. OpenCode Task calls) do not
  appear as Paseo agents and their token stream is not reachable from the
  plugin API, so for them the badge, the `delegated` time and the rate
  correction work, but the per-child token breakdown stays empty
  (verified on Paseo 0.12 + OpenCode).
- The cache hit rate is only as good as the provider's cache counters: without
  `cachedInputTokens` the popover hides the row, and providers that report a
  `cached` counter with a different meaning (some sum cache writes into it)
  will read higher than the true hit rate.
- Cache **writes** are not reported by Paseo's usage payload at all, so a turn
  that rebuilds an Anthropic TTL cache reads as a higher hit rate than it
  really was: the denominator is missing those tokens. See
  [Prompt cache hit rate](#how-the-numbers-are-computed) for the exact formula
  and the plumbing already in place for when the protocol gains the field.
- Usage that arrives late from a previous turn (typically after an interrupted
  message) is dropped by the plausibility guard, so that turn's token totals can
  be slightly low; rates stay honest.
- Every closed and dropped step is logged to the app log
  (`~/Library/Logs/Paseo/main.log`, prefix `turn-speed:`) if you want to audit
  where a number came from.
