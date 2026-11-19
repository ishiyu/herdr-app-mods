import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectOf, threadCounts, countsLabel, countsTip, readThreads } from "../coordinator.js";
// 一覧（project-threads）の判定の元。sidebar の数が一覧のタブの件数と同じになるかを、元のほうで数えて比べる
import { rowsOf, tabCountsOf, TABS } from "../../project-threads/state.js";

const P = "/r/.local/hc-projects/pj";

test("thread-state.js は project-threads/state.js と同じ中身（写し直し忘れの検査）", async () => {
  const copy = await readFile(new URL("../thread-state.js", import.meta.url), "utf8");
  const source = await readFile(new URL("../../project-threads/state.js", import.meta.url), "utf8");
  assert.equal(copy, source, "project-threads/state.js を変えたら my-agents/thread-state.js に写し直す");
});

test("projectOf: 子の thread と見張りの作業フォルダから project のフォルダを出す", () => {
  const all = [
    { address: "t5b", parent: null, state: "live", cwd: "/somewhere/else/.local/hc-projects/other" },
    { address: "t186", parent: "t5b", state: "live", cwd: P },
    { address: "t20p", parent: "t5b", state: "live", cwd: `${P}/threads/t095` },
  ];
  assert.equal(projectOf("t5b", all), P);
});

test("projectOf: 自分の terminal の cwd は見ない（別の project を指していることがある）", () => {
  const all = [{ address: "t9r", parent: null, state: "live", cwd: `${P}` }];
  assert.equal(projectOf("t9r", all), null);
});

test("projectOf: 子が project の外（ふつうの agent の子）・終わった子・ほかの親の子だけなら null", () => {
  const all = [
    { address: "t1", parent: "ta", state: "live", cwd: "/r/src" },
    { address: "t2", parent: "ta", state: "exited", cwd: `${P}/threads/t001` },
    { address: "t3", parent: "tb", state: "live", cwd: `${P}/threads/t002` },
    { address: "t4", parent: "ta", state: "live", cwd: `${P}/threads/t003/sub` },
  ];
  assert.equal(projectOf("ta", all), null);
});

test("projectOf: 子が別々の project を指せば多いほう", () => {
  const Q = "/r/.local/hc-projects/qq";
  const all = [
    { address: "t1", parent: "ta", state: "live", cwd: Q },
    { address: "t2", parent: "ta", state: "live", cwd: `${P}/threads/t001` },
    { address: "t3", parent: "ta", state: "live", cwd: `${P}/` },
  ];
  assert.equal(projectOf("ta", all), P);
});

test("projectOf: ほかのマシンの agent は数えない（threads/ を読めない）", () => {
  const all = [{ address: "vps/t1", parent: "vps/t7", state: "live", cwd: `${P}/threads/t001` }];
  assert.equal(projectOf("vps/t7", all), null);
});

// 一覧の見出しを全部通る thread。terminal は thread.json の terminal で結ぶ
const term = (address, status, report) => ({ address, state: "live", status, labels: report ? { report } : {} });
const thread = (id, terminal, more = {}) => ({ id, terminal, report: null, question: null, ...more });
const threads = [
  thread("t001", "a1"), // 許可待ち → 要対応
  thread("t002", "a2"), // エラー → 要対応
  thread("t003", "a3"), // needs-you の報告 → あなた待ち → 要対応
  thread("t004", "a4"), // blocked の報告 → 行き詰まり → 要対応
  thread("t005", "a5", { question: "# 決めてほしい" }), // done の報告でも質問があれば あなた待ち → 要対応
  thread("t006", "gone", { question: "# 決めてほしい" }), // terminal が無くても質問があれば あなた待ち → 要対応
  thread("t007", "a7"), // 作業中
  thread("t008", "a8", { question: "# 決めてほしい" }), // 作業中は質問より先
  thread("t014", "a14"), // done の報告の後、バックグラウンドのコマンドが残って working → 報告済み → 対応完了
  thread("t009", "a9"), // waiting の報告 → 待機中 → 待ち
  thread("t010", "a10"), // 報告なし → 未報告 → 待ち
  thread("t011", "a11"), // done の報告 → 報告済み → 対応完了
  thread("t012", "gone"), // terminal が無い → 停止 → 対応完了
  thread("t013", "a13"), // terminal が終わっている（live でない）→ 停止 → 対応完了
];
const all = [
  term("a1", "blocked"),
  term("a2", "error"),
  term("a3", "idle", "needs-you"),
  term("a4", "done", "blocked"),
  term("a5", "done", "done"),
  term("a7", "working"),
  term("a8", "working"),
  term("a14", "working", "done"),
  term("a9", "idle", "waiting"),
  term("a10", "idle"),
  term("a11", "done", "done"),
  { ...term("a13", "done", "done"), state: "exited" },
];

test("threadCounts: 一覧のタブの件数と同じ数を、要対応・作業中・待ち・対応完了の順に出す", () => {
  const list = tabCountsOf(rowsOf(threads, all));
  assert.deepEqual(threadCounts(threads, all), TABS.map((tab) => list[tab]));
  assert.deepEqual(TABS, ["要対応", "作業中", "待ち", "対応完了"]);
  assert.deepEqual(threadCounts(threads, all), [6, 2, 2, 4]);
});

test("threadCounts: thread が無ければ全部 0", () => {
  assert.deepEqual(threadCounts([], all), [0, 0, 0, 0]);
});

test("countsLabel・countsTip: 0 の項目も 0 で出す", () => {
  assert.equal(countsLabel([0, 0, 0, 6]), "0/0/0/6");
  assert.equal(countsTip([0, 0, 0, 6]), "要対応 0 / 作業中 0 / 待ち 0 / 対応完了 6");
});

test("readThreads: 一覧と同じく threads/ 直下の t<数字> を読み、thread.json の無いものと片付けた .deleted/ は入れない", async () => {
  const files = {
    [`${P}/threads/t002/thread.json`]: JSON.stringify({ id: "t002", terminal: "a2" }),
    [`${P}/threads/t002/status.json`]: JSON.stringify({ status: "done", at: "x", summary: "s" }),
    [`${P}/threads/t002/question.md`]: "# 質問",
    [`${P}/threads/t001/thread.json`]: JSON.stringify({ id: "t001", terminal: "a1" }),
    [`${P}/threads/.deleted/t000/thread.json`]: JSON.stringify({ id: "t000", terminal: "a0" }),
  };
  const io = {
    readdir: async (dir) => {
      assert.equal(dir, `${P}/threads`);
      return ["t002", ".deleted", "t001", "t003", "notes.md"];
    },
    readTextFile: async (path) => files[path] ?? null,
  };
  assert.deepEqual(await readThreads(P, io), [
    { id: "t001", terminal: "a1", report: null, question: null },
    { id: "t002", terminal: "a2", report: { status: "done", at: "x", summary: "s" }, question: "# 質問" },
  ]);
});

test("readThreads: threads/ を読めなければ例外のまま返す（数を 0 と見せない）", async () => {
  const io = { readdir: async () => { throw new Error("ENOENT"); }, readTextFile: async () => null };
  await assert.rejects(readThreads(P, io), /ENOENT/);
});
