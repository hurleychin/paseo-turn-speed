import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrate,
  initialMeterState,
  reduceMeter,
  summarizeTurn,
  REASONING_CHARS_PER_TOKEN,
  type MeterState,
} from "./meter";

const CPT = 4;

function startTurn(state: MeterState = initialMeterState(), at = 0): MeterState {
  return reduceMeter(state, { t: "turn_started", at, turnId: "t1" });
}

test("snapshot text growth counts only the new characters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hello" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "Hello world" });
  assert.equal(s.totalChars, 11);
  assert.equal(s.firstTextAt, 1000);
  assert.equal(s.stepFirstTextAt, 1000);
});

test("delta text growth accumulates fragments", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "Hel" });
  s = reduceMeter(s, { t: "text", at: 1200, key: "m1", text: "lo w" });
  s = reduceMeter(s, { t: "text", at: 1400, key: "m1", text: "orld" });
  assert.equal(s.totalChars, 11);
});

test("usage closes a step: window runs from first text to usage arrival", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 100, input: 50 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 100);
  // Includes the tail where tool arguments were still being generated.
  assert.equal(s.steps[0].decodeMs, 2100);
  assert.equal(s.steps[0].prefillMs, 1000);
  assert.equal(s.steps[0].waitMs, 0);
  assert.equal(s.sawUsage, true);
  assert.equal(s.liveChars, 0);
  assert.equal(s.stepFirstTextAt, null);
  assert.deepEqual(s.calibInput, { chars: 800, tokens: 100 });
});

test("multi-step turn: tool runs sit between steps, argument decode stays inside", () => {
  let s = startTurn();
  // Step 1: text 1000..2000, arguments to 2100, usage at 2100.
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m1", text: "a b" });
  s = reduceMeter(s, { t: "usage", at: 2100, usage: { output: 10 } });
  // Tool runs 2100..12100. Step 2 decodes 12100..13200.
  s = reduceMeter(s, { t: "text", at: 12100, key: "m2", text: "c" });
  s = reduceMeter(s, { t: "text", at: 13100, key: "m2", text: "c d" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 25 } });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 15);
  assert.equal(s.steps[1].decodeMs, 1100);
  assert.equal(s.steps[1].waitMs, 10000);
  assert.equal(s.steps[1].prefillMs, 0);

  const sum = summarizeTurn(s, CPT, 14200);
  assert.equal(sum.outTokens, 25);
  assert.equal(sum.decodeMs, 1100 + 1100);
  assert.equal(sum.waitMs, 10000);
  assert.equal(sum.prefillMs, 1000);
  assert.equal(sum.totalMs, 14200);
  assert.equal(sum.tokPerSecDecode, 25 / 2.2);
});

test("cumulative counters grow per step and are never counted twice", () => {
  // OpenCode reports message-cumulative tokens: each event contains the
  // previous ones. The meter must count differences, not the raw values.
  // Rates here are synthetic, so the plausibility guard is switched off.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 6000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 12000 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "text", at: 4000, key: "m3", text: "c" });
  s = reduceMeter(s, { t: "usage", at: 4600, usage: { output: 19000 }, maxTokPerSec: Infinity });
  const sum = summarizeTurn(s, CPT, 4600);
  assert.equal(sum.outTokens, 19000);
  assert.equal(sum.steps, 3);
  assert.equal(s.steps[1].outTokens, 6000);
  assert.equal(s.steps[2].outTokens, 7000);
});

test("a counter reset (new assistant message) counts the fresh value whole", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 18000 }, maxTokPerSec: Infinity });
  // New message: counters restart from a smaller number.
  s = reduceMeter(s, { t: "text", at: 2000, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 2500 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 2);
  assert.equal(s.steps[1].outTokens, 2500);
  assert.equal(s.prevUsageOut, 2500);
  assert.equal(summarizeTurn(s, CPT, 3000).outTokens, 20500);
});

test("turn_started keeps the observed usage baseline, not a racy snapshot", () => {
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 10, usage: { output: 40, input: 900 } });
  assert.equal(s.prevUsageOut, 40);
  s = startTurn(s, 100);
  assert.equal(s.prevUsageOut, 40);
  s = reduceMeter(s, { t: "text", at: 500, key: "m1", text: "hello" });
  s = reduceMeter(s, { t: "usage", at: 1500, usage: { output: 45, input: 950 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 5);
  assert.equal(s.steps[0].inputTokens, 50);
});

