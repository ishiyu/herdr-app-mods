import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, TABS, groupOf, tabOf, tabColorOf, tabCountsOf, tabLabel, summaryOf, signatureOf, unreadThreadIds, rowsOf, contextLabel, umbrellaLabel, rulesOf, policyReposOf, policyCount, policyLabel, age, hasQuestion, questionCount, questionTitleOf, questionLabel, opensDetail, detailKindOf, reportSummaryText, questionsChanged, textKey } from "../state.js";

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
  assert.deepEqual(TABS, ["要対応", "作業中", "待ち", "対応完了"]);
});

test("tabColorOf: どのタブにも theme の色の名前がある", () => {
  assert.deepEqual(TABS.map(tabColorOf), ["blocked", "working", "working", "ansi2"]);
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

test("contextLabel: claude の statusline と同じ丸めで書き、値が無ければ空", () => {
  assert.equal(contextLabel(149_842), "150k");
  assert.equal(contextLabel(94_372), "94.4k");
  assert.equal(contextLabel(99_960), "100k");
  assert.equal(contextLabel(5_000), "5k");
  assert.equal(contextLabel(901), "901");
  assert.equal(contextLabel(undefined), "");
  assert.equal(contextLabel(null), "");
});

test("umbrellaLabel: umbrella と登録した時点の題名を並べる", () => {
  assert.equal(umbrellaLabel({ name: "demo", umbrella: "ishiyu/demo#5", umbrellaTitle: "通知を届ける" }), "ishiyu/demo#5 通知を届ける");
});

test("umbrellaLabel: 題名が無ければ umbrella だけ", () => {
  assert.equal(umbrellaLabel({ umbrella: "ishiyu/demo#5" }), "ishiyu/demo#5");
});

test("umbrellaLabel: umbrella が無い・文字列でなければ出さない", () => {
  assert.equal(umbrellaLabel({ name: "demo" }), "");
  assert.equal(umbrellaLabel({ umbrella: 5 }), "");
  assert.equal(umbrellaLabel(null), "");
});

test("rulesOf: 2 つの欄の箇条書きを項目にする", () => {
  const text = "# この repo の決まり\n\n本文\n\n## 自律的にやってよいこと\n\n- テストを流す\n  名前で絞る\n1. lint\n### 小見出し\n- push\n\n## 確認すること\n\n- main への取り込み\n\n## ほか\n\n- 拾わない\n";
  assert.deepEqual(rulesOf(text), { allow: ["テストを流す 名前で絞る", "lint", "push"], confirm: ["main への取り込み"] });
});

test("rulesOf: コメントの中（雛形の説明）は数えない", () => {
  assert.deepEqual(rulesOf("<!--\n## 確認すること\n- 例\n-->\n## 自律的にやってよいこと\n<!-- 説明 -->\n## 確認すること\n"), { allow: [], confirm: [] });
});

test("rulesOf: ファイルが無ければ空", () => {
  assert.deepEqual(rulesOf(null), { allow: [], confirm: [] });
});

test("policyReposOf: project を置いた repo を先頭に、worktree の元の repo を重ねずに並べる", () => {
  const project = "/g/herdr-app-config/.local/hc-projects/pj-mod";
  const texts = ["/g/herdr-app-mods=tmp-a\n", null, "/g/herdr-app-config=tmp-b\n/g/herdr-app-mods=tmp-c\n\n", "/g/other\nrelative\n"];
  assert.deepEqual(policyReposOf(project, texts), ["/g/herdr-app-config", "/g/herdr-app-mods", "/g/other"]);
});

test("policyCount と policyLabel: 項目の数か未設定", () => {
  const count = policyCount([{ allow: ["a"], confirm: ["b", "c"] }, { allow: [], confirm: [] }]);
  assert.equal(count, 3);
  assert.equal(policyLabel(count), "方針 3");
  assert.equal(policyLabel(0), "方針 未設定");
});

test("groupOf: 未回答の質問がある thread は、terminal が無くてもあなた待ち", () => {
  assert.equal(groupOf(null, true), "あなた待ち");
  assert.equal(groupOf(null, false), "停止");
  // terminal があれば hc の状態と報告のラベルで決める（質問は見ない）
  assert.equal(groupOf(live("working"), true), "作業中");
  assert.equal(groupOf(live("idle", { report: "done" }), true), "報告済み");
});

test("rowsOf: 質問のある止まった thread を要対応に入れる", () => {
  const threads = [
    { id: "t001", terminal: "t10", report: null, question: "# A か B か" },
    { id: "t002", terminal: "t11", report: null, question: null },
  ];
  const rows = rowsOf(threads, []);
  assert.deepEqual(rows.map((r) => [r.thread.id, r.group, tabOf(r.group)]), [
    ["t001", "あなた待ち", "要対応"],
    ["t002", "停止", "対応完了"],
  ]);
});

test("hasQuestion と questionCount: question.md の中身があるものを数える", () => {
  const threads = [{ question: "# 問い" }, { question: null }, {}, { question: "" }];
  assert.deepEqual(threads.map(hasQuestion), [true, false, false, true]);
  assert.equal(questionCount(threads), 2);
  assert.equal(questionLabel(2), "質問 2");
});

test("questionTitleOf: 最初の見出し、無ければ最初の空でない行", () => {
  assert.equal(questionTitleOf("\n# A と B のどちらにするか\n\n## 事実と根拠\n"), "A と B のどちらにするか");
  assert.equal(questionTitleOf("## 事実と根拠\n# 後の見出し"), "事実と根拠");
  assert.equal(questionTitleOf("<!-- 下書き -->\n\n見出しの無い問い\n続き"), "見出しの無い問い");
  assert.equal(questionTitleOf(""), "");
  assert.equal(questionTitleOf(null), "");
});

test("opensDetail: あなた待ち・行き詰まり・terminal の無い行は詳細を、ほかは画面を開く", () => {
  const terminal = { address: "t7" };
  assert.deepEqual(GROUPS.map((group) => [group, opensDetail(group, terminal)]), [
    ["許可待ち", false],
    ["エラー", false],
    ["あなた待ち", true],
    ["行き詰まり", true],
    ["作業中", false],
    ["待機中", false],
    ["未報告", false],
    ["報告済み", false],
    ["停止", false],
  ]);
  assert.equal(opensDetail("停止", null), true);
});

test("detailKindOf: 選んだ側が無ければもう一方、どちらも無ければ要約", () => {
  const both = { question: "# 問い", report: { status: "needs-you", detail: "/p/threads/t001/reports/x.md" } };
  assert.equal(detailKindOf(both, "question"), "question");
  assert.equal(detailKindOf(both, "report"), "report");
  const questionOnly = { question: "# 問い", report: { status: "needs-you" } };
  assert.equal(detailKindOf(questionOnly, "report"), "question");
  const reportOnly = { question: null, report: both.report };
  assert.equal(detailKindOf(reportOnly, "question"), "report");
  assert.equal(detailKindOf({ question: null, report: { status: "done" } }, "question"), "summary");
  assert.equal(detailKindOf({ question: null, report: null }, "report"), "summary");
});

test("reportSummaryText: 写しの無い報告は status・時刻・要約を出す", () => {
  assert.equal(reportSummaryText({ status: "needs-you", at: "2026-11-12T00:00:00Z", summary: "決めてほしい" }),
    "**needs-you**（2026-11-12T00:00:00Z）\n\n決めてほしい\n\nこの報告には詳細のファイルがありません。");
  assert.equal(reportSummaryText(null), "報告はまだありません。");
});

test("questionsChanged: 質問の書き込み・移動と、溢れた束（threads/ そのもの）で読み直す", () => {
  assert.equal(questionsChanged("/p", ["/p/threads/t001/question.md"]), true);
  assert.equal(questionsChanged("/p", ["/p/threads/t001/report.md", "/p/threads/t001/questions/20261112T000000Z.md"]), false);
  assert.equal(questionsChanged("/p", ["/p/threads"]), true);
  assert.equal(questionsChanged("/p", ["/p/threads/"]), true);
  assert.equal(questionsChanged("/p", ["/p/threads/t001/status.json"]), false);
  // 監視が返すパスは /private の付いた実体のことがある
  assert.equal(questionsChanged("/p", ["/private/p/threads/t012/question.md"]), true);
  assert.equal(questionsChanged("/p", []), false);
});

test("textKey: 本文が変われば変わり、同じ本文なら同じ", () => {
  assert.equal(textKey("# 問い"), textKey("# 問い"));
  assert.notEqual(textKey("# 問い"), textKey("# 問い\n追記"));
  assert.match(textKey(""), /^[0-9a-z]+$/);
});
