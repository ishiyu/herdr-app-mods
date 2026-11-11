// project の thread の一覧。bin/open が coordinator の右の pane に props { project: <project のフォルダ> } で開く。
// thread の記録（threads/<id>/thread.json・status.json）と hc の terminal の状態を合わせて、選んだタブの thread を見出しごとに並べる。

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, props, run, theme, readTextFile, openOverlay } from "herdr";
import * as fs from "fs/promises";
import { GROUPS, TABS, tabOf, tabColorOf, tabCountsOf, tabLabel, rowsOf, signatureOf, unreadThreadIds, contextLabel, umbrellaLabel, age } from "./state.js";

// 見出しの印の色（theme() の色の名前）
const COLOR = {
  "許可待ち": "blocked",
  "エラー": "blocked",
  "あなた待ち": "blocked",
  "行き詰まり": "blocked",
  "作業中": "working",
  "待機中": "working",
  "未報告": "idle",
  "報告済み": "done",
  "停止": "dim",
};

export default class ProjectThreads extends View {
  init(_props, cx) {
    this.project = props()?.project ?? null;
    this.threads = [];
    this.error = null;
    this.signature = null;
    this.loading = false;
    this.again = false;
    this.retrying = false;
    this.hovered = null;
    // 選んだタブ。threads/ を読み直しても変えない
    this.tab = TABS[0];
    // project.json の umbrella（bin/umbrella が書く）。ヘッダに出す
    this.umbrella = "";
    this.umbrellaError = null;
    // 経過時間の表示を進める。umbrella の登録は project.json を書くだけで terminal の変化を伴わないので、ここで読み直す
    cx.timer.every(30000, (cx) => {
      this.readUmbrella(cx);
      cx.notify();
    });
    this.readUmbrella(cx);
  }

