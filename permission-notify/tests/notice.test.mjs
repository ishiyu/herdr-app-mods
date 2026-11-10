import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { attentionOf, nextNotices, shellQuote, clickCommand, notifierArgs, failureNotice, createPoster } from "../notice.js";

const agent = (address, status, more = {}) => ({
  address,
  pane: `p-${address}`,
  status,
  space_name: "repo",
  tab_name: "1",
  title: `${address} の題名`,
  program: { name: "Claude Code" },
  ...more,
});
const term = (address, parent, status, more = {}) => ({ address, parent, status, state: "live", ...more });
const needs = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.needsYou]));
const step = (prev, ag, ts, view) => nextNotices(prev, attentionOf(ag, ts), view);

test("attentionOf: pane を持つ agent は blocked だけが Needs you", () => {
  const m = attentionOf([agent("t1", "blocked"), agent("t2", "working"), agent("t3", "done"), agent("t4", "error")], []);
  assert.deepEqual(needs(m), { t1: true, t2: false, t3: false, t4: false });
});

test("attentionOf: 一覧の agent の子孫の terminal も含め、子は blocked と error を Needs you に数える", () => {
  const m = attentionOf([agent("t1", "working")], [
    term("t1", null, "working"),
    term("t2", "t1", "blocked"),
    term("t3", "t1", "error"),
    term("t4", "t2", "blocked"),
    term("t5", "t4", "done"),
  ]);
  assert.deepEqual(needs(m), { t1: false, t2: true, t3: true, t4: true, t5: false });
});

test("attentionOf: 一覧の agent の子でない terminal・終わった子は含めない", () => {
  const m = attentionOf([agent("t1", "working")], [
    term("t9", null, "blocked"),
    term("t8", "t9", "blocked"),
    term("t2", "t1", "blocked", { state: "finished" }),
  ]);
  assert.deepEqual(needs(m), { t1: false });
});

test("attentionOf: 子が agents() にも載っていれば、agents() の status で判定する", () => {
  const m = attentionOf([agent("t1", "working"), agent("t2", "error")], [term("t2", "t1", "blocked")]);
  assert.equal(m.get("t2").needsYou, false);
  assert.equal(m.get("t2").target.pane, "p-t2");
});

test("attentionOf: 通知の文面と行き先", () => {
  const m = attentionOf([agent("t1", "blocked", { tab_name: "review" })], [term("t2", "t1", "blocked", { name: "worker", title: "作業" })]);
  assert.deepEqual(m.get("t1").target, { address: "t1", pane: "p-t1", name: "Claude Code", where: "repo · review", body: "t1 の題名" });
  assert.deepEqual(m.get("t2").target, { address: "t2", pane: null, rootPane: "p-t1", name: "worker", where: "repo · review · t1 の子", body: "作業" });
  assert.equal(attentionOf([agent("t3", "blocked")], []).get("t3").target.where, "repo", "番号だけのタブ名は出さない");
});

test("nextNotices: 初回は覚えるだけで、すでに許可待ちのものも出さない", () => {
  const { notices, state } = step(null, [agent("t1", "blocked"), agent("t2", "working")], []);
  assert.deepEqual(notices, []);
  assert.deepEqual(Object.fromEntries(state), { t1: true, t2: false });
});

test("nextNotices: Needs you でなかった agent が Needs you になったら 1 回だけ出す", () => {
  let r = step(null, [agent("t1", "working")], []);
  r = step(r.state, [agent("t1", "blocked")], []);
  assert.deepEqual(r.notices.map((n) => n.address), ["t1"]);
  r = step(r.state, [agent("t1", "blocked")], []);
  assert.deepEqual(r.notices, [], "同じ許可待ちのあいだは重ねない");
});

test("nextNotices: 答えて戻ったあと、次の許可待ちではまた出す", () => {
  let r = step(null, [agent("t1", "working")], []);
  r = step(r.state, [agent("t1", "blocked")], []);
  r = step(r.state, [agent("t1", "working")], []);
  assert.deepEqual(r.notices, []);
  r = step(r.state, [agent("t1", "blocked")], []);
  assert.deepEqual(r.notices.map((n) => n.address), ["t1"]);
});

