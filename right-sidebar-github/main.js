import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { focused, theme, props, run } from "herdr";
import { Panel, delegate, location, gh, ghJson, ago, STATE_ORDER } from "./common.js";

const PR_FIELDS = "number,title,state,isDraft,headRefName,reviewDecision,statusCheckRollup,url";
const ISSUE_FIELDS = "number,title,state,labels,updatedAt,url";
const PR_DETAIL_FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,reviewDecision,latestReviews,reviewRequests,statusCheckRollup,additions,deletions,changedFiles,body,url,createdAt";
const ISSUE_DETAIL_FIELDS = "number,title,state,stateReason,author,labels,assignees,body,url,createdAt,subIssues,subIssuesSummary";
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const TABS = ["issue", "pr"];
// 打つたびに gh を呼ぶとレート制限を食うので、入力が止まってから引く
const SEARCH_DEBOUNCE_MS = 400;
// 各タブの初期の検索条件で、mine ボタンが検索バーに入れる条件。
// issue の子は親 issue を追えば辿れるので、自分の担当のうち親を持たないものだけを出す
const MINE_QUERY = { issue: "is:open assignee:@me -has:parent-issue", pr: "is:open author:@me" };

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
// PR の本文は HTML コメント（テンプレートの案内文）とタグを落とした素のテキストで出す
function plainText(body) {
  return (body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export default class GitHubPanel extends Panel {
  get panel() { return "github"; }

  emptyData() { return { prs: [], issues: [] }; }

  // 詳細は { kind: "pr" | "issue" | "number", id, data, error, loading }。"number" は PR か issue か未判定の番号。
  // 検索欄は herdr のタブごとに使い分けるので、検索語（queries）と検索結果（results）も view に持つ。
  // results は { key, items, loading, error } で、key（検索語）が queries と食い違えば引き直す。
  // 検索語は repo をまたいで持ち越し、repo を移ったら移った先で引き直す
  emptyView(context, previous) {
    return {
      context, tab: "issue", details: { issue: null, pr: null },
      queries: previous?.queries ?? { issue: MINE_QUERY.issue, pr: MINE_QUERY.pr }, results: { issue: null, pr: null },
    };
  }

  // 未判定の番号は PR と仮置きし、issue と分かったら loadDetail が issue タブへ移す
  tabOf(kind) { return kind === "issue" ? "issue" : "pr"; }

  setup(_cx) {
    // 入力欄は全 herdr タブで共有し、herdr のタブを移るたびに移った先の view の検索語を入れ直す
    this.searches = {
      issue: InputState.new({ placeholder: "issue を検索（#番号で詳細を開く）", value: MINE_QUERY.issue }),
      pr: InputState.new({ placeholder: "PR を検索（#番号で詳細を開く）", value: MINE_QUERY.pr }),
    };
    for (const tab of TABS) {
      this.searches[tab].on("change", (_e, cx) => {
        const value = this.searches[tab].value();
        // herdr のタブを移って入れ直したときの change は、検索語が変わっていないので何もしない
        if (value === this.queries[tab]) return;
        this.queries[tab] = value;
        this.search(tab, cx, { debounce: true });
      });
      this.searches[tab].on("submit", (_e, cx) => this.submitSearch(tab, cx));
    }
    // 常駐しているときに奪うと terminal へ打てなくなるので、ダイアログで開いたときだけ検索欄へ移す
    if (props()?.overlay) this.searches.issue.focus();
  }

  // herdr の mod 命令は引数を運べないので、番号は命令名に埋めてある（herdr-app do right-sidebar.open-1234）
  command(command, cx) {
    const open = command.match(/^open-(\d+)$/), tab = command.match(/^tab-(issue|pr)$/);
    if (open) this.openDetail("number", Number(open[1]), cx);
    else if (tab) this.selectTab(tab[1], cx);
    else if (command === "back") this.back(cx);
    else console.log(`right-sidebar-github: unknown command ${command}`);
  }

  switched(cx) { this.loadQueries(cx); }
  returned(cx) { this.ensureSearches(cx, { inRender: true }); }
  loaded(cx) { this.ensureSearches(cx); }

  async load(entry, on) {
    const [prs, issues] = await Promise.all([
      ghJson(["pr", "list", "--state", "open", "--limit", "30", "--json", PR_FIELDS], entry.root, on),
      ghJson(["issue", "list", "--state", "open", "--limit", "50", "--json", ISSUE_FIELDS], entry.root, on),
    ]);
    entry.prs = prs.map((p) => ({ ...p, ci: rollup(p.statusCheckRollup) }));
    entry.issues = issues;
  }

  async fetchDetail(d, root, on) {
    let kind = d.kind;
    if (kind === "number") {
      // issues API は PR も返し、PR なら pull_request を持つ
      const isPr = await gh(["api", `repos/{owner}/{repo}/issues/${d.id}`, "--jq", ".pull_request != null"], root, on);
      kind = isPr.trim() === "true" ? "pr" : "issue";
    }
    const data = kind === "pr" ? await ghJson(["pr", "view", String(d.id), "--json", PR_DETAIL_FIELDS], root, on)
      : await ghJson(["issue", "view", String(d.id), "--json", ISSUE_DETAIL_FIELDS], root, on);
    return { kind, data };
  }

  searchKey(tab) {
    return this.queries[tab].trim();
  }

  // render 中に入力欄を書き換えると描画が入れ子になるので、spawn に回す
  loadQueries(cx) {
    const view = this.view;
    cx.spawn(async () => {
      if (this.view !== view) return;
      for (const tab of TABS) {
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
    for (const tab of TABS) {
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

  // 番号だけなら検索せずにその詳細を開く。PR か issue かは fetchDetail が見分けるので、どちらのタブで打ってもよい
  submitSearch(tab, cx) {
    const m = this.searchKey(tab).match(/^#?(\d+)$/);
    if (m) this.openDetail("number", Number(m[1]), cx);
    else this.search(tab, cx);
    // tab-issue 命令で検索欄へ移ったときは、入力を終えたら元の terminal へ戻す。戻さないと terminal に打てないまま残る
    if (this.returnPane) { run("pane.focus", { pane: this.returnPane }); this.returnPane = null; }
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

  // ---- 一覧 ----

  // 検索語があれば検索結果を、無ければ通常の一覧を出す
  shownIssues() { return this.results.issue?.items ?? this.issues; }
  shownPrs() { return this.results.pr?.items ?? this.prs; }

  searchBar(tab, t) {
    const r = this.results[tab];
    return h_flex().h(38).flex_none().px(10).gap(6).items_center()
      .child(Input.new(this.searches[tab]).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(r?.loading), (e) => e.child(div().text_size(13).text_color(t.dim).child("…")))
      .child(this.mineButton(tab, t));
  }

  // 切り替えではなく、押すたびに検索バーを MINE_QUERY に置き換えて引く
  mineButton(tab, t) {
    // 検索欄の隣に並ぶので、高さを検索欄（26）に揃える
    return h_flex().id(`mine-${tab}`).h(26).px(8).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).child("mine")
      .on_click((_e, cx) => { this.queries[tab] = MINE_QUERY[tab]; this.searches[tab].set_value(MINE_QUERY[tab]); this.search(tab, cx); });
  }

  stateLabel(state, t) {
    const color = { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[state] ?? t.dim;
    return div().px(6).rounded(4).border_1().border_color(color).text_color(color).text_size(11).font_semibold().child(state.toLowerCase());
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

  prList(t) {
    const r = this.results.pr, prs = this.shownPrs();
    return v_flex()
      .child(this.searchBar("pr", t))
      .child(this.section(r ? `SEARCH RESULTS (${prs.length})` : `OPEN PULL REQUESTS (${prs.length})`, this.reloadButton(t), t))
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
      .child(this.section(r ? `SEARCH RESULTS (${issues.length})` : `OPEN ISSUES (${issues.length})`, this.reloadButton(t), t))
      .when(Boolean(r?.error), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(r.error)))
      .children(issues.map((i) => this.issueRow(i, t)))
      .when(!issues.length && !this.error && !r?.error, (e) => e.child(this.empty(this.loading || r?.loading ? "Loading…" : r ? "No matching issues" : "No open issues", t)));
  }

  // ---- 詳細 ----

  detailLabel(d) { return `#${d.id}`; }

  detailBody(d, t) { return d.kind === "pr" ? this.prDetail(d.data, t) : this.issueDetail(d.data, t); }

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

  render(cx) {
    this.begin(cx);
    const t = theme();
    return this.frame(t,
      this.switcher([["issue", `Issues ${this.shownIssues().length}`], ["pr", `PRs ${this.shownPrs().length}`]], t),
      () => (this.tab === "pr" ? this.prList(t) : this.issueList(t)));
  }
}

delegate(GitHubPanel, "data", ["prs", "issues", "error", "loading"]);
delegate(GitHubPanel, "view", ["tab", "queries", "results"]);
