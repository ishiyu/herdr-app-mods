import { test } from "node:test";
import assert from "node:assert/strict";
import { TTL_MS, cacheGlyph, isClaude, noteCache, applyHc, pruneCache, cacheState, cacheLook } from "../cache.js";

const MIN = 60000;
const NOW = 1_800_000_000_000;
// terminals() の 1 件の形。status は素の語、program は app の program 表の key
const claude = (address, status, more = {}) => ({ address, state: "live", status, program: { key: "claude" }, ...more });
// `hc get <t> --json` の形。status は記録（app と state）
const hcGet = (turn, state, status_ms) => ({ turn, status: { app: "claude-code", state }, status_ms });
const look = (t, memo, now) => cacheLook(cacheState(t, memo), now);

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
  const t = claude("t1", "working", { turn: 3 });
  assert.deepEqual(noteCache(memo, t, NOW, new Set()), { changed: true, ask: false });
  assert.deepEqual(look(t, memo, NOW), { glyph: "●", tip: "cache: 応答中（要求のたびに延びる）" });
});

test("claude でない行（シェル・見張り）には丸を出さない", () => {
  const memo = {};
  const shell = { address: "t9", state: "live", status: null, turn: 0, program: { key: "shell", name: "bash" } };
  assert.deepEqual(noteCache(memo, shell, NOW, new Set()), { changed: false, ask: false });
  assert.deepEqual(memo, {});
  assert.equal(look(shell, memo, NOW), null);
});

test("まだ 1 度も要求していない claude（turn が 0）には丸を出さず、hc にも聞かない", () => {
  const memo = {};
  const t = claude("t1", "idle", { turn: 0 });
  assert.equal(noteCache(memo, t, NOW, new Set()).ask, false);
  assert.equal(look(t, memo, NOW), null);
});

test("mod が動いている間に turn が増えたら、見た時刻を working を抜けた時刻にする", () => {
  const memo = {};
  const watched = new Set();
  noteCache(memo, claude("t1", "working", { turn: 4 }), NOW - 41 * MIN, watched);
  const done = claude("t1", "done", { turn: 5 });
  assert.deepEqual(noteCache(memo, done, NOW - 20 * MIN, watched), { changed: true, ask: false });
  assert.deepEqual(cacheState(done, memo), { kind: "until", until: NOW - 20 * MIN + TTL_MS, src: "seen" });
  assert.deepEqual(look(done, memo, NOW), { glyph: "◕", tip: "cache 残り 40 分（1h と仮定・mod が見た時刻）" });
  // 30 秒ごとの描き直しでは動かない
  assert.equal(noteCache(memo, done, NOW, watched).changed, false);
  assert.equal(look(done, memo, NOW + 26 * MIN).glyph, "◔");
});

test("terminals() の status_ms は使わない（app の起動時の値のまま古い）", () => {
  const memo = {};
  const watched = new Set();
  noteCache(memo, claude("t1", "working", { turn: 4, status_ms: NOW - 3 * 3600000 }), NOW - 30 * MIN, watched);
  const done = claude("t1", "done", { turn: 5, status_ms: NOW - 3 * 3600000 });
  noteCache(memo, done, NOW - 10 * MIN, watched);
  assert.equal(cacheState(done, memo).until, NOW - 10 * MIN + TTL_MS);
});

test("working を通らない変化（許可待ちのあと断って done）は turn が増えないので、時刻を動かさない", () => {
  const memo = {};
  const watched = new Set();
  noteCache(memo, claude("t1", "working", { turn: 6 }), NOW - 51 * MIN, watched);
  noteCache(memo, claude("t1", "blocked", { turn: 7 }), NOW - 50 * MIN, watched);
  const done = claude("t1", "done", { turn: 7 });
  assert.equal(noteCache(memo, done, NOW - 10 * MIN, watched).changed, false);
  assert.equal(look(done, memo, NOW).glyph, "◔");
});

