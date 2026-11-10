import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, TABS, groupOf, tabOf, tabCountsOf, tabLabel, summaryOf, signatureOf, unreadThreadIds, rowsOf, age } from "../state.js";

const live = (status, labels = {}) => ({ address: "t7", state: "live", status, labels, cwd: "/p/threads/t001" });

test("groupOf: terminal が無ければ停止", () => {
  assert.equal(groupOf(null), "停止");
});

test("groupOf: hc の状態が報告のラベルより優先する", () => {
  assert.equal(groupOf(live("blocked", { report: "done" })), "許可待ち");
  assert.equal(groupOf(live("error", { report: "done" })), "エラー");
  assert.equal(groupOf(live("working", { report: "needs-you" })), "作業中");
});

test("groupOf: 止まっているときは報告のラベルで分ける", () => {
  assert.equal(groupOf(live("done", { report: "needs-you" })), "あなた待ち");
  assert.equal(groupOf(live("idle", { report: "blocked" })), "行き詰まり");
  assert.equal(groupOf(live("done", { report: "waiting" })), "待機中");
  assert.equal(groupOf(live("idle", { report: "done" })), "報告済み");
});

test("groupOf: 報告のラベルが無ければ未報告", () => {
  assert.equal(groupOf(live("done")), "未報告");
  assert.equal(groupOf(live(null)), "未報告");
  assert.equal(groupOf({ address: "t7", state: "live", status: "idle" }), "未報告");
});

test("groupOf: 返す見出しはすべて GROUPS にある", () => {
  const cases = [null, live("blocked"), live("error"), live("working"), live("done"),
    ...["needs-you", "blocked", "waiting", "done"].map((report) => live("idle", { report }))];
  for (const c of cases) assert.ok(GROUPS.includes(groupOf(c)));
  assert.equal(new Set(cases.map(groupOf)).size, GROUPS.length);
});

test("tabOf: 見出しを 4 つのタブに割り当てる", () => {
  assert.deepEqual(Object.fromEntries(GROUPS.map((group) => [group, tabOf(group)])), {
    "許可待ち": "要対応",
    "エラー": "要対応",
    "あなた待ち": "要対応",
    "行き詰まり": "要対応",
    "作業中": "作業中",
    "待機中": "待ち",
    "未報告": "待ち",
    "報告済み": "対応完了",
    "停止": "対応完了",
  });
  assert.deepEqual(TABS, ["要対応", "作業中", "対応完了", "待ち"]);
});

test("tabOf: thread の状態から入るタブ", () => {
  const tabOfTerminal = (terminal) => tabOf(groupOf(terminal));
  assert.equal(tabOfTerminal(live("blocked")), "要対応");
  assert.equal(tabOfTerminal(live("idle", { report: "needs-you" })), "要対応");
  assert.equal(tabOfTerminal(live("idle", { report: "blocked" })), "要対応");
  assert.equal(tabOfTerminal(live("working", { report: "done" })), "作業中");
  assert.equal(tabOfTerminal(live("idle", { report: "waiting" })), "待ち");
  assert.equal(tabOfTerminal(live("idle")), "待ち");
  assert.equal(tabOfTerminal(live("done", { report: "done" })), "対応完了");
  assert.equal(tabOfTerminal(null), "対応完了");
});

test("tabCountsOf: タブごとに数え、0 件のタブも出す", () => {
  const rows = ["あなた待ち", "許可待ち", "作業中", "作業中", "報告済み", "停止"].map((group) => ({ group }));
  assert.deepEqual(tabCountsOf(rows), { "要対応": 2, "作業中": 2, "対応完了": 2, "待ち": 0 });
  assert.deepEqual(tabCountsOf([]), { "要対応": 0, "作業中": 0, "対応完了": 0, "待ち": 0 });
  assert.deepEqual(Object.keys(tabCountsOf([])), TABS);
});

test("tabLabel: タブの名前に件数を括弧で添える", () => {
  assert.equal(tabLabel("要対応", 1), "要対応(1)");
  assert.equal(tabLabel("待ち", 0), "待ち(0)");
});