test("early usage before turn_started is not lost or double counted", () => {
  // The agent_update carrying step-1 usage can beat the timeline's
  // turn_started event. The observed baseline makes the delta exact either
  // way: step 1's tokens are attributed to the previous turn's tail (idle),
  // and only genuinely new tokens open steps afterwards.
  let s = reduceMeter(initialMeterState(), { t: "usage", at: 100, usage: { output: 6000 } });
  s = startTurn(s, 200);
  s = reduceMeter(s, { t: "text", at: 300, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1300, usage: { output: 12000 }, maxTokPerSec: Infinity });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 6000);
});

test("repeated usage at completion opens no extra step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 30 } });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.phase, "completed");
});

test("zero-token usage does not open a step and never divides by zero", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 0 } });
  assert.equal(s.steps.length, 0);
  const sum = summarizeTurn(s, CPT, 600);
  assert.equal(sum.tokPerSecDecode, null);
});

test("compaction drops the live character window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(100) });
  s = reduceMeter(s, { t: "compaction", at: 200 });
  assert.equal(s.liveChars, 0);
  assert.equal(s.totalChars, 100);
});

test("no usage: numbers are estimated from characters and flagged approx", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 2100, key: "m1", text: "x".repeat(800) });
  s = reduceMeter(s, { t: "turn_ended", at: 2200, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 2200);
  assert.equal(sum.approx, true);
  assert.equal(sum.estTokens, 200);
  // Without any step, the text window stands in for the decode window.
  assert.equal(sum.decodeMs, 2000);
  assert.equal(sum.tokPerSecDecode, 200 / 2);
});

test("turn completion folds a trailing usage payload into the final step", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "turn_ended", at: 1200, kind: "completed", usage: { output: 30 } });
  assert.equal(s.phase, "completed");
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 30);
  assert.equal(s.steps[0].decodeMs, 1100);
  assert.equal(s.endedAt, 1200);
});

test("canceled and failed turns keep accumulated numbers", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 900, usage: { output: 12 } });
  s = reduceMeter(s, { t: "turn_ended", at: 5000, kind: "canceled", note: "user stop" });
  assert.equal(s.phase, "canceled");
  assert.equal(s.endNote, "user stop");
  assert.equal(summarizeTurn(s, CPT, 5000).outTokens, 12);
});

test("end events without a running turn are ignored", () => {
  const s = initialMeterState();
  const next = reduceMeter(s, { t: "turn_ended", at: 10, kind: "completed" });
  assert.equal(next.phase, "idle");
});

test("reset drops the turn but keeps the usage baseline continuous", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "abc" });
  s = reduceMeter(s, { t: "usage", at: 200, usage: { output: 77 }, maxTokPerSec: Infinity });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.phase, "idle");
  assert.equal(s.totalChars, 0);
  assert.equal(s.prevUsageOut, 77);
  s = startTurn(s, 300);
  s = reduceMeter(s, { t: "text", at: 400, key: "m2", text: "def" });
  s = reduceMeter(s, { t: "usage", at: 500, usage: { output: 90 } });
  assert.equal(s.steps[0].outTokens, 13);
});

test("text before turn start is ignored", () => {
  const s = reduceMeter(initialMeterState(), { t: "text", at: 100, key: "m1", text: "abc" });
  assert.equal(s.totalChars, 0);
});

test("reasoning-only steps still measure their decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "reasoning", text: "thinking..." });
  s = reduceMeter(s, { t: "usage", at: 2500, usage: { output: 60 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].decodeMs, 2000);
  assert.equal(s.steps[0].prefillMs, 500);
});

test("user wait is removed from the tool-wait window between steps", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 10 } });
  // Model asks a question, sleeps for 10s, user answers.
  s = reduceMeter(s, { t: "user_wait_started", at: 2100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 12100 });
  s = reduceMeter(s, { t: "text", at: 12200, key: "m2", text: "b" });
  s = reduceMeter(s, { t: "usage", at: 13200, usage: { output: 20 } });
  assert.equal(s.steps.length, 2);
  // Raw gap 2000..12200 is 10200ms; 10000 of it was the user thinking.
  assert.equal(s.steps[1].waitMs, 200);
  const sum = summarizeTurn(s, CPT, 13200);
  assert.equal(sum.waitMs, 200);
  assert.equal(sum.userWaitMs, 10000);
  assert.equal(sum.waiting, false);
});

