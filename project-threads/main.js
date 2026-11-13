// project の thread の一覧。bin/open が coordinator の右の pane に props { project: <project のフォルダ> } で開く。
// thread の記録（threads/<id>/thread.json・status.json・question.md）と hc の terminal の状態を合わせて、選んだタブの thread を見出しごとに並べる。
// 行を押すと、thread の質問か最後の報告をこの pane の中で開く（あなた待ち・行き詰まり・terminal の無い行）か、thread の画面を重ねて開く（ほかの行）。

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { terminals, props, run, theme, readTextFile, openOverlay, home, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { GROUPS, TABS, tabOf, tabColorOf, tabCountsOf, tabLabel, rowsOf, signatureOf, unreadThreadIds, threadsChanged, contextLabel, umbrellaLabel, rulesOf, policyReposOf, policyCount, policyLabel, age, hasQuestion, questionCount, questionTitleOf, questionLabel, opensDetail, detailKindOf, reportSummaryText, textKey } from "./state.js";

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
    // project が扱う repo ごとの、自律的にやってよいこと・確認すること（<repo>/.local/hc-projects/repo-rules.md）。
    // ヘッダの「方針」で開閉する。全 project 共通の決まり（~/.config/project-threads/rules.md）は出さない
    this.policies = [];
    this.policyError = null;
    this.policyOpen = false;
    // pane の中で開いている詳細。{ id: thread の id, want: "question" | "report"（user が選んだ側）, sawQuestion: 質問を出したか }。
    // null なら一覧を出す
    this.detail = null;
    // 詳細に出す最後の報告の写し（status.json の detail が指すファイル）。写しは書いた後に変わらないので、パスごとに 1 回読む
    this.reportText = { path: null, text: null, error: null };
    this.watchError = null;
    // 経過時間の表示を進める。umbrella の登録と方針の欄の書き換えはファイルを書くだけで terminal の変化を伴わないので、ここで読み直す
    cx.timer.every(30000, (cx) => {
      this.readUmbrella(cx);
      this.readPolicy(cx);
      cx.notify();
    });
    this.readUmbrella(cx);
    this.readPolicy(cx);
    this.watchThreads(cx);
  }

  // 質問は coordinator が Write で書き、回答済みにすると bin/close-question が移す。どちらも terminal の変化を伴わない
  // ことがある（coordinator が書くのは報告のラベルが付いた後）。bin/cleanup が thread のフォルダを .deleted/ へ移すのは
  // terminal を消した後なので、移動を terminal の変化では拾えない。threads/ を監視して読み直す
  watchThreads(cx) {
    if (!this.project) return;
    cx.spawn(async (cx) => {
      for (;;) {
        let changed;
        try {
          changed = await watchFolder(`${this.project}/threads`);
        } catch (e) {
          // 監視が止まると、質問の書き込みと片付けが次の thread の報告まで一覧に出ない。黙って止めず一覧に出す
          this.watchError = String(e);
          cx.notify();
          return;
        }
        if (threadsChanged(this.project, changed)) this.reload(cx);
      }
    });
  }

  // 詳細に出す最後の報告の写しを読む。読み終えたら描き直す
  loadReportText(path, cx) {
    if (this.reportText.path === path) return;
    this.reportText = { path, text: null, error: null };
    cx.spawn(async (cx) => {
      let next;
      try {
        const text = await readTextFile(path);
        next = { path, text, error: text === null ? `${path} がありません` : null };
      } catch (e) {
        next = { path, text: null, error: String(e) };
      }
      // 読んでいる間に別の thread の詳細へ移っていたら捨てる
      if (this.reportText.path === path) this.reportText = next;
      cx.notify();
    });
  }

  readPolicy(cx) {
    if (!this.project) return;
    cx.spawn(async (cx) => {
      try {
        // 扱う repo は thread の worktrees.txt から知る。片付けた thread の記録も見る（片付けの後も同じ repo を扱うため）
        const texts = [];
        for (const dir of [`${this.project}/threads`, `${this.project}/threads/.deleted`]) {
          let ids = [];
          try {
            ids = (await fs.readdir(dir)).filter((name) => /^t\d+$/.test(name));
          } catch {
            continue; // thread をまだ起動していない・片付けていない project には無い
          }
          for (const id of ids) texts.push(await readTextFile(`${dir}/${id}/worktrees.txt`));
        }
        const policies = [];
        for (const repo of policyReposOf(this.project, texts)) {
          policies.push({ repo, ...rulesOf(await readTextFile(`${repo}/.local/hc-projects/repo-rules.md`)) });
        }
        this.policies = policies;
        this.policyError = null;
      } catch (e) {
        this.policyError = String(e);
      }
      cx.notify();
    });
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
      // 未回答の質問。無ければ null
      const question = await readTextFile(`${dir}/${id}/question.md`);
      threads.push({ ...JSON.parse(meta), report: report === null ? null : JSON.parse(report), question });
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
        onClick(cx);
      })
      .child(label);

    const peek = (terminal) => run("terminal.peek", { terminal: terminal.address });
    const openDetail = (thread, cx) => {
      this.detail = { id: thread.id, want: "question", sawQuestion: false };
      // 行が描かれなくなると離れた知らせが来ないので、一覧に戻ったときにボタンが出たままにならないよう外す
      this.hovered = null;
      cx.notify();
    };

    const row = ({ thread, terminal, group, summary }) => {
      const since = Date.parse(thread.report?.at ?? thread.startedAt);
      // 止まった thread にも出す。続きを同じ thread に頼むかの手がかりになる
      const meta = [thread.model, contextLabel(thread.report?.contextTokens), age(now - since)].filter(Boolean).join(" · ");
      const hovered = this.hovered === thread.id && terminal !== null;
      const detailFirst = opensDetail(group, terminal);
      const question = hasQuestion(thread);
      // 質問があれば、報告の要約より質問の一言を出す（user が答えるのは質問のほう）
      const note = question ? questionTitleOf(thread.question) : summary;
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
        .when(detailFirst || terminal !== null, (el) => el.cursor_pointer().on_click((_e, cx) => {
          if (detailFirst) openDetail(thread, cx);
          else peek(terminal);
        }))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_color(t.dim).child(thread.id))
          .when(question, (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(t.blocked).child("質問")))
          .child(div().flex_1().min_w(0).truncate().text_color(terminal === null ? t.muted : t.foreground).child(thread.title))
          .when(hovered, (el) => el
            // 押したときに開かなかった側（画面か詳細）を、ボタンで開けるようにする
            .child(detailFirst
              ? button(`peek-${thread.id}`, "画面", () => peek(terminal))
              : button(`detail-${thread.id}`, "詳細", (cx) => openDetail(thread, cx)))
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
        .when(Boolean(note), (el) => el.child(div().text_size(12).text_color(question ? t.foreground : t.muted).child(note)));
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

    // 方針の欄。開いたときだけ出す。長くなっても一覧を押し出しきらないよう、高さを抑えてスクロールさせる
    const policyItems = (label, color, items) => items.length ? [
      div().flex_none().pt(4).text_size(11).text_color(color).child(label),
      ...items.map((item) => h_flex().flex_none().gap(6).items_start().text_size(12).text_color(t.foreground)
        .child(div().flex_none().text_color(t.dim).child("・"))
        .child(div().flex_1().min_w(0).child(item))),
    ] : [];
    const policyTotal = policyCount(this.policies);
    const tilde = (path) => (path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path);
    const policyPanel = () => v_flex().id("policy").flex_none().max_h(220).mx(8).mb(6).px(8).py(6).gap(2).rounded(6).bg(t.raised)
      .overflow_y_scrollbar()
      .children(this.policyError !== null
        ? [div().text_size(12).text_color(t.blocked).child(`方針を読めません: ${this.policyError}`)]
        : this.policies.flatMap((p, i) => [
          h_flex().flex_none().pt(i ? 8 : 0).gap(6).items_center()
            .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.muted).child(p.repo.split("/").pop()))
            .when(p.allow.length + p.confirm.length === 0, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
              .child(`未設定（${tilde(p.repo)}/.local/hc-projects/repo-rules.md）`))),
          ...policyItems("やってよい", t.ansi2, p.allow),
          ...policyItems("確認する", t.blocked, p.confirm),
        ]));

    // pane の中で開いた詳細。質問か最後の報告の写しを Markdown で描き、長ければこの中でスクロールする。
    // 一覧のタブと行の代わりに出し、「← 一覧」で戻る。片付けで thread が消えたら一覧に戻す
    const detailRow = this.detail === null ? null : rows.find((r) => r.thread.id === this.detail.id) ?? null;
    if (detailRow === null) this.detail = null;
    const pill = (id, label, on, onClick) => div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(5)
      .text_size(12).font_semibold().text_color(on ? t.foreground : t.dim).bg(on ? t.raised : t.surface)
      .when(!on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => {
        onClick();
        cx.notify();
      }))
      .child(label);
    const detailView = ({ thread, terminal }) => {
      const d = this.detail;
      const question = hasQuestion(thread);
      if (question) d.sawQuestion = true;
      const report = typeof thread.report?.detail === "string";
      const kind = detailKindOf(thread, d.want);
      if (kind === "report") this.loadReportText(thread.report.detail, cx);
      const text = kind === "question" ? thread.question
        : kind === "report" ? (this.reportText.path === thread.report.detail ? this.reportText.text : null)
          : reportSummaryText(thread.report);
      const error = kind === "report" && this.reportText.path === thread.report.detail ? this.reportText.error : null;
      const reportLabel = thread.report ? `最後の報告（${thread.report.status}）` : "最後の報告";
      return [
        h_flex().flex_none().h(31).px(8).gap(6).items_center().border_t(1).border_color(t.raised)
          .child(button("detail-back", "← 一覧", (cx) => {
            this.detail = null;
            cx.notify();
          }))
          .child(div().flex_none().text_color(t.dim).child(thread.id))
          .child(div().flex_1().min_w(0).truncate().text_color(terminal === null ? t.muted : t.foreground).child(thread.title))
          .when(terminal !== null, (el) => el.child(button("detail-peek", "画面", () => peek(terminal)))),
        h_flex().flex_none().px(8).pb(4).gap(4).items_center()
          .when(question, (el) => el.child(pill("detail-question", "質問", kind === "question", () => { d.want = "question"; })))
          .when(report || !question, (el) => el.child(pill("detail-report", reportLabel, kind !== "question", () => { d.want = "report"; })))
          .when(thread.report?.at !== undefined && kind !== "question", (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(age(now - Date.parse(thread.report.at)))))
          .when(kind === "question", (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(`答えは coordinator に「${thread.id} は A」のように`))),
        ...(d.sawQuestion && !question
          ? [div().flex_none().px(12).pb(4).text_size(12).text_color(t.muted).child(`質問は回答済みになりました（threads/${thread.id}/questions/ に残っています）`)]
          : []),
        ...(error !== null ? [div().flex_none().px(12).pb(4).text_size(12).text_color(t.blocked).child(`報告の詳細を読めません: ${error}`)] : []),
        v_flex().id("detail-body").flex_1().min_h(0).overflow_y_scrollbar()
          .child(text === null
            ? div().px(12).py(6).text_color(t.muted).child(error === null ? "読み込み中…" : "")
            : div().px(12).pt(4).pb(16).text_size(13).child(TextView.markdown(`${kind}-${thread.id}-${textKey(text)}`, text).selectable())),
      ];
    };
    const listView = () => [
      tabBar,
      ...(this.error !== null ? [div().flex_none().px(12).py(6).text_size(12).text_color(t.blocked).child(`threads を読めません: ${this.error}`)] : []),
      ...(this.error === null && !rows.length ? [div().px(12).py(6).text_color(t.muted).child("thread はまだありません")] : []),
      ...(rows.length > 0 && counts[this.tab] === 0 ? [div().px(12).py(6).text_color(t.muted).child(`${this.tab}の thread はありません`)] : []),
      v_flex().id("thread-list").flex_1().min_h(0).px(4).pb(12).overflow_y_scrollbar()
        .children(GROUPS.filter((group) => tabOf(group) === this.tab).flatMap(section)),
    ];
    const openQuestions = questionCount(this.threads);

    return frame()
      .child(h_flex().flex_none().h(31).px(12).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`Threads · ${this.project.split("/").pop()}`))
        // 未回答の質問の数。押すと要対応のタブの一覧に戻る
        .when(openQuestions > 0, (el) => el.child(div().id("question-count").flex_none().px(6).h(20).flex().items_center().rounded(4)
          .font_semibold().text_color(t.blocked).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.tab = "要対応";
            this.detail = null;
            cx.notify();
          })
          .child(questionLabel(openQuestions))))
        .child(div().id("policy-toggle").flex_none().px(6).h(20).flex().items_center().rounded(4)
          .text_color(policyTotal > 0 ? t.muted : t.dim).when(this.policyOpen, (el) => el.bg(t.raised))
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.policyOpen = !this.policyOpen;
            // 開くときは書き換えた直後でも出るよう読み直す
            if (this.policyOpen) this.readPolicy(cx);
            cx.notify();
          })
          .child(`${policyLabel(policyTotal)} ${this.policyOpen ? "▾" : "▸"}`))
        .child(div().flex_none().child(String(rows.length))))
      .when(this.policyOpen, (el) => el.child(policyPanel()))
      .when(this.umbrella !== "", (el) => el.child(div().flex_none().px(12).pb(4).truncate().text_size(11.5).text_color(t.muted).child(this.umbrella)))
      .when(this.umbrellaError !== null, (el) => el.child(div().flex_none().px(12).pb(4).text_size(12).text_color(t.blocked).child(`project.json を読めません: ${this.umbrellaError}`)))
      .when(this.watchError !== null, (el) => el.child(div().flex_none().px(12).pb(4).text_size(12).text_color(t.blocked)
        .child(`threads/ を監視できません（質問の書き込みと片付けは次の thread の報告まで出ません）: ${this.watchError}`)))
      .children(detailRow !== null ? detailView(detailRow) : listView());
  }
}