test("mod が動く前に抜けていた claude は hc get に聞き、答えるまでは ? を出す", () => {
  const memo = {};
  const watched = new Set();
  const t = claude("t1", "done", { turn: 11, status_ms: null });
  assert.deepEqual(noteCache(memo, t, NOW, watched), { changed: true, ask: true });
  assert.deepEqual(look(t, memo, NOW), { glyph: "?", tip: "cache: 分からない（hc get の答えを待っている）" });
  // 次の描き直しでも ask は立つ（聞き直すかは呼び出し側が turn で決める）が、memo は変えない
  assert.deepEqual(noteCache(memo, t, NOW + 1000, watched), { changed: false, ask: true });
  assert.equal(applyHc(memo, "t1", hcGet(11, "done", NOW - 31 * MIN)), true);
  assert.deepEqual(look(t, memo, NOW), { glyph: "◑", tip: "cache 残り 29 分（1h と仮定・hc get の時刻）" });
  // 答えが入った後は聞かない
  assert.deepEqual(noteCache(memo, t, NOW + 2000, watched), { changed: false, ask: false });
});

test("hc get の答えは、turn が進んでいたか working なら入れない", () => {
  const memo = { t1: { turn: 3, at: null, src: null } };
  assert.equal(applyHc(memo, "t1", hcGet(4, "done", NOW)), false);
  assert.equal(applyHc(memo, "t1", hcGet(3, "working", NOW)), false);
  assert.equal(applyHc(memo, "t1", hcGet(3, "done", null)), false);
  assert.equal(memo.t1.at, null);
});

test("hc get が失敗した行は、? の hover に理由を出す", () => {
  const memo = { t1: { turn: 3, at: null, src: null, err: "exit 1" } };
  assert.deepEqual(look(claude("t1", "done", { turn: 3 }), memo, NOW), { glyph: "?", tip: "cache: 分からない（hc get が失敗した: exit 1）" });
});

test("前の起動で覚えた時刻は、turn が同じなら再起動の後もそのまま使い、hc に聞かない", () => {
  const memo = { t1: { turn: 2, at: NOW - 70 * MIN, src: "seen" } };
  const t = claude("t1", "done", { turn: 2 });
  assert.deepEqual(noteCache(memo, t, NOW, new Set()), { changed: false, ask: false });
  assert.deepEqual(look(t, memo, NOW), { glyph: "◯", tip: "cache cold（1h と仮定・mod が見た時刻）" });
});

test("前の起動から turn が進んでいたら、hc get に聞き直す", () => {
  const memo = { t1: { turn: 2, at: NOW - 70 * MIN, src: "seen" } };
  const t = claude("t1", "done", { turn: 3 });
  assert.deepEqual(noteCache(memo, t, NOW, new Set()), { changed: true, ask: true });
  assert.equal(look(t, memo, NOW).glyph, "?");
});

test("terminals() に turn が無ければ、? の hover にそう出す", () => {
  const memo = {};
  const t = claude("t1", "done");
  assert.equal(noteCache(memo, t, NOW, new Set()).ask, false);
  assert.deepEqual(look(t, memo, NOW), { glyph: "?", tip: "cache: 分からない（terminals() に turn が無い）" });
});

test("残りの分は切り上げる（1 分未満でも 0 分とは出さない）", () => {
  assert.equal(cacheLook({ kind: "until", until: NOW + 1000, src: "hc" }, NOW).tip, "cache 残り 1 分（1h と仮定・hc get の時刻）");
});

test("一覧から消えて 1 日たった terminal だけを忘れる", () => {
  const memo = {
    gone: { turn: 1, at: NOW - 2 * 86400000, src: "hc" },
    recent: { turn: 1, at: NOW - 3600000, src: "hc" },
    live: { turn: 1, at: NOW - 3 * 86400000, src: "hc" },
  };
  pruneCache(memo, new Set(["live"]), NOW);
  assert.deepEqual(Object.keys(memo).sort(), ["live", "recent"]);
});