test("a user wait inside a step is removed from its decode window", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "user_wait_started", at: 1500 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 5500 });
  s = reduceMeter(s, { t: "usage", at: 6000, usage: { output: 30 } });
  assert.equal(s.steps.length, 1);
  // Raw window 1000..6000 = 5000ms, minus the 4000ms asleep.
  assert.equal(s.steps[0].decodeMs, 1000);
});

test("an open user wait counts live and closes when the turn ends", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "user_wait_started", at: 2000 });
  const live = summarizeTurn(s, CPT, 7000);
  assert.equal(live.waiting, true);
  assert.equal(live.userWaitMs, 5000);
  // 7000ms wall, 5000 of it asleep -> whole-turn rate uses 2000ms.
  assert.equal(live.tokPerSecTurn, 100 / 2);
  s = reduceMeter(s, { t: "turn_ended", at: 8000, kind: "completed" });
  assert.equal(s.pausedAt, null);
  assert.equal(s.userWaits.length, 1);
  const done = summarizeTurn(s, CPT, 9000);
  assert.equal(done.userWaitMs, 6000);
  assert.equal(done.totalMs, 8000);
  assert.equal(done.tokPerSecTurn, 100 / 2);
});

test("user wait actions outside a live wait are no-ops", () => {
  const idle = reduceMeter(initialMeterState(), { t: "user_wait_started", at: 10 });
  assert.equal(idle.pausedAt, null);
  const running = startTurn();
  const ended = reduceMeter(running, { t: "user_wait_ended", at: 10 });
  assert.equal(ended, running);
});

test("turn_started and reset clear user waits", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "user_wait_started", at: 100 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 600 });
  s = startTurn(s, 700);
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
  s = reduceMeter(s, { t: "user_wait_started", at: 800 });
  s = reduceMeter(s, { t: "reset" });
  assert.equal(s.userWaits.length, 0);
  assert.equal(s.pausedAt, null);
});

test("a step faster than physically plausible is absorbed into the baseline", () => {
  // The interrupted-message scenario: its late step-finish lands mid new
  // turn and claims 1200 tokens in a 1600ms window (750 tok/s > 400).
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(230) });
  s = reduceMeter(s, { t: "usage", at: 2600, usage: { output: 1200 } });
  assert.equal(s.steps.length, 0);
  assert.deepEqual(s.stepRejected, { tokens: 1200, windowMs: 1600 });
  assert.equal(s.prevUsageOut, 1200);
  // The real step continues: window and characters were not reset.
  assert.equal(s.liveChars, 230);
  assert.equal(s.stepFirstTextAt, 1000);
  s = reduceMeter(s, { t: "text", at: 3400, key: "m1", text: "x".repeat(300) });
  s = reduceMeter(s, { t: "usage", at: 3600, usage: { output: 1260 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].outTokens, 60);
  assert.equal(s.stepRejected, null);
  const sum = summarizeTurn(s, CPT, 3600);
  assert.equal(sum.outTokens, 60);
});

test("text keys survive turn boundaries", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "hello world" });
  assert.equal(s.totalChars, 11);
  // The previous message's final snapshot arrives inside the next turn:
  // only the new characters may count.
  s = startTurn(s, 500);
  s = reduceMeter(s, { t: "text", at: 600, key: "m1", text: "hello world!" });
  assert.equal(s.totalChars, 1);
});

test("calibration blends with EMA 0.7/0.3, clamps, and rejects thin samples", () => {
  const first = calibrate(undefined, 800, 100); // 0.7*3.6 + 0.3*8
  assert.equal(first, 4.92);
  const blended = calibrate(4, 400, 100); // 0.7*4 + 0.3*4 = 4
  assert.equal(blended, 4);
  const clampedLow = calibrate(2, 400, 100); // observed 4 -> stays >= 2
  assert.equal(clampedLow, 0.7 * 2 + 0.3 * 4);
  // Tool-argument-heavy steps stream almost no visible text: too thin.
  assert.equal(calibrate(4, 20, 50), null);
  assert.equal(calibrate(4, 400, 0), null);
  // A 1-char/token sample is tool-call arguments counted in `output`, not
  // this model's text ratio: reject instead of dragging the blend down.
  assert.equal(calibrate(4, 100, 100), null);
  assert.equal(calibrate(4, 160, 100), 0.7 * 4 + 0.3 * 1.6); // observed 1.5+ kept
  // A 40-chars/token sample is bookkeeping noise, not a model ratio: reject
  // instead of letting one step pin the blend at CAL_MAX.
  assert.equal(calibrate(4, 4000, 100), null);
});