test("summaryOf: 報告が無ければ空", () => {
  assert.equal(summaryOf(live("done"), null), "");
  assert.equal(summaryOf(null, null), "");
});

test("summaryOf: ラベルの時刻が status.json と合う報告だけを出す", () => {
  const report = { status: "done", summary: "直した", at: "2026-11-10T01:00:00Z" };
  assert.equal(summaryOf(live("done", { report: "done", "report.at": report.at }), report), "直した");
  assert.equal(summaryOf(live("working"), report), "");
  assert.equal(summaryOf(live("done", { report: "done", "report.at": "2026-11-10T02:00:00Z" }), report), "");
});

test("summaryOf: 止まった thread には最後の報告を出す", () => {
  const report = { status: "needs-you", summary: "案を選んでほしい", at: "2026-11-10T01:00:00Z" };
  assert.equal(summaryOf(null, report), "最後の報告 needs-you: 案を選んでほしい");
});

test("signatureOf: project の thread の terminal だけを数え、状態と報告の時刻で変わる", () => {
  const other = { address: "t1", state: "live", status: "working", cwd: "/other/threads/t001" };
  const sibling = { address: "t2", state: "live", status: "working", cwd: "/p-2/threads/t001" };
  const base = signatureOf("/p", [other, sibling, live("working")]);
  assert.equal(base, signatureOf("/p", [live("working")]));
  assert.notEqual(base, signatureOf("/p", [live("done")]));
  assert.notEqual(base, signatureOf("/p", [live("working", { "report.at": "2026-11-10T01:00:00Z" })]));
  assert.notEqual(base, signatureOf("/p", []));
  assert.equal(signatureOf("/p", [{ address: "t9", state: "live" }]), "[]");
});

test("unreadThreadIds: thread.json を読む前の thread の terminal だけを返す", () => {
  const started = { address: "t64", state: "live", status: "working", cwd: "/p/threads/t001" };
  // bin/start が terminal の状態の報告を待ってから thread.json を書くので、その報告で読み直した時点では記録が無い
  assert.deepEqual(unreadThreadIds("/p", [started], []), ["t001"]);
  assert.deepEqual(unreadThreadIds("/p", [started], [{ id: "t001", terminal: "t64" }]), []);
  // 別の project・止まった terminal・threads/ 直下でないフォルダは数えない
  const others = [
    { address: "t1", state: "live", cwd: "/p-2/threads/t002" },
    { address: "t2", state: "finished", cwd: "/p/threads/t003" },
    { address: "t3", state: "live", cwd: "/p/threads" },
    { address: "t4", state: "live", cwd: "/p/threads/drafts" },
    { address: "t5", state: "live" },
  ];
  assert.deepEqual(unreadThreadIds("/p", others, []), []);
});

test("rowsOf: live な terminal を番号で結び、見出しの順・新しい id の順に並べる", () => {
  const threads = [
    { id: "t001", terminal: "t10", report: null },
    { id: "t002", terminal: "t11", report: null },
    { id: "t003", terminal: "t12", report: null },
    { id: "t004", terminal: "t13", report: null },
  ];
  const terminals = [
    { address: "t10", state: "live", status: "working" },
    { address: "t11", state: "live", status: "blocked" },
    { address: "t12", state: "finished", status: "done" },
    { address: "t13", state: "live", status: "working" },
  ];
  const rows = rowsOf(threads, terminals);
  assert.deepEqual(rows.map((r) => [r.thread.id, r.group]), [
    ["t002", "許可待ち"],
    ["t004", "作業中"],
    ["t001", "作業中"],
    ["t003", "停止"],
  ]);
  assert.equal(rows[3].terminal, null);
  assert.equal(rows[0].terminal.address, "t11");
});

test("age: 分・時間・日で丸める", () => {
  assert.equal(age(59_000), "<1m");
  assert.equal(age(60_000), "1m");
  assert.equal(age(59 * 60_000), "59m");
  assert.equal(age(60 * 60_000), "1h");
  assert.equal(age(23 * 3_600_000), "23h");
  assert.equal(age(49 * 3_600_000), "2d");
});