  readUmbrella(cx) {
    if (!this.project) return;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${this.project}/project.json`);
        this.umbrella = text === null ? "" : umbrellaLabel(JSON.parse(text));
        this.umbrellaError = null;
      } catch (e) {
        this.umbrellaError = String(e);
      }
      cx.notify();
    });
  }

  // threads/ を読み直す。読んでいる間に次の変化が来たら、終わってからもう一度読む
  reload(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      do {
        this.again = false;
        try {
          this.threads = await this.read();
          this.error = null;
        } catch (e) {
          this.error = String(e);
        }
      } while (this.again);
      this.loading = false;
      cx.notify();
    });
  }

  async read() {
    const dir = `${this.project}/threads`;
    const ids = (await fs.readdir(dir)).filter((name) => /^t\d+$/.test(name)).sort();
    const threads = [];
    for (const id of ids) {
      // bin/start は terminal を起動してから thread.json を書くので、書かれるまでは出さない
      const meta = await readTextFile(`${dir}/${id}/thread.json`);
      if (meta === null) continue;
      const report = await readTextFile(`${dir}/${id}/status.json`);
      threads.push({ ...JSON.parse(meta), report: report === null ? null : JSON.parse(report) });
    }
    return threads;
  }

  render(cx) {
    const t = theme();
    const frame = () => v_flex().size_full().min_h(0).bg(t.surface).text_size(13).text_color(t.foreground);
    if (!this.project) return frame().p(12).text_color(t.muted).child("props に project（project のフォルダ）がありません");

    // thread の起動・報告・追加の依頼はどれも terminal の増減かラベルの変化を伴うので、それをきっかけに読み直す
    const all = terminals();
    const signature = signatureOf(this.project, all);
    if (signature !== this.signature) {
      this.signature = signature;
      this.reload(cx);
    }
    // thread.json の書き込みは terminal の変化を伴わないので、記録の無い thread の terminal があるうちは時間をおいて読み直す
    if (!this.loading && !this.retrying && unreadThreadIds(this.project, all, this.threads).length) {
      this.retrying = true;
      cx.timer.after(1000, (cx) => {
        this.retrying = false;
        this.reload(cx);
      });
    }

    const now = Date.now();
    const rows = rowsOf(this.threads, all);

    const button = (id, label, onClick) => div()
      .id(id)
      .flex_none()
      .px(6)
      .h(20)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(11)
      .text_color(t.muted)
      .bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick();
      })
      .child(label);

    const row = ({ thread, terminal, summary }) => {
      const since = Date.parse(thread.report?.at ?? thread.startedAt);
      // 止まった thread にも出す。続きを同じ thread に頼むかの手がかりになる
      const meta = [thread.model, contextLabel(thread.report?.contextTokens), age(now - since)].filter(Boolean).join(" · ");
      const hovered = this.hovered === thread.id && terminal !== null;
      return v_flex()
        .id(`thread-${thread.id}`)
        .flex_none()
        .px(8)
        .py(6)
        .gap(3)
        .rounded(8)
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = thread.id;
          else if (this.hovered === thread.id) this.hovered = null;
          cx.notify();
        })
        .when(terminal !== null, (el) => el.cursor_pointer().on_click(() => run("terminal.peek", { terminal: terminal.address })))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_color(t.dim).child(thread.id))
          .child(div().flex_1().min_w(0).truncate().text_color(terminal === null ? t.muted : t.foreground).child(thread.title))
          .when(hovered, (el) => el
            .child(button(`keep-${thread.id}`, "タブで開く", () => run("terminal.keep", { terminal: terminal.address, place: "tab" })))
            .child(button(`kill-${thread.id}`, "停止", () => openOverlay({
              mod: "confirm",
              kind: "dialog",
              props: {
                title: `${thread.id} を停止しますか`,
                detail: "thread の claude を終わらせます。coordinator に続きを頼めば、同じ会話から再開します。",
                command: { name: "terminal.kill", args: { terminal: terminal.address } },
              },
            }))))
          .when(!hovered, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta))))
        .when(Boolean(summary), (el) => el.child(div().text_size(12).text_color(t.muted).child(summary)));
    };

    const counts = tabCountsOf(rows);
    // タブは行の題名（13）より大きくして見出しとして読ませ、タブごとの色で塗り分ける。
    // 選んだタブは色を薄く敷いて枠を付け、選んでいないタブは文字の色だけにする。0 件のタブは控えめにする
    const tabBar = h_flex().flex_none().flex_wrap().px(8).pb(6).gap(4).items_center()
      .children(TABS.map((tab) => {
        const on = this.tab === tab;
        const color = t[tabColorOf(tab)];
        return h_flex().id(`tab-${tab}`).h(30).px(10).flex_none().items_center().rounded(7)
          .border(1).border_color(on ? color : t.surface)
          .text_size(14).font_semibold().bg(on ? color + "26" : t.surface)
          .text_color(on || counts[tab] > 0 ? color : t.dim)
          .cursor_pointer()
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => {
            this.tab = tab;
            cx.notify();
          })
          .child(div().child(tabLabel(tab, counts[tab])));
      }));

    const section = (group) => {
      const mine = rows.filter((r) => r.group === group);
      if (!mine.length) return [];
      return [
        h_flex().flex_none().px(8).pt(10).pb(2).gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().size(7).flex_none().rounded(4).bg(t[COLOR[group]]))
          .child(div().child(group))
          .child(div().child(String(mine.length))),
        ...mine.map(row),
      ];
    };

    return frame()
      .child(h_flex().flex_none().h(31).px(12).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`Threads · ${this.project.split("/").pop()}`))
        .child(div().flex_none().child(String(rows.length))))
      .when(this.umbrella !== "", (el) => el.child(div().flex_none().px(12).pb(4).truncate().text_size(11.5).text_color(t.muted).child(this.umbrella)))
      .when(this.umbrellaError !== null, (el) => el.child(div().flex_none().px(12).pb(4).text_size(12).text_color(t.blocked).child(`project.json を読めません: ${this.umbrellaError}`)))
      .child(tabBar)
      .when(this.error !== null, (el) => el.child(div().flex_none().px(12).py(6).text_size(12).text_color(t.blocked).child(`threads を読めません: ${this.error}`)))
      .when(this.error === null && !rows.length, (el) => el.child(div().px(12).py(6).text_color(t.muted).child("thread はまだありません")))
      .when(rows.length > 0 && counts[this.tab] === 0, (el) => el.child(div().px(12).py(6).text_color(t.muted).child(`${this.tab}の thread はありません`)))
      .child(v_flex().id("thread-list").flex_1().min_h(0).px(4).pb(12).overflow_y_scrollbar()
        .children(GROUPS.filter((group) => tabOf(group) === this.tab).flatMap(section)));
  }
}