test("delegated intervals are removed from the whole-turn rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  // Subagents do the real work for 10s; the parent produces nothing itself.
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 12000 });
  s = reduceMeter(s, { t: "turn_ended", at: 12000, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 12000);
  assert.equal(sum.delegatedMs, 10000);
  assert.equal(sum.delegated, false);
  assert.equal(sum.totalMs, 12000);
  // 100 tokens over 2 productive seconds, not 12 wall seconds.
  assert.equal(sum.tokPerSecTurn, 50);
});

test("overlapping user wait and delegation subtract once from turn time", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "usage", at: 2000, usage: { output: 100 } });
  s = reduceMeter(s, { t: "delegated_started", at: 2000 });
  s = reduceMeter(s, { t: "user_wait_started", at: 3000 });
  s = reduceMeter(s, { t: "user_wait_ended", at: 8000 });
  s = reduceMeter(s, { t: "delegated_ended", at: 12000 });
  s = reduceMeter(s, { t: "turn_ended", at: 12000, kind: "completed" });
  const sum = summarizeTurn(s, CPT, 12000);
  // Union of asleep time is 2000..12000; the nested user wait must not
  // subtract a second time.
  assert.equal(sum.userWaitMs, 5000);
  assert.equal(sum.delegatedMs, 10000);
  assert.equal(sum.tokPerSecTurn, 50);
});

test("open delegation counts while running and closes at turn end", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "x".repeat(400) });
  s = reduceMeter(s, { t: "delegated_started", at: 5000 });
  let sum = summarizeTurn(s, CPT, 8000);
  assert.equal(sum.delegated, true);
  assert.equal(sum.delegatedMs, 3000);
  s = reduceMeter(s, { t: "turn_ended", at: 10000, kind: "completed" });
  assert.equal(s.delegatedAt, null);
  assert.equal(s.delegatedWaits.length, 1);
  sum = summarizeTurn(s, CPT, 10000);
  assert.equal(sum.delegated, false);
  assert.equal(sum.delegatedMs, 5000);
});

test("delegation outside a running turn is a no-op", () => {
  const idle = initialMeterState();
  assert.equal(reduceMeter(idle, { t: "delegated_started", at: 100 }), idle);
  assert.equal(reduceMeter(idle, { t: "delegated_ended", at: 100 }), idle);
  const running = startTurn();
  assert.equal(reduceMeter(running, { t: "delegated_ended", at: 100 }), running);
});

test("a provider that excludes reasoning gets estimated thinking tokens", () => {
  // Heavy thinking streamed as reasoning text, a short answer, then the step
  // usage: 2400 chars cannot come from 47 reported output tokens.
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "reasoning:t1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.steps[0].thinkingChars, 2400);
  const sum = summarizeTurn(s, CPT, 3100);
  // Reasoning characters convert with the reasoning ratio, not the visible
  // text calibration: measured ~3.7 chars per reasoning token.
  assert.equal(sum.thinkingTokens, 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.outTokens, 47);
  assert.equal(sum.estTokens, 47 + 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.approx, true);
  // The rate covers thinking + visible tokens across the full step window.
  assert.equal(sum.tokPerSecDecode, (47 + 2400 / REASONING_CHARS_PER_TOKEN) / 2.6);
});

test("the excluded-reasoning verdict survives turn boundaries like the baseline", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "model_changed", model: "m1" });
  assert.equal(s.thinkingExcludedModel, "m1");
  s = startTurn(s, 5000);
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, "m1");
  const fresh = reduceMeter(s, { t: "reset" });
  assert.equal(fresh.thinkingExcluded, true);
  assert.equal(fresh.thinkingExcludedModel, "m1");
});

test("the verdict belongs to its model: switching models revokes it, inclusive output is not double counted", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "excluder" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 3000, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 3100, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, "excluder");
  // Switch to a model that reports thinking inside `output`.
  s = reduceMeter(s, { t: "model_changed", model: "includer" });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.steps.length, 1); // the current turn's steps survive
  // Heavy thinking whose reported output already pays for it: no estimate on
  // top (that would count the thinking twice), and no false re-arm.
  s = reduceMeter(s, { t: "text", at: 3300, key: "r2", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5200, usage: { output: 695 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.steps.length, 2);
  const sum = summarizeTurn(s, CPT, 5300);
  assert.equal(sum.thinkingTokens, 0);
  assert.equal(sum.estTokens, 695);
  // Switching back starts unjudged; the verdict only comes back with evidence.
  s = reduceMeter(s, { t: "model_changed", model: "excluder" });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(s.thinkingExcludedModel, "excluder");
});

