import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, nextCommand } from "herdr";

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

const PR_FIELDS = "number,title,isDraft,headRefName,reviewDecision,statusCheckRollup,url";
const ISSUE_FIELDS = "number,title,labels,updatedAt,url";
// 子 issue は親 issue を追えば辿れるので、自分の担当のうち親を持たないものだけを出す
const ISSUE_SEARCH = "is:open is:issue assignee:@me -has:parent-issue";
const RUN_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,createdAt,url";
const PR_DETAIL_FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,reviewDecision,latestReviews,reviewRequests,statusCheckRollup,additions,deletions,changedFiles,body,url,createdAt";
const RUN_DETAIL_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,headBranch,createdAt,url,jobs";
const ISSUE_DETAIL_FIELDS = "number,title,state,stateReason,author,labels,assignees,body,url,createdAt";
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const tabOf = (kind) => ({ run: "ci", issue: "issue" })[kind] ?? "pr";
const STATE_ORDER = { fail: 0, pending: 1, pass: 2, none: 3 };

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
// パネル幅では Markdown を描けないので、HTML コメント（テンプレートの案内文）とタグを落とした冒頭だけを出す
function excerpt(body) {
  const text = (body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

export default class GhStatus extends View {
  init(_props, cx) {
    this.prs = []; this.issues = []; this.runs = []; this.mine = true;
    this.tab = "issue";
    // { kind: "pr" | "issue" | "run" | "number", id, data, error, loading }。"number" は PR か issue か未判定の番号
    this.detail = null;
    this.jump = InputState.new({ placeholder: "#番号" });
    this.jump.on("submit", (_e, cx) => this.submitJump(cx));
    // herdr の mod 命令は引数を運べないので、番号は命令名に埋める（herdr-app do gh-status.open-1234）
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const m = command.match(/^(open|run)-(\d+)$/);
        if (m) this.openDetail(m[1] === "run" ? "run" : "number", Number(m[2]), cx);
        else if (command === "back") { this.detail = null; cx.notify(); }
        else console.log(`gh-status: unknown command ${command}`);
      }
    });
    this.refresh(cx);
    // gh API のレート制限を食わないよう 60 秒間隔。表示中の repo が変われば render から即時取得する
    cx.timer.every(60000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.prs = []; this.issues = []; this.runs = []; this.error = null;
      // 別 repo の番号を引き直すと別物を表示するので、詳細は閉じる
      this.detail = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        const branch = (await exec("git", ["branch", "--show-current"], { cwd: root, on })).stdout.trim();
        const prArgs = ["pr", "list", "--state", "open", "--limit", "30", "--json", PR_FIELDS, ...(this.mine ? ["--author", "@me"] : [])];
        const [prs, issues, runs] = await Promise.all([
          ghJson(prArgs, root, on),
          ghJson(["issue", "list", "--search", ISSUE_SEARCH, "--limit", "50", "--json", ISSUE_FIELDS], root, on),
          // 条件付き workflow（bot・コメント起動など）の skipped run は何も実行しておらず実際の CI を画面外に押し出すため、多めに取って除いてから 8 件に絞る
          branch ? ghJson(["run", "list", "--branch", branch, "--limit", "40", "--json", RUN_FIELDS], root, on) : Promise.resolve([]),
        ]);
        if (key() !== context) return;
        this.root = root; this.branch = branch; this.error = null;
        this.prs = prs.map((p) => ({ ...p, ci: rollup(p.statusCheckRollup) }));
        this.issues = issues;
        this.runs = runs.filter((r) => r.conclusion !== "skipped").slice(0, 8);
        this.updated = Date.now();
        this.loadDetail(cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  openDetail(kind, id, cx) {
    // 番号入力から開いた PR / issue でも、back で戻る先とタブの強調を詳細の種類に合わせる
    this.tab = tabOf(kind);
    this.detail = { kind, id, data: null, error: null, loading: false, expanded: new Set() };
    this.loadDetail(cx);
    cx.notify();
  }

  // repo の root が分かるまでは引けないので、refresh の完了時にもう一度呼ばれる
  loadDetail(cx) {
    const d = this.detail;
    if (!d || d.loading || !this.root) return;
    const root = this.root, { on } = location();
    d.loading = true;
    cx.spawn(async (cx) => {
      try {
        let kind = d.kind;
        if (kind === "number") {
          // issues API は PR も返し、PR なら pull_request を持つ
          const isPr = await gh(["api", `repos/{owner}/{repo}/issues/${d.id}`, "--jq", ".pull_request != null"], root, on);
          kind = isPr.trim() === "true" ? "pr" : "issue";
        }
        const data = kind === "pr" ? await ghJson(["pr", "view", String(d.id), "--json", PR_DETAIL_FIELDS], root, on)
          : kind === "issue" ? await ghJson(["issue", "view", String(d.id), "--json", ISSUE_DETAIL_FIELDS], root, on)
          : await ghJson(["run", "view", String(d.id), "--json", RUN_DETAIL_FIELDS], root, on);
        if (this.detail !== d) return;
        d.kind = kind; d.data = data; d.error = null;
        this.tab = tabOf(kind);
      } catch (e) { if (this.detail === d) d.error = String(e.message ?? e); }
      finally { d.loading = false; cx.notify(); }
    });
  }

  submitJump(cx) {
    const m = this.jump.value().match(/\d+/);
    if (!m) return;
    this.jump.set_value("");
    this.openDetail("number", Number(m[0]), cx);
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

  prRow(p, t) {
    const review = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" }[p.reviewDecision];
    return h_flex().id(`pr-${p.number}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("pr", p.number, cx))
      .child(this.badge(p.ci, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(p.isDraft ? t.muted : t.foreground).child(p.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim)
          .child(div().child(`#${p.number}`))
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
    const toggle = div().id("gh-mine").px(6).py(1).rounded(4).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).child(this.mine ? "mine" : "all")
      .on_click((_e, cx) => { this.mine = !this.mine; this.refresh(cx); });
    return v_flex()
      .child(this.section(`OPEN PULL REQUESTS (${this.prs.length})`, toggle, t))
      .children(this.prs.map((p) => this.prRow(p, t)))
      .when(!this.prs.length && !this.error, (e) => e.child(this.empty(this.loading ? "Loading…" : "No open pull requests", t)));
  }

  issueRow(i, t) {
    return h_flex().id(`issue-${i.number}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("issue", i.number, cx))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().child(i.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim)
          .child(div().child(`#${i.number}`))
          .child(div().child(ago(i.updatedAt)))
          .child(div().min_w(0).truncate().child(i.labels.map((l) => l.name).join(", ")))));
  }

  issueList(t) {
    return v_flex()
      .child(this.section(`MY ISSUES (${this.issues.length})`, null, t))
      .children(this.issues.map((i) => this.issueRow(i, t)))
      .when(!this.issues.length && !this.error, (e) => e.child(this.empty(this.loading ? "Loading…" : "No open issues assigned to you", t)));
  }

  runList(t) {
    return v_flex()
      .child(this.section(`RUNS · ${this.branch || "-"}`, null, t))
      .children(this.runs.map((r) => this.runRow(r, t)))
      .when(!this.runs.length && !this.error, (e) => e.child(this.empty(this.loading ? "Loading…" : "No runs on this branch", t)));
  }

  // ---- 詳細 ----

  meta(parts, t) {
    return h_flex().flex_wrap().gap_x(8).gap_y(2).px(14).text_size(12).text_color(t.dim).children(parts.filter(Boolean));
  }

  stateLabel(state, t) {
    const color = { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[state] ?? t.dim;
    return div().px(6).rounded(4).border_1().border_color(color).text_color(color).text_size(11).font_semibold().child(state.toLowerCase());
  }

  description(body, t) {
    const text = excerpt(body);
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
      .child(this.description(i.body, t));
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
    const label = d.kind === "run" ? (data?.workflowName ?? "run") : `#${d.id}`;
    const body = data ? (d.kind === "pr" ? this.prDetail(data, t) : d.kind === "issue" ? this.issueDetail(data, t) : this.runDetail(data, t))
      : this.empty(d.error ? "" : "Loading…", t);
    return v_flex()
      .child(h_flex().h(32).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border).text_size(13)
        .child(this.button("gh-back", "← back", t, (_e, cx) => { this.detail = null; cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label))
        .when(Boolean(data?.url), (e) => e.child(this.button("gh-browser", "open ↗", t, () => this.open(data.url)))))
      .when(Boolean(d.error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(d.error)))
      .child(body);
  }

  tabButton(id, label, active, t) {
    return div().id(`gh-tab-${id}`).px(10).py(3).rounded(6).cursor_pointer().text_size(13).font_semibold()
      .text_color(active ? t.foreground : t.dim).when(active, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
      .child(label).on_click((_e, cx) => { this.tab = id; this.detail = null; cx.notify(); });
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();

    return v_flex().id("gh-status").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(14)
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tabButton("issue", `Issues ${this.issues.length}`, this.tab === "issue", t))
        .child(this.tabButton("pr", `PRs ${this.prs.length}`, this.tab === "pr", t))
        .child(this.tabButton("ci", `CI ${this.runs.length}`, this.tab === "ci", t))
        .child(div().flex_1())
        .child(Input.new(this.jump).w(72).h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(13).text_color(t.foreground))
        .child(div().text_size(13).text_color(t.muted).child(this.button("gh-reload", this.loading || this.detail?.loading ? "…" : "↻", t, (_e, cx) => this.refresh(cx)))))
      .when(Boolean(this.error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("gh-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .child(this.detail ? this.detailView(t) : this.tab === "pr" ? this.prList(t) : this.tab === "issue" ? this.issueList(t) : this.runList(t)))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.root ? this.root.split("/").pop() : ""))
        .child(div().child(this.updated ? `updated ${new Date(this.updated).toLocaleTimeString()}` : "")));
  }
}
