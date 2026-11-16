import { test } from "node:test";
import assert from "node:assert/strict";
import { TTL_MS, cacheGlyph, isClaude, noteCache, pruneCache, cacheState, cacheLook } from "../cache.js";

const MIN = 60000;
const NOW = 1_800_000_000_000;
// terminals() の 1 件の形。status は素の語、program は app の program 表の key
const claude = (address, status, more = {}) => ({ address, state: "live", status, program: { key: "claude" }, ...more });

test("残りの分から丸を決め、境目ちょうどは次の段に入れる", () => {
  assert.equal(cacheGlyph(60 * MIN), "●");
  assert.equal(cacheGlyph(45 * MIN + 1), "●");
  assert.equal(cacheGlyph(45 * MIN), "◕");
  assert.equal(cacheGlyph(30 * MIN + 1), "◕");
  assert.equal(cacheGlyph(30 * MIN), "◑");
  assert.equal(cacheGlyph(15 * MIN + 1), "◑");
  assert.equal(cacheGlyph(15 * MIN), "◔");
  assert.equal(cacheGlyph(1), "◔");
  assert.equal(cacheGlyph(0), "◯");
  assert.equal(cacheGlyph(-5 * MIN), "◯");
});

test("claude かは program の key か、OSC 7501 で名乗った app で見る", () => {
  assert.equal(isClaude(claude("t1", "idle")), true);
  assert.equal(isClaude({ address: "t2", app: "claude-code", program: { key: "agent" } }), true);
  assert.equal(isClaude({ address: "t3", report: { app: "claude-code" }, program: { key: "program" } }), true);
  assert.equal(isClaude({ address: "t4", program: { key: "shell" } }), false);
  assert.equal(isClaude({ address: "t5", app: "codex", program: { key: "codex" } }), false);
});

test("working の行は ●（要求のたびに延びる）", () => {
  const memo = {};
  const t = claude("t1", "working", { turn: 3, status_ms: NOW - 2 * 3600000 });
  noteCache(memo, t, NOW);
  assert.deepEqual(cacheLook(cacheState(t, memo), NOW), { glyph: "●", tip: "cache: 応答中（要求のたびに延びる）" });
});

test("claude でない行（シェル・見張り）には丸を出さない", () => {
  const memo = {};
  const shell = { address: "t9", state: "live", status: null, turn: 0, program: { key: "shell", name: "bash" } };
  assert.equal(noteCache(memo, shell, NOW), false);
  assert.deepEqual(memo, {});
  assert.equal(cacheLook(cacheState(shell, memo), NOW), null);
});

test("まだ 1 度も要求していない claude（turn が 0）には丸を出さない", () => {
  const memo = {};
  const t = claude("t1", "idle", { turn: 0, status_ms: NOW - MIN });
  noteCache(memo, t, NOW);
  assert.equal(cacheLook(cacheState(t, memo), NOW), null);
});

test("turn が増えたときの status_ms を working を抜けた時刻にし、その 1 時間後を cold とする", () => {
  const memo = {};
  noteCache(memo, claude("t1", "working", { turn: 4, status_ms: NOW - 40 * MIN }), NOW - 40 * MIN);
  const done = claude("t1", "done", { turn: 5, status_ms: NOW - 20 * MIN });
  noteCache(memo, done, NOW - 20 * MIN);
  assert.deepEqual(cacheState(done, memo), { kind: "until", until: NOW - 20 * MIN + TTL_MS, src: "hc" });
  assert.deepEqual(cacheLook(cacheState(done, memo), NOW), { glyph: "◕", tip: "cache 残り 40 分（1h と仮定・hc の時刻）" });
});

test("working を通らない変化（許可待ちのあと断って done）は turn が増えないので、時刻を上書きしない", () => {
  const memo = {};
  noteCache(memo, claude("t1", "blocked", { turn: 7, status_ms: NOW - 50 * MIN }), NOW - 50 * MIN);
  const done = claude("t1", "done", { turn: 7, status_ms: NOW - 10 * MIN });
  noteCache(memo, done, NOW - 10 * MIN);
  assert.equal(cacheState(done, memo).until, NOW - 50 * MIN + TTL_MS);
  assert.equal(cacheLook(cacheState(done, memo), NOW).glyph, "◔");
});

test("mod が初めて見た claude は、その時の status_ms を使う（再起動の後）", () => {
  const memo = {};
  const t = claude("t1", "done", { turn: 12, status_ms: NOW - 61 * MIN });
  noteCache(memo, t, NOW);
  assert.deepEqual(cacheLook(cacheState(t, memo), NOW), { glyph: "◯", tip: "cache cold（1h と仮定・hc の時刻）" });
});

test("status_ms・turn が無いときは、mod が見た working の終わりの時刻を使う", () => {
  const memo = {};
  const idle = claude("t1", "idle");
  noteCache(memo, idle, NOW - 30 * MIN);
  // working の終わりをまだ見ていない: 丸が出ないまま気づかない形にしないよう、? を出す
  assert.equal(cacheLook(cacheState(idle, memo), NOW - 30 * MIN).glyph, "?");
  noteCache(memo, claude("t1", "working"), NOW - 25 * MIN);
  const done = claude("t1", "done");
  noteCache(memo, done, NOW - 20 * MIN);
  assert.deepEqual(cacheState(done, memo), { kind: "until", until: NOW - 20 * MIN + TTL_MS, src: "seen" });
  assert.deepEqual(cacheLook(cacheState(done, memo), NOW), { glyph: "◕", tip: "cache 残り 40 分（1h と仮定・mod が見た時刻）" });
  // done から idle への変化では時刻を動かさない
  noteCache(memo, idle, NOW - 5 * MIN);
  assert.equal(cacheState(idle, memo).until, NOW - 20 * MIN + TTL_MS);
});

test("残りの分は切り上げる（1 分未満でも 0 分とは出さない）", () => {
  assert.equal(cacheLook({ kind: "until", until: NOW + 1000, src: "hc" }, NOW).tip, "cache 残り 1 分（1h と仮定・hc の時刻）");
});

test("変わらなければ memo を書き直さない", () => {
  const memo = {};
  const t = claude("t1", "done", { turn: 2, status_ms: NOW - MIN });
  assert.equal(noteCache(memo, t, NOW), true);
  assert.equal(noteCache(memo, t, NOW + MIN), false);
});

test("一覧から消えて 1 日たった terminal だけを忘れる", () => {
  const memo = {
    gone: { status: "done", turn: 1, at: NOW - 2 * 86400000, src: "hc" },
    recent: { status: "done", turn: 1, at: NOW - 3600000, src: "hc" },
    live: { status: "done", turn: 1, at: NOW - 3 * 86400000, src: "hc" },
  };
  pruneCache(memo, new Set(["live"]), NOW);
  assert.deepEqual(Object.keys(memo).sort(), ["live", "recent"]);
});