test("an unknown model never clears the verdict, and a verdict predating identity adopts the first model", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, null);
  assert.equal(reduceMeter(s, { t: "model_changed", model: null }), s);
  const adopted = reduceMeter(s, { t: "model_changed", model: "m1" });
  assert.equal(adopted.thinkingExcluded, true); // adopted, not revoked
  assert.equal(adopted.thinkingExcludedModel, "m1");
  assert.equal(reduceMeter(adopted, { t: "model_changed", model: "m2" }).thinkingExcluded, false);
});

test("three consecutive inclusive steps revoke the verdict and excluding evidence re-arms it", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "m" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 700, key: "m1", text: "a".repeat(30) });
  s = reduceMeter(s, { t: "usage", at: 800, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  // The provider config now includes thinking: reported output covers the
  // streamed reasoning characters.
  s = reduceMeter(s, { t: "text", at: 900, key: "r2", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 1900, usage: { output: 197 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 2000, key: "r3", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 347 } });
  assert.equal(s.thinkingExcluded, true);
  // A thin step (too few reasoning chars for either verdict) breaks the
  // streak: the count must start over.
  s = reduceMeter(s, { t: "text", at: 3100, key: "r4", text: "y".repeat(100), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3500, usage: { output: 367 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 3600, key: "r5", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 4600, usage: { output: 517 } });
  s = reduceMeter(s, { t: "text", at: 4700, key: "r6", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5700, usage: { output: 667 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 5800, key: "r7", text: "y".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 6800, usage: { output: 817 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(summarizeTurn(s, CPT, 6900).thinkingTokens, 0);
  // Excluding evidence lands: the verdict is back on the next step.
  s = reduceMeter(s, { t: "text", at: 6900, key: "r8", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 7800, usage: { output: 867 } });
  assert.equal(s.thinkingExcluded, true);
});

test("ordinary reasoning density revokes the verdict; the neutral band concludes nothing", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "model_changed", model: "m" });
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 1600, usage: { output: 47 } });
  assert.equal(s.thinkingExcluded, true);
  // A step at 6 chars per output token sits in the neutral band
  // (inclusion ratio ~5.2, exclusion ratio 8): verdict stays, streak resets.
  s = reduceMeter(s, { t: "text", at: 2000, key: "r2", text: "y".repeat(1200), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 3000, usage: { output: 247 } });
  assert.equal(s.thinkingExcluded, true);
  // Typical reasoning prose (~3.7 chars/token) now satisfies inclusion; the
  // neutral step above must not have counted, so three full steps are needed.
  s = reduceMeter(s, { t: "text", at: 3100, key: "r3", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 4100, usage: { output: 447 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 4200, key: "r4", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5200, usage: { output: 647 } });
  assert.equal(s.thinkingExcluded, true);
  s = reduceMeter(s, { t: "text", at: 5300, key: "r5", text: "y".repeat(740), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 6300, usage: { output: 847 } });
  assert.equal(s.thinkingExcluded, false);
});

test("a verdict without a model owner is re-derived on the next turn", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.thinkingExcludedModel, null);
  // Identity never resolved: the verdict cannot be permanent across turns.
  s = startTurn(s, 5000);
  assert.equal(s.thinkingExcluded, false);
  // Fresh evidence in the new turn brings it right back.
  s = reduceMeter(s, { t: "text", at: 5500, key: "r2", text: "y".repeat(600), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 5600, usage: { output: 20 } });
  assert.equal(s.thinkingExcluded, true);
});

test("moderate reasoning leaves the provider unjudged and adds no estimate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(150), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 600, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, false);
  assert.equal(summarizeTurn(s, CPT, 600).thinkingTokens, 0);
});

