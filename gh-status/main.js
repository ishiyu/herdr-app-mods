import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme } from "herdr";

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

const PR_FIELDS = "number,title,isDraft,headRefName,reviewDecision,statusCheckRollup,url";
const RUN_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,createdAt,url";
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// statusCheckRollup は CheckRun（status/conclusion）と StatusContext（state）が混在する
function rollup(checks) {
  if (!checks?.length) return "none";
  let pending = false, passed = false;
  for (const c of checks) {
    const v = (c.conclusion || c.state || "").toUpperCase();
    if (FAILED.has(v)) return "fail";
    if (c.status && c.status !== "COMPLETED") pending = true;
    if (v === "PENDING" || v === "EXPECTED") pending = true;
    if (v === "SUCCESS") passed = true;
  }
  // 全件 SKIPPED / NEUTRAL は「何も検証していない」なので成功扱いにしない
  return pending ? "pending" : passed ? "pass" : "none";
}
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

export default class GhStatus extends View {
  init(_props, cx) {
    this.prs = []; this.runs = []; this.mine = true;
    this.refresh(cx);
    // gh API のレート制限を食わないよう 60 秒間隔。表示中の repo が変われば render から即時取得する
    cx.timer.every(60000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.root = null; this.prs = []; this.runs = []; this.error = null; }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        const branch = (await exec("git", ["branch", "--show-current"], { cwd: root, on })).stdout.trim();
        const gh = async (args) => {
          const r = await exec("gh", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          return JSON.parse(r.stdout);
        };
        const prArgs = ["pr", "list", "--state", "open", "--limit", "30", "--json", PR_FIELDS, ...(this.mine ? ["--author", "@me"] : [])];
        const [prs, runs] = await Promise.all([
          gh(prArgs),
          // 条件付き workflow（bot・コメント起動など）の skipped run は何も実行しておらず実際の CI を画面外に押し出すため、多めに取って除いてから 8 件に絞る
          branch ? gh(["run", "list", "--branch", branch, "--limit", "40", "--json", RUN_FIELDS]) : Promise.resolve([]),
        ]);
        if (key() !== context) return;
        this.root = root; this.branch = branch; this.error = null;
        this.prs = prs.map((p) => ({ ...p, ci: rollup(p.statusCheckRollup) }));
        this.runs = runs.filter((r) => r.conclusion !== "skipped").slice(0, 8);
        this.updated = Date.now();
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
    cx.notify();
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
    return h_flex().h(30).flex_none().px(12).gap(8).items_center().text_size(11).text_color(t.muted).font_semibold()
      .child(div().child(title)).child(div().flex_1()).when(Boolean(extra), (e) => e.child(extra));
  }

  prRow(p, t) {
    const review = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" }[p.reviewDecision];
    return h_flex().id(`pr-${p.number}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(p.url))
      .child(this.badge(p.ci, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(p.isDraft ? t.muted : t.foreground).child(p.title))
        .child(h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().child(`#${p.number}`))
          .when(p.isDraft, (e) => e.child(div().child("draft")))
          .when(Boolean(review), (e) => e.child(div().text_color(review === "approved" ? t.ansi2 : review === "changes" ? t.ansi1 : t.dim).child(review)))
          .child(div().min_w(0).truncate().child(p.headRefName))));
  }

  runRow(r, t) {
    return h_flex().id(`run-${r.databaseId}`).h(32).flex_none().px(10).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(r.url))
      .child(this.badge(runState(r), t))
      .child(div().flex_1().min_w(0).truncate().child(r.workflowName))
      .child(div().text_size(11).text_color(t.dim).child(`${r.event} · ${ago(r.createdAt)}`));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const toggle = div().id("gh-mine").px(6).py(1).rounded(4).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).child(this.mine ? "mine" : "all")
      .on_click((_e, cx) => { this.mine = !this.mine; this.refresh(cx); });
    const reload = div().id("gh-reload").px(6).py(1).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
      .child(this.loading ? "…" : "↻").on_click((_e, cx) => this.refresh(cx));
    const empty = (text) => div().px(16).py(6).text_size(12).text_color(t.dim).child(text);

    return v_flex().id("gh-status").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("PR / CI"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.root ? this.root.split("/").pop() : ""))
        .child(div().text_size(12).text_color(t.muted).child(reload)))
      .when(Boolean(this.error), (e) => e.child(div().px(14).py(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("gh-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .child(this.section(`PULL REQUESTS (${this.prs.length})`, toggle, t))
        .children(this.prs.map((p) => this.prRow(p, t)))
        .when(!this.prs.length && !this.error, (e) => e.child(empty(this.loading ? "Loading…" : "No open pull requests")))
        .child(this.section(`RUNS · ${this.branch || "-"}`, null, t))
        .children(this.runs.map((r) => this.runRow(r, t)))
        .when(!this.runs.length && !this.error, (e) => e.child(empty(this.loading ? "Loading…" : "No runs on this branch"))))
      .child(h_flex().h(26).flex_none().px(14).items_center().border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child(this.updated ? `updated ${new Date(this.updated).toLocaleTimeString()}` : ""));
  }
}
