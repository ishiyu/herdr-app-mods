import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, nextCommand, props, run } from "herdr";

// フォーカス中 pane の cwd を最優先し、space の folder は最後の手段。
// 本 mod 自身が pane として開かれてフォーカスを持つと mod pane には cwd が無いので、同じ tab の端末 pane を使う
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const focusedPane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const pane = focusedPane?.terminal ? focusedPane : panes().find((p) => p.tab === f?.tab && p.terminal && p.cwd);
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

async function gh(args, cwd, on) {
  const r = await exec("gh", args, { cwd, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout;
}
const ghJson = async (args, cwd, on) => JSON.parse(await gh(args, cwd, on));

const PR_FIELDS = "number,title,state,isDraft,headRefName,reviewDecision,statusCheckRollup,url";
const ISSUE_FIELDS = "number,title,state,labels,updatedAt,url";
const RUN_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,createdAt,url";
const PR_DETAIL_FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,reviewDecision,latestReviews,reviewRequests,statusCheckRollup,additions,deletions,changedFiles,body,url,createdAt";
const RUN_DETAIL_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,headBranch,createdAt,url,jobs";
const ISSUE_DETAIL_FIELDS = "number,title,state,stateReason,author,labels,assignees,body,url,createdAt,subIssues,subIssuesSummary";
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const tabOf = (kind) => ({ run: "ci", issue: "issue", file: "local" })[kind] ?? "pr";
// zumen-engine では直近 7 日だけで数百件書かれるので、新しいものに絞らないと探せない
const LOCAL_LIMIT = 20;
// 更新時刻の書式が BSD（macOS）と GNU（Linux）の stat / find で違う
const LOCAL_SCRIPT = [
  'dir="$1/.local"; [ -d "$dir" ] || exit 0',
  'if stat -f %m / >/dev/null 2>&1; then find "$dir" -type f -name "*.md" -exec stat -f "%m%t%N" {} +',
  'else find "$dir" -type f -name "*.md" -printf "%T@\\t%p\\n"; fi',
].join("\n");

async function localDocs(root, on) {
  const r = await exec("sh", ["-c", LOCAL_SCRIPT, "local-docs", root], { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.split("\n").filter(Boolean)
    .map((line) => { const [mtime, path] = line.split("\t"); return { mtime: Number(mtime) * 1000, path: path.slice(root.length + 1) }; })
    .sort((a, b) => b.mtime - a.mtime);
}
// 検索中は件数の制限を外し、空白で区切った語をすべて含むパスに絞る
function matchDocs(docs, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? docs.filter((f) => terms.every((w) => f.path.toLowerCase().includes(w))) : docs.slice(0, LOCAL_LIMIT);
}
// 打つたびに gh を呼ぶとレート制限を食うので、入力が止まってから引く
const SEARCH_DEBOUNCE_MS = 400;
// 各タブの初期の検索条件で、mine ボタンが検索バーに入れる条件。
// issue の子は親 issue を追えば辿れるので、自分の担当のうち親を持たないものだけを出す
const MINE_QUERY = { issue: "is:open assignee:@me -has:parent-issue", pr: "is:open author:@me" };
const STATE_ORDER = { fail: 0, pending: 1, pass: 2, none: 3 };
// 自動更新と同じ間隔。これより新しい取得結果があれば、herdr のタブを切り替えて戻っても取り直さない
const STALE_MS = 60000;
// herdr のタブや repo を渡り歩いても覚えておく数。閉じたタブの分を溜め込まないよう古いものから捨てる
const MEMORY_LIMIT = 20;
const emptyData = () => ({ root: null, branch: null, prs: [], issues: [], runs: [], docs: [], docsLoaded: false, docsError: null, error: null, updated: 0, fetched: 0, loading: false });
// 詳細は { kind: "pr" | "issue" | "run" | "file" | "number", id, data, error, loading }。"number" は PR か issue か未判定の番号、"file" の id は repo root からの相対パス
// 検索欄は herdr のタブごとに使い分けるので、検索語（queries）と Issues / PRs の検索結果（results）も view に持つ。
// results は { key, items, loading, error } で、key（検索語）が queries と食い違えば引き直す
const emptyView = (context, queries = { issue: MINE_QUERY.issue, pr: MINE_QUERY.pr, local: "" }) =>
  ({ context, tab: "issue", details: { issue: null, pr: null, ci: null, local: null }, queries, results: { issue: null, pr: null } });
// Map を挿入順の LRU として使う
function remember(map, k, make) {
  const v = map.has(k) ? map.get(k) : make();
  map.delete(k); map.set(k, v);
  while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value);
  return v;
}

// statusCheckRollup は CheckRun（status/conclusion）と StatusContext（state）が混在する
function checkState(c) {
  const v = (c.conclusion || c.state || "").toUpperCase();
  if (FAILED.has(v)) return "fail";
  if (c.status && c.status !== "COMPLETED") return "pending";
  if (v === "PENDING" || v === "EXPECTED") return "pending";
  if (v === "SUCCESS") return "pass";
  return "none";
}
function rollup(checks) {
  if (!checks?.length) return "none";
  const states = new Set(checks.map(checkState));
  // 全件 SKIPPED / NEUTRAL は「何も検証していない」なので成功扱いにしない
  return states.has("fail") ? "fail" : states.has("pending") ? "pending" : states.has("pass") ? "pass" : "none";
}
// run と job は小文字の status / conclusion を持つ
function runState(r) {
  if (r.status !== "completed") return "pending";
  if (r.conclusion === "success") return "pass";
  if (r.conclusion === "skipped" || r.conclusion === "neutral") return "none";
  return "fail";
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}
// 実行中の job は completedAt がゼロ値（0001-01-01）で返る
function duration(start, end) {
  if (!start || start.startsWith("0001")) return "";
  const stop = !end || end.startsWith("0001") ? Date.now() : Date.parse(end);
  const s = Math.max(0, Math.round((stop - Date.parse(start)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
// PR の本文は HTML コメント（テンプレートの案内文）とタグを落とした素のテキストで出す
function plainText(body) {
  return (body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export default class GhStatus extends View {
  // 表示中のサイドバータブの詳細。サイドバータブを行き来しても閉じないよう、詳細はサイドバータブごとに持つ
  get detail() { return this.details[this.tab]; }
  set detail(d) { this.details[this.tab] = d; }

  init(_props, cx) {
    // herdr のタブを切り替えて戻ったときに取り直さず元の表示を出すため、取得結果は repo（key()）ごとに、
    // 見ていたサイドバータブと詳細は herdr のタブごとに覚えておく。表示中のものは this.data / this.view
    this.cache = new Map(); this.views = new Map();
    this.data = emptyData(); this.view = emptyView(null);
    // 検索語は repo をまたいで持ち越し、repo を移ったら移った先で引き直す
    // 入力欄は全 herdr タブで共有し、herdr のタブを移るたびに移った先の view の検索語を入れ直す
    this.searches = {
      issue: InputState.new({ placeholder: "issue を検索（#番号で詳細を開く）", value: MINE_QUERY.issue }),
      pr: InputState.new({ placeholder: "PR を検索（#番号で詳細を開く）", value: MINE_QUERY.pr }),
      local: InputState.new({ placeholder: "パスで絞り込む" }),
    };
    for (const tab of ["issue", "pr", "local"]) {
      this.searches[tab].on("change", (_e, cx) => {
        const value = this.searches[tab].value();
        // herdr のタブを移って入れ直したときの change は、検索語が変わっていないので何もしない
        if (value === this.queries[tab]) return;
        this.queries[tab] = value;
        if (tab === "local") cx.notify(); else this.search(tab, cx, { debounce: true });
      });
    }
    for (const tab of ["issue", "pr"]) this.searches[tab].on("submit", (_e, cx) => this.submitSearch(tab, cx));
    // pane として常駐しているときに奪うと terminal へ打てなくなるので、ダイアログで開いたときだけ検索欄へ移す
    if (props()?.overlay) this.searches.issue.focus();
    // herdr の mod 命令は引数を運べないので、番号は命令名に埋める（herdr-app do right-sidebar.open-1234）
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const m = command.match(/^(open|run)-(\d+)$/);
        const tab = command.match(/^tab-(issue|pr|ci|local)$/);
        if (m) this.openDetail(m[1] === "run" ? "run" : "number", Number(m[2]), cx);
        else if (tab) this.selectTab(tab[1], cx);
        else if (command === "back") this.back(cx);
        else console.log(`right-sidebar: unknown command ${command}`);
      }
    });
    // gh API のレート制限を食わないよう 60 秒間隔。初回の取得と、表示中の repo や herdr のタブが変わったときの切り替えは render から行う
    cx.timer.every(STALE_MS, (cx) => this.refresh(cx));
  }

  // render から呼ばれる。表示中の repo か herdr のタブが変わったら覚えている状態へ切り替え、取得結果が古いときだけ取り直す
  sync(cx) {
    const context = key(), tab = focused()?.tab ?? null;
    if (context === this.context && tab === this.herdrTab) return;
    this.context = context; this.herdrTab = tab;
    this.data = remember(this.cache, context, emptyData);
    this.view = remember(this.views, tab, () => emptyView(context));
    // 同じ herdr のタブでも別 repo へ移ったなら、番号を引き直すと別物を表示するので、見ていた詳細と検索結果は捨てる。検索語は移った先で引き直す
    if (this.view.context !== context) { this.view = emptyView(context, this.view.queries); this.views.set(tab, this.view); }
    this.loadQueries(cx);
    if (Date.now() - this.data.fetched >= STALE_MS) { this.refresh(cx, { inRender: true }); return; }
    this.ensureSearches(cx, { inRender: true });
    // 離れている間は .local を監視していないので、一覧だけ読み直す。gh は呼ばない
    if (this.data.root) {
      const { on } = location();
      this.loadDocs(this.data, on, cx);
      this.watchLocal(this.data, on, context, cx);
    }
  }

  // render から呼ぶときは notify できない（GPUI が render 中の notify を禁じる）。描き直しは spawn 側の完了時に起きる
  refresh(cx, { inRender = false } = {}) {
    const entry = this.data, context = this.context;
    if (entry.loading || key() !== context) return;
    const { cwd, on } = location();
    if (!cwd) return;
    entry.loading = true;
    // 結果は取得を始めた repo の entry に書く。途中で herdr のタブを移っても、戻ったときに取り直さずに済む
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { entry.root = null; entry.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        // .local の詳細は gh の成否に関係なく開けるよう、root は gh より先に確定させる
        entry.root = root;
        const branch = (await exec("git", ["branch", "--show-current"], { cwd: root, on })).stdout.trim();
        const prArgs = ["pr", "list", "--state", "open", "--limit", "30", "--json", PR_FIELDS];
        // GitHub の remote が無い repo でも .local は読めるので、gh の成否と切り離す
        this.loadDocs(entry, on, cx);
        this.watchLocal(entry, on, context, cx);
        const [prs, issues, runs] = await Promise.all([
          ghJson(prArgs, root, on),
          ghJson(["issue", "list", "--state", "open", "--limit", "50", "--json", ISSUE_FIELDS], root, on),
          // 条件付き workflow（bot・コメント起動など）の skipped run は何も実行しておらず実際の CI を画面外に押し出すため、多めに取って除いてから 8 件に絞る
          branch ? ghJson(["run", "list", "--branch", branch, "--limit", "40", "--json", RUN_FIELDS], root, on) : Promise.resolve([]),
        ]);
        entry.branch = branch; entry.error = null;
        entry.prs = prs.map((p) => ({ ...p, ci: rollup(p.statusCheckRollup) }));
        entry.issues = issues;
        entry.runs = runs.filter((r) => r.conclusion !== "skipped").slice(0, 8);
        entry.updated = Date.now();
        if (this.data === entry) { this.loadDetail(cx); this.ensureSearches(cx); }
      } catch (e) { entry.error = String(e.message ?? e); }
      // 失敗しても fetched は進める。進めないと herdr のタブを切り替えるたびに失敗する取得を繰り返す
      finally { entry.loading = false; entry.fetched = Date.now(); cx.notify(); }
    });
    if (!inRender) cx.notify();
  }

  loadDocs(entry, on, cx) {
    cx.spawn(async (cx) => {
      try {
        entry.docs = await localDocs(entry.root, on); entry.docsLoaded = true; entry.docsError = null;
      } catch (e) { entry.docsError = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  // watchFolder は手元のマシンしか見られないので、別マシンの space は 60 秒ごとの refresh だけで追う
  watchLocal(entry, on, context, cx) {
    const root = entry.root;
    if (on || this.watching === root) return;
    this.watching = root;
    cx.spawn(async (cx) => {
      try {
        while (key() === context) {
          const changed = await watchFolder(`${root}/.local`);
          if (key() !== context) break;
          if (changed.some((p) => p === `${root}/.local` || p.endsWith(".md"))) this.loadDocs(entry, on, cx);
        }
      } catch (e) { console.log(`right-sidebar: watchFolder ${root}/.local failed: ${e.message ?? e}`); }
      finally { if (this.watching === root) this.watching = null; }
    });
  }

  searchKey(tab) {
    return this.queries[tab].trim();
  }

  // render 中に入力欄を書き換えると描画が入れ子になるので、spawn に回す
  loadQueries(cx) {
    const view = this.view;
    cx.spawn(async () => {
      if (this.view !== view) return;
      for (const tab of ["issue", "pr", "local"]) {
        if (this.searches[tab].value() !== view.queries[tab]) this.searches[tab].set_value(view.queries[tab]);
      }
    });
  }

  // 検索語が空なら通常の一覧へ戻す。debounce のときは入力が止まるまで待ち、その間に打ち足されたら引かない。
  // render から呼ぶときは notify できないので、描き直しは spawn の完了時に任せる
  search(tab, cx, { debounce = false, inRender = false } = {}) {
    const entry = this.data, view = this.view, key = this.searchKey(tab);
    if (!key) { view.results[tab] = null; if (!inRender) cx.notify(); return; }
    if (debounce && view.results[tab]?.key === key) return;
    // repo の root が分かるまでは引けない。refresh の完了時に ensureSearches から引き直す
    if (!entry.root) return;
    const root = entry.root, { on } = location();
    // 引いている間は前の結果を残し、一覧が空にちらつかないようにする
    const r = view.results[tab] = { key, items: view.results[tab]?.items ?? [], loading: true, error: null };
    const args = tab === "pr"
      ? ["pr", "list", "--search", key, "--state", "all", "--limit", "30", "--json", PR_FIELDS]
      : ["issue", "list", "--search", key, "--state", "all", "--limit", "50", "--json", ISSUE_FIELDS];
    cx.spawn(async (cx) => {
      try {
        if (debounce) { await cx.sleep(SEARCH_DEBOUNCE_MS); if (view.results[tab] !== r) return; }
        const items = await ghJson(args, root, on);
        // 取得中に打ち足された・消された検索の結果で上書きしない
        if (view.results[tab] !== r) return;
        r.items = tab === "pr" ? items.map((p) => ({ ...p, ci: rollup(p.statusCheckRollup) })) : items;
        r.error = null;
      } catch (e) { r.error = String(e.message ?? e); }
      finally { r.loading = false; cx.notify(); }
    });
    if (!inRender) cx.notify();
  }

  // repo を移ったときと一覧を取り直したときに、入力中の検索語の結果がその repo のものでなければ引き直す
  ensureSearches(cx, { inRender = false } = {}) {
    for (const tab of ["issue", "pr"]) {
      if (this.results[tab]?.key !== this.searchKey(tab)) this.search(tab, cx, { inRender });
    }
  }

  selectTab(tab, cx) {
    this.tab = tab;
    if (tab === "issue") {
      // 検索欄は一覧の上にしか無いので、詳細を開いていたら一覧へ戻す
      this.detail = null;
      // 前の条件をすぐ打ち替えられるよう全選択する。打ち終えたら元の terminal へ戻す（submitSearch）
      const input = this.searches.issue;
      this.returnPane = focused()?.pane;
      input.focus();
      input.set_selected_range({ start: 0, end: input.value().length });
    }
    cx.notify();
  }

  // from は back で戻る先の詳細。サブイシューから親 issue へ戻るときに、取り直さず元の表示を出すために持つ
  openDetail(kind, id, cx, from = null) {
    // 番号入力から開いた PR / issue でも、back で戻る先とタブの強調を詳細の種類に合わせる
    this.tab = tabOf(kind);
    this.detail = { kind, id, data: null, error: null, loading: false, expanded: new Set(), from };
    this.loadDetail(cx);
    cx.notify();
  }

  back(cx) {
    this.detail = this.detail?.from ?? null;
    cx.notify();
  }

  // repo の root が分かるまでは引けないので、refresh の完了時にもう一度呼ばれる
  loadDetail(cx) {
    const d = this.detail, view = this.view;
    if (!d || d.loading || !this.root) return;
    const root = this.root, { on } = location();
    // 取得中にサイドバータブや herdr のタブを移っても結果を捨てないよう、詳細がまだ view に残っているかで判定する
    const holds = () => Object.values(view.details).includes(d);
    d.loading = true;
    cx.spawn(async (cx) => {
      try {
        let kind = d.kind;
        if (kind === "file") {
          const text = await readTextFile(`${root}/${d.id}`, { on });
          if (!holds()) return;
          if (text === null) throw new Error(`${d.id} が見つからない`);
          d.data = { text }; d.error = null;
          return;
        }
        if (kind === "number") {
          // issues API は PR も返し、PR なら pull_request を持つ
          const isPr = await gh(["api", `repos/{owner}/{repo}/issues/${d.id}`, "--jq", ".pull_request != null"], root, on);
          kind = isPr.trim() === "true" ? "pr" : "issue";
        }
        const data = kind === "pr" ? await ghJson(["pr", "view", String(d.id), "--json", PR_DETAIL_FIELDS], root, on)
          : kind === "issue" ? await ghJson(["issue", "view", String(d.id), "--json", ISSUE_DETAIL_FIELDS], root, on)
          : await ghJson(["run", "view", String(d.id), "--json", RUN_DETAIL_FIELDS], root, on);
        if (!holds()) return;
        d.kind = kind; d.data = data; d.error = null;
        // 番号から開いた詳細は PR と仮置きしているので、issue と分かったら issue タブへ移す
        const from = Object.keys(view.details).find((k) => view.details[k] === d), to = tabOf(kind);
        if (from !== to) {
          view.details[from] = null; view.details[to] = d;
          if (view.tab === from) view.tab = to;
        }
      } catch (e) { if (holds()) d.error = String(e.message ?? e); }
      finally { d.loading = false; cx.notify(); }
    });
  }

  // 番号だけなら検索せずにその詳細を開く。PR か issue かは loadDetail が見分けるので、どちらのタブで打ってもよい
  submitSearch(tab, cx) {
    const m = this.searchKey(tab).match(/^#?(\d+)$/);
    if (m) this.openDetail("number", Number(m[1]), cx);
    else this.search(tab, cx);
    // tab-issue 命令で検索欄へ移ったときは、入力を終えたら元の terminal へ戻す。戻さないと terminal に打てないまま残る
    if (this.returnPane) { run("pane.focus", { pane: this.returnPane }); this.returnPane = null; }
  }

  open(url) {
    // open の失敗は表示に影響しないが、黙殺はせずログに残す
    exec("open", [url]).then((r) => { if (r.code !== 0) console.log(`open failed: ${r.stderr}`); });
  }

  badge(state, t) {
    const color = { pass: t.ansi2, fail: t.ansi1, pending: t.working, none: t.dim }[state];
    const el = div().w(8).h(8).flex_none().rounded(4).bg(color);
    return state === "pending" ? el.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : el;
  }

  section(title, extra, t) {
    return h_flex().h(30).flex_none().px(12).gap(8).items_center().text_size(12).text_color(t.muted).font_semibold()
      .child(div().child(title)).child(div().flex_1()).when(Boolean(extra), (e) => e.child(extra));
  }

  button(id, label, t, onClick) {
    return div().id(id).px(6).py(1).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover)).child(label).on_click(onClick);
  }

  foldable(id, title, t, content) {
    const expanded = this.detail.expanded;
    const open = expanded.has(id);
    return v_flex()
      .child(h_flex().id(`fold-${id}`).h(30).flex_none().px(12).gap(6).items_center().text_size(12).text_color(t.muted).font_semibold()
        .cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { if (open) expanded.delete(id); else expanded.add(id); cx.notify(); })
        .child(div().w(10).child(open ? "▼" : "▶")).child(div().child(title)))
      .when(open, (e) => e.child(content()));
  }

  empty(text, t) {
    return div().px(16).py(6).text_size(13).text_color(t.dim).child(text);
  }

  // ---- 一覧 ----

  // 検索語があれば検索結果を、無ければ通常の一覧を出す
  shownIssues() { return this.results.issue?.items ?? this.issues; }
  shownPrs() { return this.results.pr?.items ?? this.prs; }
  shownDocs() { return matchDocs(this.docs, this.queries.local); }

  searchBar(tab, t) {
    const r = this.results[tab];
    return h_flex().h(38).flex_none().px(10).gap(6).items_center()
      .child(Input.new(this.searches[tab]).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(r?.loading), (e) => e.child(div().text_size(13).text_color(t.dim).child("…")));
  }

  // 切り替えではなく、押すたびに検索バーを MINE_QUERY に置き換えて引く
  mineButton(tab, t) {
    return div().id(`gh-mine-${tab}`).px(6).py(1).rounded(4).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).child("mine")
      .on_click((_e, cx) => { this.queries[tab] = MINE_QUERY[tab]; this.searches[tab].set_value(MINE_QUERY[tab]); this.search(tab, cx); });
  }

  // 検索結果には closed / merged も混ざるので、open 以外だけ状態を出す
  closedLabel(state, t) {
    return state && state !== "OPEN" ? this.stateLabel(state, t) : null;
  }

  prRow(p, t) {
    const review = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" }[p.reviewDecision];
    return h_flex().id(`pr-${p.number}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("pr", p.number, cx))
      .child(this.badge(p.ci, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(p.isDraft ? t.muted : t.foreground).child(p.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim)
          .child(div().child(`#${p.number}`))
          .when(Boolean(this.closedLabel(p.state, t)), (e) => e.child(this.closedLabel(p.state, t)))
          .when(p.isDraft, (e) => e.child(div().child("draft")))
          .when(Boolean(review), (e) => e.child(div().text_color(review === "approved" ? t.ansi2 : review === "changes" ? t.ansi1 : t.dim).child(review)))
          .child(div().min_w(0).truncate().child(p.headRefName))));
  }

  runRow(r, t) {
    return h_flex().id(`run-${r.databaseId}`).h(32).flex_none().px(10).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("run", r.databaseId, cx))
      .child(this.badge(runState(r), t))
      .child(div().flex_1().min_w(0).truncate().child(r.workflowName))
      .child(div().text_size(12).text_color(t.dim).child(`${r.event} · ${ago(r.createdAt)}`));
  }

  prList(t) {
    const r = this.results.pr, prs = this.shownPrs();
    return v_flex()
      .child(this.searchBar("pr", t))
      .child(this.section(r ? `SEARCH RESULTS (${prs.length})` : `OPEN PULL REQUESTS (${prs.length})`, this.mineButton("pr", t), t))
      .when(Boolean(r?.error), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(r.error)))
      .children(prs.map((p) => this.prRow(p, t)))
      .when(!prs.length && !this.error && !r?.error, (e) => e.child(this.empty(this.loading || r?.loading ? "Loading…" : r ? "No matching pull requests" : "No open pull requests", t)));
  }

  issueRow(i, t) {
    return h_flex().id(`issue-${i.number}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("issue", i.number, cx))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().child(i.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim)
          .child(div().child(`#${i.number}`))
          .when(Boolean(this.closedLabel(i.state, t)), (e) => e.child(this.closedLabel(i.state, t)))
          .child(div().child(ago(i.updatedAt)))
          .child(div().min_w(0).truncate().child(i.labels.map((l) => l.name).join(", ")))));
  }

  issueList(t) {
    const r = this.results.issue, issues = this.shownIssues();
    return v_flex()
      .child(this.searchBar("issue", t))
      .child(this.section(r ? `SEARCH RESULTS (${issues.length})` : `OPEN ISSUES (${issues.length})`, this.mineButton("issue", t), t))
      .when(Boolean(r?.error), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(r.error)))
      .children(issues.map((i) => this.issueRow(i, t)))
      .when(!issues.length && !this.error && !r?.error, (e) => e.child(this.empty(this.loading || r?.loading ? "Loading…" : r ? "No matching issues" : "No open issues", t)));
  }

  runList(t) {
    return v_flex()
      .child(this.section(`RUNS · ${this.branch || "-"}`, null, t))
      .children(this.runs.map((r) => this.runRow(r, t)))
      .when(!this.runs.length && !this.error, (e) => e.child(this.empty(this.loading ? "Loading…" : "No runs on this branch", t)));
  }

  docRow(f, t) {
    const slash = f.path.lastIndexOf("/");
    return v_flex().id(`doc-${f.path}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(2).justify_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("file", f.path, cx))
      .child(div().truncate().child(f.path.slice(slash + 1)))
      .child(h_flex().gap(6).text_size(12).text_color(t.dim)
        .child(div().child(ago(new Date(f.mtime).toISOString())))
        .child(div().min_w(0).truncate().child(f.path.slice(".local/".length, slash + 1))));
  }

  docList(t) {
    const searching = Boolean(this.queries.local.trim()), docs = this.shownDocs();
    return v_flex()
      .child(this.searchBar("local", t))
      .child(this.section(searching ? `MATCHES (${docs.length} / ${this.docs.length})` : `.LOCAL (${docs.length} / ${this.docs.length})`, null, t))
      .when(Boolean(this.docsError), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(this.docsError)))
      .children(docs.map((f) => this.docRow(f, t)))
      .when(!docs.length && !this.docsError, (e) => e.child(this.empty(!this.docsLoaded ? "Loading…" : searching ? "No matching files" : "No markdown under .local", t)));
  }

  // ---- 詳細 ----

  fileDetail(f, t) {
    return div().px(14).pt(10).text_size(13).child(TextView.markdown(`file-${this.detail.id}`, f.text).selectable());
  }

  meta(parts, t) {
    return h_flex().flex_wrap().gap_x(8).gap_y(2).px(14).text_size(12).text_color(t.dim).children(parts.filter(Boolean));
  }

  stateLabel(state, t) {
    const color = { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[state] ?? t.dim;
    return div().px(6).rounded(4).border_1().border_color(color).text_color(color).text_size(11).font_semibold().child(state.toLowerCase());
  }

  description(body, t) {
    const text = plainText(body);
    return v_flex()
      .child(this.section("DESCRIPTION", null, t))
      .child(div().px(14).text_size(13).text_color(text ? t.foreground : t.dim).child(text || "No description"));
  }

  prDetail(p, t) {
    const review = { APPROVED: ["approved", t.ansi2], CHANGES_REQUESTED: ["changes requested", t.ansi1], REVIEW_REQUIRED: ["review required", t.dim] }[p.reviewDecision];
    const reviewState = { APPROVED: t.ansi2, CHANGES_REQUESTED: t.ansi1 };
    const checks = (p.statusCheckRollup ?? []).map((c) => ({ name: c.name || c.context, workflow: c.workflowName, url: c.detailsUrl || c.targetUrl, state: checkState(c) }))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    const people = [
      ...(p.latestReviews ?? []).map((r) => ({ who: r.author?.login, what: r.state.toLowerCase().replace("_", " "), color: reviewState[r.state] ?? t.dim })),
      ...(p.reviewRequests ?? []).map((r) => ({ who: r.login || r.name || r.slug, what: "requested", color: t.dim })),
    ];
    return v_flex().gap(6)
      .child(div().px(14).pt(10).text_size(15).font_semibold().child(p.title))
      .child(this.meta([
        this.stateLabel(p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, t),
        div().child(p.author?.login ?? ""),
        div().min_w(0).truncate().child(`${p.headRefName} → ${p.baseRefName}`),
      ], t))
      .child(this.meta([
        div().text_color(t.ansi2).child(`+${p.additions}`),
        div().text_color(t.ansi1).child(`−${p.deletions}`),
        div().child(`${p.changedFiles} files`),
        div().child(ago(p.createdAt)),
        review && div().text_color(review[1]).child(review[0]),
      ], t))
      .child(this.foldable("reviews", `REVIEWS (${people.length})`, t, () => v_flex()
        .children(people.map((r, i) => h_flex().id(`rv-${i}`).h(24).px(14).gap(8).items_center().text_size(13)
          .child(div().flex_1().min_w(0).truncate().child(r.who ?? "?"))
          .child(div().text_size(12).text_color(r.color).child(r.what))))
        .when(!people.length, (e) => e.child(this.empty("No reviews", t)))))
      .child(this.foldable("checks", `CHECKS (${checks.length})`, t, () => v_flex()
        .children(checks.map((c, i) => h_flex().id(`ck-${i}`).h(30).flex_none().px(10).mx(6).gap(10).items_center().rounded(7)
          .when(Boolean(c.url), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(c.url)))
          .child(this.badge(c.state, t))
          .child(div().flex_1().min_w(0).truncate().child(c.name))
          .when(Boolean(c.workflow), (e) => e.child(div().max_w(120).truncate().text_size(12).text_color(t.dim).child(c.workflow)))))
        .when(!checks.length, (e) => e.child(this.empty("No checks", t)))))
      .child(this.description(p.body, t));
  }

  issueDetail(i, t) {
    return v_flex().gap(6)
      .child(div().px(14).pt(10).text_size(15).font_semibold().child(i.title))
      .child(this.meta([
        this.stateLabel(i.state, t),
        div().child(i.author?.login ?? ""),
        div().child(ago(i.createdAt)),
        i.stateReason && i.state === "CLOSED" && div().child(i.stateReason.toLowerCase().replace("_", " ")),
      ], t))
      .when(i.labels?.length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).px(14)
        .children(i.labels.map((l) => div().px(6).rounded(4).border_1().border_color(`#${l.color}`).text_size(11).child(l.name)))))
      .when(i.assignees?.length > 0, (e) => e.child(this.meta([div().child(`assignees: ${i.assignees.map((a) => a.login).join(", ")}`)], t)))
      .when(i.subIssues?.nodes?.length > 0, (e) => e.child(this.subIssueList(i, t)))
      .child(this.markdownDescription(i, t));
  }

  // 親 issue の本文は長いことが多いので、子の進み具合が埋もれないよう本文より上に置く
  subIssueList(i, t) {
    const subs = i.subIssues.nodes, sum = i.subIssuesSummary;
    return v_flex()
      .child(this.section(`SUB-ISSUES (${sum ? `${sum.completed} / ${sum.total}` : subs.length})`, null, t))
      .children(subs.map((s) => h_flex().id(`sub-${s.number}`).min_h(30).flex_none().px(10).py(3).mx(6).gap(8).items_center().rounded(7)
        .cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.openDetail("issue", s.number, cx, this.detail))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${s.number}`))
        .child(div().flex_1().min_w(0).truncate().text_color(s.state === "OPEN" ? t.foreground : t.dim).child(s.title))
        .when(Boolean(this.closedLabel(s.state, t)), (e) => e.child(this.closedLabel(s.state, t)))));
  }

  markdownDescription(i, t) {
    // issue テンプレートの案内文は HTML コメントで書かれ、描くと本文より目立つので落とす
    const text = (i.body || "").replace(/<!--[\s\S]*?-->/g, "").trim();
    return v_flex()
      .child(this.section("DESCRIPTION", null, t))
      .child(text
        ? div().px(14).text_size(13).child(TextView.markdown(`issue-body-${i.number}`, text).selectable())
        : div().px(14).text_size(13).text_color(t.dim).child("No description"));
  }

  runDetail(r, t) {
    const jobs = (r.jobs ?? []).map((j) => ({ ...j, state: runState(j) })).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    return v_flex().gap(6)
      .child(div().px(14).pt(10).text_size(15).font_semibold().child(r.displayTitle))
      .child(this.meta([
        h_flex().gap(6).items_center().child(this.badge(runState(r), t)).child(div().child(r.conclusion || r.status)),
        div().child(r.workflowName),
        div().child(r.event),
        div().min_w(0).truncate().child(r.headBranch),
        div().child(ago(r.createdAt)),
      ], t))
      .child(this.section(`JOBS (${jobs.length})`, null, t))
      .children(jobs.map((j, i) => {
        const failedSteps = (j.steps ?? []).filter((s) => runState(s) === "fail");
        return v_flex().id(`job-${i}`).flex_none().px(10).py(6).mx(6).gap(3).rounded(7)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(j.url))
          .child(h_flex().gap(10).items_center()
            .child(this.badge(j.state, t))
            .child(div().flex_1().min_w(0).truncate().child(j.name))
            .child(div().text_size(12).text_color(t.dim).child(duration(j.startedAt, j.completedAt))))
          .children(failedSteps.map((s) => div().pl(18).truncate().text_size(12).text_color(t.ansi1).child(`✕ ${s.name}`)));
      }))
      .when(!jobs.length, (e) => e.child(this.empty("No jobs", t)));
  }

  detailView(t) {
    const d = this.detail, data = d.data;
    const label = d.kind === "run" ? (data?.workflowName ?? "run") : d.kind === "file" ? d.id : `#${d.id}`;
    const body = data ? (d.kind === "pr" ? this.prDetail(data, t) : d.kind === "issue" ? this.issueDetail(data, t) : d.kind === "file" ? this.fileDetail(data, t) : this.runDetail(data, t))
      : this.empty(d.error ? "" : "Loading…", t);
    return v_flex()
      .child(h_flex().h(32).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border).text_size(13)
        .child(this.button("gh-back", "← back", t, (_e, cx) => this.back(cx)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label))
        .when(Boolean(data?.url), (e) => e.child(this.button("gh-browser", "open ↗", t, () => this.open(data.url)))))
      .when(Boolean(d.error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(d.error)))
      .child(body);
  }

  tabButton(id, label, active, t) {
    return div().id(`gh-tab-${id}`).px(10).py(3).rounded(6).cursor_pointer().text_size(13).font_semibold()
      .text_color(active ? t.foreground : t.dim).when(active, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
      .child(label).on_click((_e, cx) => { this.tab = id; cx.notify(); });
  }

  render(cx) {
    this.sync(cx);
    const t = theme();

    return v_flex().id("right-sidebar").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(14)
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tabButton("issue", `Issues ${this.shownIssues().length}`, this.tab === "issue", t))
        .child(this.tabButton("pr", `PRs ${this.shownPrs().length}`, this.tab === "pr", t))
        .child(this.tabButton("ci", `CI ${this.runs.length}`, this.tab === "ci", t))
        .child(this.tabButton("local", `.local ${this.shownDocs().length}`, this.tab === "local", t))
        .child(div().flex_1())
        .child(div().text_size(13).text_color(t.muted).child(this.button("gh-reload", this.loading || this.detail?.loading ? "…" : "↻", t, (_e, cx) => this.refresh(cx)))))
      .when(Boolean(this.error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("gh-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .child(this.detail ? this.detailView(t) : this.tab === "pr" ? this.prList(t) : this.tab === "issue" ? this.issueList(t) : this.tab === "local" ? this.docList(t) : this.runList(t)))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.root ? this.root.split("/").pop() : ""))
        .child(div().child(this.updated ? `updated ${new Date(this.updated).toLocaleTimeString()}` : "")));
  }
}

// 一覧・詳細の描画と命令の処理は this.prs や this.tab を読み書きするので、表示中の repo と herdr のタブの状態へ委ねる
for (const f of Object.keys(emptyData())) {
  Object.defineProperty(GhStatus.prototype, f, { get() { return this.data[f]; }, set(v) { this.data[f] = v; } });
}
for (const f of ["tab", "details", "queries", "results"]) {
  Object.defineProperty(GhStatus.prototype, f, { get() { return this.view[f]; }, set(v) { this.view[f] = v; } });
}