test("late bulk reasoning counts in totals but not in the decode rate", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a".repeat(40) });
  // The finished reasoning block is delivered in one burst, after the answer
  // was already streaming: its generation time is outside the window.
  s = reduceMeter(s, { t: "text", at: 2000, key: "reasoning:t1", text: "t".repeat(2400), kind: "reasoning" });
  s = reduceMeter(s, { t: "usage", at: 2100, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  assert.equal(s.steps[0].thinkingLateChars, 2400);
  const sum = summarizeTurn(s, CPT, 2100);
  assert.equal(sum.thinkingTokens, 2400 / REASONING_CHARS_PER_TOKEN);
  assert.equal(sum.estTokens, 10 + 2400 / REASONING_CHARS_PER_TOKEN);
  // Decode sees 10 visible tokens in 1100ms; the windowless thinking cannot
  // inflate it, while the whole-turn rate does count it.
  assert.equal(sum.tokPerSecDecode, 10 / 1.1);
  assert.equal(sum.tokPerSecTurn, (10 + 2400 / REASONING_CHARS_PER_TOKEN) / 2.1);
});

test("no-usage estimation ignores bulk reasoning characters", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a".repeat(400) });
  s = reduceMeter(s, { t: "text", at: 150, key: "r1", text: "t".repeat(1600), kind: "reasoning" });
  s = reduceMeter(s, { t: "turn_ended", at: 2000, kind: "completed" });
  // The reasoning burst arrived after the visible text had started, so its
  // characters cannot stand in for streamed live tokens.
  assert.equal(summarizeTurn(s, CPT, 2000).estTokens, 100);
});

test("a rejected usage burst is kept as unattributed in the turn totals", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 100, key: "m1", text: "a" });
  s = reduceMeter(s, { t: "usage", at: 1100, usage: { output: 30 } });
  // Aggregated usage arriving 20ms after the previous snapshot: 1200 tokens
  // in a physically impossible window.
  s = reduceMeter(s, { t: "usage", at: 1120, usage: { output: 1230 } });
  assert.equal(s.steps.length, 1);
  assert.equal(s.unattributedTokens, 1200);
  const sum = summarizeTurn(s, CPT, 1120);
  assert.equal(sum.outTokens, 30);
  assert.equal(sum.unattributedTokens, 1200);
  assert.equal(sum.estTokens, 1230);
  // The decode-window rate ignores the windowless burst; the whole-turn rate
  // counts it.
  assert.equal(sum.tokPerSecDecode, 30 / 1);
  assert.equal(sum.tokPerSecTurn, 1230 / 1.12);
});

test("an open step's running window counts in the decode rate", () => {
  let s = startTurn();
  // Closed step: 10 reported tokens over a 100ms window.
  s = reduceMeter(s, { t: "text", at: 1000, key: "m1", text: "a".repeat(40) });
  s = reduceMeter(s, { t: "usage", at: 1100, usage: { output: 10 } });
  // Current step: a long early reasoning stream, still open 40s later. Its
  // estimated tokens sit in the totals, so its running window must sit in
  // the decode denominator — dividing them by the closed 100ms window alone
  // used to print a >10k tok/s burst on the pill.
  s = reduceMeter(s, { t: "text", at: 2000, key: "r1", text: "t".repeat(4000), kind: "reasoning" });
  const sum = summarizeTurn(s, CPT, 42000);
  assert.equal(sum.decodeMs, 40100);
  assert.equal(sum.tokPerSecDecode, (10 + 4000 / REASONING_CHARS_PER_TOKEN) / 40.1);
});

test("calibration pairs only visible characters with output tokens", () => {
  let s = startTurn();
  s = reduceMeter(s, { t: "text", at: 500, key: "r1", text: "y".repeat(400), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 5600, key: "m1", text: "v".repeat(800) });
  s = reduceMeter(s, { t: "usage", at: 5700, usage: { output: 200 } });
  assert.deepEqual(s.calibInput, { chars: 800, tokens: 200 });
});

test("reasoning and visible characters are estimated with their own ratios", () => {
  let s = startTurn();
  // Closed step: 370 reasoning chars (early) + 10 reported output tokens.
  s = reduceMeter(s, { t: "text", at: 100, key: "r1", text: "t".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 200, key: "m1", text: "a".repeat(40) });
  s = reduceMeter(s, { t: "usage", at: 300, usage: { output: 10 } });
  assert.equal(s.thinkingExcluded, true);
  // Open step: reasoning leads again, then visible text streams.
  s = reduceMeter(s, { t: "text", at: 400, key: "r2", text: "t".repeat(370), kind: "reasoning" });
  s = reduceMeter(s, { t: "text", at: 500, key: "m2", text: "a".repeat(40) });
  const sum = summarizeTurn(s, CPT, 600);
  const closedThinking = 370 / REASONING_CHARS_PER_TOKEN;
  const liveThinking = 370 / REASONING_CHARS_PER_TOKEN;
  const liveVisible = 40 / CPT;
  assert.equal(sum.thinkingTokens, closedThinking + liveThinking);
  assert.equal(sum.estTokens, 10 + closedThinking + liveVisible + liveThinking);
});
