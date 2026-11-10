import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { Panel, delegate, ghJson, ago, STATE_ORDER } from "./common.js";

const RUN_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,createdAt,url";
const RUN_DETAIL_FIELDS = "databaseId,status,conclusion,workflowName,displayTitle,event,headBranch,createdAt,url,jobs";

// run と job は小文字の status / conclusion を持つ
function runState(r) {
  if (r.status !== "completed") return "pending";
  if (r.conclusion === "success") return "pass";
  if (r.conclusion === "skipped" || r.conclusion === "neutral") return "none";
  return "fail";
}
// 実行中の job は completedAt がゼロ値（0001-01-01）で返る
function duration(start, end) {
  if (!start || start.startsWith("0001")) return "";
  const stop = !end || end.startsWith("0001") ? Date.now() : Date.parse(end);
  const s = Math.max(0, Math.round((stop - Date.parse(start)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default class CiPanel extends Panel {
  get panel() { return "ci"; }

  emptyData() { return { branch: null, runs: [] }; }

  // 詳細は { kind: "run", id, data, error, loading }
  emptyView(context) { return { context, tab: "ci", details: { ci: null } }; }

  tabOf() { return "ci"; }

  // herdr の mod 命令は引数を運べないので、run id は命令名に埋めてある（herdr-app do right-sidebar.run-1234）
  command(command, cx) {
    const m = command.match(/^run-(\d+)$/);
    if (m) this.openDetail("run", Number(m[1]), cx);
    else if (command === "back") this.back(cx);
    else console.log(`right-sidebar-ci: unknown command ${command}`);
  }

  async load(entry, on) {
    const branch = (await exec("git", ["branch", "--show-current"], { cwd: entry.root, on })).stdout.trim();
    // 条件付き workflow（bot・コメント起動など）の skipped run は何も実行しておらず実際の CI を画面外に押し出すため、多めに取って除いてから 8 件に絞る
    const runs = branch ? await ghJson(["run", "list", "--branch", branch, "--limit", "40", "--json", RUN_FIELDS], entry.root, on) : [];
    entry.branch = branch;
    entry.runs = runs.filter((r) => r.conclusion !== "skipped").slice(0, 8);
  }

  async fetchDetail(d, root, on) {
    return { data: await ghJson(["run", "view", String(d.id), "--json", RUN_DETAIL_FIELDS], root, on) };
  }

  runRow(r, t) {
    return h_flex().id(`run-${r.databaseId}`).h(32).flex_none().px(10).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("run", r.databaseId, cx))
      .child(this.badge(runState(r), t))
      .child(div().flex_1().min_w(0).truncate().child(r.workflowName))
      .child(div().text_size(12).text_color(t.dim).child(`${r.event} · ${ago(r.createdAt)}`));
  }

  runList(t) {
    return v_flex()
      .child(this.section(`RUNS · ${this.branch || "-"}`, this.reloadButton(t), t))
      .children(this.runs.map((r) => this.runRow(r, t)))
      .when(!this.runs.length && !this.error, (e) => e.child(this.empty(this.loading ? "Loading…" : "No runs on this branch", t)));
  }

  detailLabel(d) { return d.data?.workflowName ?? "run"; }

  detailBody(d, t) {
    const r = d.data;
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

  render(cx) {
    this.begin(cx);
    const t = theme();
    return this.frame(t, null, () => this.runList(t));
  }
}

delegate(CiPanel, "data", ["branch", "runs", "error", "loading"]);