test("nextNotices: 途中で初めて見えた agent は、許可待ちでも覚えるだけ", () => {
  let r = step(null, [], []);
  r = step(r.state, [agent("t1", "blocked")], []);
  assert.deepEqual(r.notices, []);
});

test("nextNotices: 一度消えて見え直した agent も覚え直すだけ（core の再接続）", () => {
  let r = step(null, [agent("t1", "working")], []);
  r = step(r.state, [], []);
  r = step(r.state, [agent("t1", "blocked")], []);
  assert.deepEqual(r.notices, []);
});

test("nextNotices: 子の terminal が許可待ちになっても出す", () => {
  const ts = (s) => [term("t1", null, "working"), term("t2", "t1", s)];
  let r = step(null, [agent("t1", "working")], ts("working"));
  r = step(r.state, [agent("t1", "working")], ts("blocked"));
  assert.deepEqual(r.notices.map((n) => n.address), ["t2"]);
});

test("nextNotices: window が前面でその terminal にフォーカスがあれば出さない", () => {
  let r = step(null, [agent("t1", "working")], []);
  const watched = step(r.state, [agent("t1", "blocked")], [], { windowActive: true, focusedTerminal: "t1" });
  assert.deepEqual(watched.notices, []);
  assert.equal(watched.state.get("t1"), true, "見ていた許可待ちは済んだものとして覚える");
  const behind = step(r.state, [agent("t1", "blocked")], [], { windowActive: false, focusedTerminal: "t1" });
  assert.deepEqual(behind.notices.map((n) => n.address), ["t1"], "window が後ろなら出す");
  const other = step(r.state, [agent("t1", "blocked")], [], { windowActive: true, focusedTerminal: "t9" });
  assert.deepEqual(other.notices.map((n) => n.address), ["t1"], "別の terminal を見ているなら出す");
});

