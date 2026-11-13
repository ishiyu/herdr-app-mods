import { test } from "node:test";
import assert from "node:assert/strict";
import { kidStatus, kidLook, kidRows, mostUrgent } from "../kids.js";

// tree() と同じ形: 深さ優先で、各行に罫線の lines
const kid = (address, status, more = {}) => ({ address, parent: "t5b", state: "live", status, ...more });
const row = (t, lines) => ({ t, lines });
const none = new Map();

const a = kid("ta", "idle");
const b = kid("tb", "working");
const c = kid("tc", "blocked");
const subs = [row(a, ["├"]), row(b, ["├"]), row(c, ["└"])];

test("kidRows: 開いているときは、Needs you の子がいても全部の子を元の罫線のまま出し、hidden は空", () => {
  assert.deepEqual(kidRows(subs, false, none), { rows: subs, hidden: [] });
});

test("kidRows: 畳んでいるときは、Needs you の子だけを出し、残りを hidden にする", () => {
  const { rows, hidden } = kidRows(subs, true, none);
  assert.deepEqual(rows, [row(c, ["└"])]);
  assert.deepEqual(hidden.map((s) => s.t.address), ["ta", "tb"]);
});

test("kidRows: 畳んでいて Needs you の子がいなければ、何も出さず全部を hidden にする", () => {
  const calm = [row(a, ["├"]), row(b, ["└"])];
  const { rows, hidden } = kidRows(calm, true, none);
  assert.deepEqual(rows, []);
  assert.equal(hidden.length, 2);
});

test("kidRows: Needs you でなくなった子は、畳みの中へ戻る", () => {
  const before = [row(a, ["├"]), row(kid("tb", "blocked"), ["└"])];
  assert.deepEqual(kidRows(before, true, none).rows.map((s) => s.t.address), ["tb"]);
  const after = [row(a, ["├"]), row(kid("tb", "working"), ["└"])];
  const { rows, hidden } = kidRows(after, true, none);
  assert.deepEqual(rows, []);
  assert.deepEqual(hidden.map((s) => s.t.address), ["ta", "tb"]);
});

test("kidRows: error の子も Needs you として出す（一覧の Needs you の条件と同じ）", () => {
  const { rows } = kidRows([row(a, ["├"]), row(kid("te", "error"), ["└"])], true, none);
  assert.deepEqual(rows.map((s) => s.t.address), ["te"]);
});

test("kidRows: agents() に載っている子は、その status で決める", () => {
  const listed = new Map([["ta", "blocked"], ["tc", "idle"]]);
  const { rows } = kidRows(subs, true, listed);
  assert.deepEqual(rows.map((s) => s.t.address), ["ta"]);
});

test("kidRows: Needs you の子が複数なら、1 段の木として ├ と └ を付け直す", () => {
  const many = [row(kid("t1", "blocked"), ["├"]), row(a, ["├"]), row(kid("t2", "error"), ["└"])];
  assert.deepEqual(kidRows(many, true, none).rows, [row(many[0].t, ["├"]), row(many[2].t, ["└"])]);
});

test("kidRows: 間の子が Needs you でない孫は、1 段に並べ直して出す", () => {
  const g = kid("tg", "blocked", { parent: "ta" });
  const deep = [row(a, ["├"]), row(g, ["│", "└"]), row(b, ["└"])];
  const { rows, hidden } = kidRows(deep, true, none);
  assert.deepEqual(rows, [row(g, ["└"])]);
  assert.deepEqual(hidden.map((s) => s.t.address), ["ta", "tb"]);
});

test("kidRows: 渡した subs は書き換えない", () => {
  const before = JSON.stringify(subs);
  kidRows(subs, true, none);
  assert.equal(JSON.stringify(subs), before);
});

test("kidStatus: error は blocked、done は idle として扱い、agents() の status を先に見る", () => {
  assert.equal(kidStatus(kid("x", "error"), none), "blocked");
  assert.equal(kidStatus(kid("x", "done"), none), "idle");
  assert.equal(kidStatus(kid("x", "idle"), new Map([["x", "blocked"]])), "blocked");
});

test("mostUrgent: いちばん急ぐ状態を返し、子が無ければ null", () => {
  assert.equal(mostUrgent([row(a, ["├"]), row(b, ["└"])], none), "working");
  assert.equal(mostUrgent(subs, none), "blocked");
  assert.equal(mostUrgent([], none), null);
});

// project-threads の bin/report が付ける報告のラベル
const reported = (address, status, report) => kid(address, status, { labels: { report, "report.at": "2026-11-13T00:00:00Z" } });

test("kidLook: 手の空いた子の報告が needs-you か blocked なら asking", () => {
  assert.equal(kidLook(reported("x", "done", "needs-you"), none), "asking");
  assert.equal(kidLook(reported("x", "idle", "blocked"), none), "asking");
});

test("kidLook: 報告が done・waiting か、報告が無い子は kidStatus のまま", () => {
  assert.equal(kidLook(reported("x", "done", "done"), none), "idle");
  assert.equal(kidLook(reported("x", "idle", "waiting"), none), "idle");
  assert.equal(kidLook(kid("x", "done"), none), "idle");
  assert.equal(kidLook(kid("x", "idle", { labels: { where: "zumen-engine / hc:inquiry" } }), none), "idle");
});

test("kidLook: 作業中と Needs you は報告のラベルより先に見る", () => {
  assert.equal(kidLook(reported("x", "working", "needs-you"), none), "working");
  assert.equal(kidLook(reported("x", "blocked", "needs-you"), none), "blocked");
  assert.equal(kidLook(reported("x", "error", "blocked"), none), "blocked");
  assert.equal(kidLook(reported("x", "idle", "needs-you"), new Map([["x", "working"]])), "working");
});

test("kidRows: 報告で対応を待っている子は Needs you ではないので、畳むと hidden に入る", () => {
  const asking = reported("tq", "done", "needs-you");
  const { rows, hidden } = kidRows([row(a, ["├"]), row(asking, ["└"])], true, none);
  assert.deepEqual(rows, []);
  assert.deepEqual(hidden.map((s) => s.t.address), ["ta", "tq"]);
});

test("mostUrgent: 報告で対応を待っている子は、作業中より先で Needs you より後", () => {
  const asking = row(reported("tq", "done", "needs-you"), ["└"]);
  assert.equal(mostUrgent([row(a, ["├"]), row(b, ["├"]), asking], none), "asking");
  assert.equal(mostUrgent([row(c, ["├"]), asking], none), "blocked");
});