test("shellQuote: sh に 1 語として渡る", () => {
  const s = `a 'b' "c" $d`;
  assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(s)}`]).toString(), s);
});

test("clickCommand: pane を持つ agent はその pane へ、子は親の pane へ移ってから重ねて開く", () => {
  const app = "/Applications/Herdr.app/Contents/MacOS/Herdr";
  assert.equal(clickCommand({ address: "t1", pane: "p1" }, app), `'${app}' do pane.focus '{"pane":"p1"}'`);
  assert.equal(
    clickCommand({ address: "t2", pane: null, rootPane: "p1" }, app),
    `'${app}' do pane.focus '{"pane":"p1"}' && '${app}' do terminal.peek '{"terminal":"t2"}'`,
  );
});

test("notifierArgs: 音を付けず、agent ごとにまとめ、押すと Herdr を前に出す", () => {
  const args = notifierArgs({ address: "t1", pane: "p1", name: "Claude Code", where: "repo", body: "題名" }, "/x/herdr-app");
  const opt = (k) => args[args.indexOf(k) + 1];
  assert.equal(args.includes("-sound"), false);
  assert.equal(opt("-title"), "⚠️ Claude Code needs you");
  assert.equal(opt("-subtitle"), "repo");
  assert.equal(opt("-message"), "題名");
  assert.equal(opt("-group"), "herdr-permission-t1");
  assert.equal(opt("-activate"), "dev.herdr.app");
  assert.equal(opt("-execute"), `'/x/herdr-app' do pane.focus '{"pane":"p1"}'`);
});

test("notifierArgs: 本文と副題が空でも空の引数を渡さない", () => {
  const args = notifierArgs({ address: "t1", pane: "p1", name: "x", where: "", body: "" }, "/x/herdr-app");
  assert.equal(args[args.indexOf("-message") + 1], "t1");
  assert.equal(args[args.indexOf("-subtitle") + 1], "t1");
});

test("failureNotice: terminal-notifier が無いときは入れ方を添えて知らせる", () => {
  const n = failureNotice("terminal-notifier", new Error("No such file or directory"));
  assert.equal(n.level, "error");
  assert.match(n.body, /brew install terminal-notifier/);
  assert.match(n.body, /No such file or directory/);
});

test("failureNotice: 終了コードが 0 でないときは、コードと stderr を出す", () => {
  const n = failureNotice("terminal-notifier", { code: 1, stdout: "", stderr: "boom\n" });
  assert.equal(n.level, "error");
  assert.match(n.body, /終了コード 1/);
  assert.match(n.body, /boom/);
  assert.doesNotMatch(n.body, /brew install/);
});

test("failureNotice: herdr-app が見つからないとき", () => {
  const n = failureNotice("herdr-app", { code: 1, stdout: "", stderr: "" });
  assert.equal(n.level, "error");
  assert.match(n.body, /herdr-app/);
});

// herdr の exec の偽物。呼ばれた引数を calls に残し、プログラムごとの返事を返す（関数なら呼ぶ、Error なら投げる）
function fakeExec(replies) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    const r = typeof replies[cmd] === "function" ? replies[cmd]() : replies[cmd];
    if (r instanceof Error) throw r;
    return r;
  };
  return { exec, calls };
}
const target = { address: "t1", pane: "p1", name: "Claude Code", where: "repo", body: "題名" };
const ok = { code: 0, stdout: "", stderr: "" };

test("createPoster: herdr-app の場所を 1 回だけ調べ、terminal-notifier で通知を出す", async () => {
  const notified = [];
  const { exec, calls } = fakeExec({ "/bin/sh": { code: 0, stdout: "/x/herdr-app\n", stderr: "" }, "terminal-notifier": ok });
  const post = createPoster({ exec, notify: (n) => notified.push(n) });
  await post(target);
  await post(target);
  assert.deepEqual(calls.map((c) => c[0]), ["/bin/sh", "terminal-notifier", "terminal-notifier"]);
  assert.deepEqual(calls[1][1], notifierArgs(target, "/x/herdr-app"));
  assert.deepEqual(notified, []);
});

test("createPoster: terminal-notifier が無ければ画面内の通知で知らせ、出せるようになるまで繰り返さない", async () => {
  const notified = [];
  let missing = true;
  const { exec } = fakeExec({
    "/bin/sh": { code: 0, stdout: "/x/herdr-app\n", stderr: "" },
    "terminal-notifier": () => (missing ? new Error("No such file or directory") : ok),
  });
  const post = createPoster({ exec, notify: (n) => notified.push(n) });
  await post(target);
  await post(target);
  assert.equal(notified.length, 1);
  assert.match(notified[0].body, /brew install terminal-notifier/);
  missing = false;
  await post(target);
  missing = true;
  await post(target);
  assert.equal(notified.length, 2, "一度出せたあとに出せなくなったら、また知らせる");
});

test("createPoster: herdr-app が見つからなければ terminal-notifier を呼ばずに知らせる", async () => {
  const notified = [];
  const { exec, calls } = fakeExec({ "/bin/sh": { code: 1, stdout: "", stderr: "" }, "terminal-notifier": ok });
  const post = createPoster({ exec, notify: (n) => notified.push(n) });
  await post(target);
  assert.deepEqual(calls.map((c) => c[0]), ["/bin/sh"]);
  assert.equal(notified.length, 1);
  assert.match(notified[0].body, /herdr-app/);
});

test("createPoster: 本物のプロセスで、PATH に terminal-notifier が無いときに知らせる", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const bin = mkdtempSync(`${tmpdir()}/permission-notify-`);
  writeFileSync(`${bin}/herdr-app`, "#!/bin/sh\n");
  chmodSync(`${bin}/herdr-app`, 0o755);
  // herdr の exec と同じく、起動できなければ投げ、起動できれば終了コードを返す
  const exec = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { PATH: bin } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
  const notified = [];
  await createPoster({ exec, notify: (n) => notified.push(n) })(target);
  assert.equal(notified.length, 1);
  assert.match(notified[0].body, /terminal-notifier を起動できません/);
  assert.match(notified[0].body, /ENOENT/);
});

test("clickCommand: sh で実行すると herdr-app do に命令と JSON の引数がそのまま渡る", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/permission-notify click-`);
  const app = `${dir}/herdr app`;
  writeFileSync(app, `#!/bin/sh\nprintf '%s|' "$@" >> '${dir}/log'\necho >> '${dir}/log'\n`);
  chmodSync(app, 0o755);
  execFileSync("/bin/sh", ["-c", clickCommand({ address: "t2", pane: null, rootPane: "p'1" }, app)]);
  assert.equal(readFileSync(`${dir}/log`, "utf8"), `do|pane.focus|{"pane":"p'1"}|\ndo|terminal.peek|{"terminal":"t2"}|\n`);
});
