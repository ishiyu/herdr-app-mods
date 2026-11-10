// right-sidebar-github / right-sidebar-ci / right-sidebar-local が同じ内容で 1 部ずつ持つ。
// Herdr は mod フォルダの外を import できないので、直すときは 3 部とも同じ内容にする
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, shared, setShared } from "herdr";

// フォーカス中 pane の cwd を最優先し、space の folder は最後の手段。
// 本 mod 自身が pane として開かれてフォーカスを持つと mod pane には cwd が無いので、同じ tab の端末 pane を使う
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const focusedPane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const pane = focusedPane?.terminal ? focusedPane : panes().find((p) => p.tab === f?.tab && p.terminal && p.cwd);
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
export const key = () => JSON.stringify(location());

export async function gh(args, cwd, on) {
  const r = await exec("gh", args, { cwd, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout;
}
export const ghJson = async (args, cwd, on) => JSON.parse(await gh(args, cwd, on));

// 上のタブバーの right-sidebar mod が、表に出したパネルへ命令を渡す共有状態のキー。値は { to, command, id }
export const REQUEST = "right-sidebar.request";
export const STATE_ORDER = { fail: 0, pending: 1, pass: 2, none: 3 };
// herdr のタブや repo を渡り歩いても覚えておく数。閉じたタブの分を溜め込まないよう古いものから捨てる
const MEMORY_LIMIT = 20;
// Map を挿入順の LRU として使う
function remember(map, k, make) {
  const v = map.has(k) ? map.get(k) : make();
  map.delete(k); map.set(k, v);
  while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value);
  return v;
}

export function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

// 一覧・詳細の描画は this.prs や this.tab を読み書きするので、表示中の repo（data）と herdr のタブ（view）の状態へ委ねる
export function delegate(cls, source, fields) {
  for (const f of fields) {
    Object.defineProperty(cls.prototype, f, { get() { return this[source][f]; }, set(v) { this[source][f] = v; } });
  }
}

// パネルの共通部分。取得結果を repo ごとに、見ていたタブと詳細を herdr のタブごとに覚え、詳細の開閉と命令の受け取りを担う。
// 継承側が持つもの: panel（"github" など）、emptyData()、emptyView(context, previous)、tabOf(kind)、load(entry, on, context, cx)、
// fetchDetail(d, root, on)、command(command, cx)、detailLabel(d)、detailBody(d, t)。setup / switched / returned / loaded は必要なときだけ
export class Panel extends View {
  // 表示中のパネル内タブの詳細。パネル内タブを行き来しても閉じないよう、詳細はパネル内タブごとに持つ
  get detail() { return this.view.details[this.view.tab]; }
  set detail(d) { this.view.details[this.view.tab] = d; }

  init(_props, cx) {
    // herdr のタブを切り替えて戻ったときに取り直さず元の表示を出すため、取得結果は repo（key()）ごとに、
    // 見ていたパネル内タブと詳細は herdr のタブごとに覚えておく。表示中のものは this.data / this.view
    this.cache = new Map(); this.views = new Map();
    this.data = this.baseData(); this.view = this.emptyView(null);
    this.setup(cx);
    // 一覧の取り直しは ↻ ボタンだけで行う。初めて見る repo の初回取得だけは render（begin）から行う
  }

  baseData() {
    return { root: null, error: null, updated: 0, fetched: 0, loading: false, ...this.emptyData() };
  }

  setup(_cx) {}
  // herdr のタブか repo が変わった直後
  switched(_cx) {}
  // 取得済みの repo へ戻ってきたとき（render 中なので notify できない）
  returned(_cx) {}
  // 一覧を取り直した直後
  loaded(_cx) {}

  // render の先頭で呼ぶ
  begin(cx) {
    this.sync(cx);
    this.takeRequest(cx);
  }

  // 表示中の repo か herdr のタブが変わったら覚えている状態へ切り替え、まだ一度も取得していない repo だけ取りに行く
  sync(cx) {
    const context = key(), tab = focused()?.tab ?? null;
    if (context === this.context && tab === this.herdrTab) return;
    this.context = context; this.herdrTab = tab;
    this.data = remember(this.cache, context, () => this.baseData());
    this.view = remember(this.views, tab, () => this.emptyView(context));
    // 同じ herdr のタブでも別 repo へ移ったなら、番号を引き直すと別物を表示するので、見ていた詳細と検索結果は捨てる
    if (this.view.context !== context) { this.view = this.emptyView(context, this.view); this.views.set(tab, this.view); }
    this.switched(cx);
    if (!this.data.fetched) { this.refresh(cx, { inRender: true }); return; }
    this.returned(cx);
  }

  // mod 宛ての命令は表に出ている mod にしか届かないので、命令は常に表に出ている right-sidebar mod が受け、
  // このパネルを表に出してから共有状態で渡してくる
  takeRequest(cx) {
    const r = shared(REQUEST);
    if (!r || r.to !== this.panel || r.id === this.taken) return;
    this.taken = r.id;
    cx.spawn(async (cx) => {
      // spawn に渡した関数は最初の await まで render の中で走る。命令は notify するので、render を抜けるまで待つ
      await cx.sleep(0);
      // 残しておくと、mod を読み込み直したときに同じ命令をもう一度実行する
      setShared(REQUEST, null);
      this.command(r.command, cx);
      cx.notify();
    });
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
        entry.root = top.stdout.trim();
        await this.load(entry, on, context, cx);
        entry.error = null; entry.updated = Date.now();
        if (this.data === entry) { this.loadDetail(cx); this.loaded(cx); }
      } catch (e) { entry.error = String(e.message ?? e); }
      // 失敗しても fetched は進める。進めないと herdr のタブを切り替えるたびに失敗する取得を繰り返す
      finally { entry.loading = false; entry.fetched = Date.now(); cx.notify(); }
    });
    if (!inRender) cx.notify();
  }

  // from は back で戻る先の詳細。サブイシューから親 issue へ戻るときに、取り直さず元の表示を出すために持つ
  openDetail(kind, id, cx, from = null) {
    this.view.tab = this.tabOf(kind);
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
    const d = this.detail, view = this.view, root = this.data.root;
    if (!d || d.loading || !root) return;
    const { on } = location();
    // 取得中にパネル内タブや herdr のタブを移っても結果を捨てないよう、詳細がまだ view に残っているかで判定する
    const holds = () => Object.values(view.details).includes(d);
    d.loading = true;
    cx.spawn(async (cx) => {
      try {
        const { kind = d.kind, data } = await this.fetchDetail(d, root, on);
        if (!holds()) return;
        d.kind = kind; d.data = data; d.error = null;
        // 種類が取得してから決まる詳細（PR か issue か未判定の番号）は、決まった種類のパネル内タブへ移す
        const from = Object.keys(view.details).find((k) => view.details[k] === d), to = this.tabOf(kind);
        if (from !== to) {
          view.details[from] = null; view.details[to] = d;
          if (view.tab === from) view.tab = to;
        }
      } catch (e) { if (holds()) d.error = String(e.message ?? e); }
      finally { d.loading = false; cx.notify(); }
    });
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

  empty(text, t) {
    return div().px(16).py(6).text_size(13).text_color(t.dim).child(text);
  }

  meta(parts, t) {
    return h_flex().flex_wrap().gap_x(8).gap_y(2).px(14).text_size(12).text_color(t.dim).children(parts.filter(Boolean));
  }

  // ↻ は小さいと押しにくいので、周りの文字より大きくする
  reloadButton(t) {
    // 行の高さが文字に合わせて伸びて見出しの行より縦長にならないよう、高さを固定する
    return h_flex().id("reload").h(22).px(6).items_center().justify_center().rounded(4).border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).text_size(24).text_color(t.foreground)
      .child(this.data.loading || this.detail?.loading ? "…" : "↻").on_click((_e, cx) => this.refresh(cx));
  }

  // パネル内タブの切り替え。tabs は [id, ラベル] の並び
  switcher(tabs, t) {
    return h_flex().h(36).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .children(tabs.map(([id, label]) => {
        const active = this.view.tab === id;
        return div().id(`tab-${id}`).px(10).py(3).rounded(6).cursor_pointer().text_size(13).font_semibold()
          .text_color(active ? t.foreground : t.dim).when(active, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
          .child(label).on_click((_e, cx) => { this.view.tab = id; cx.notify(); });
      }));
  }

  detailView(t) {
    const d = this.detail, data = d.data;
    return v_flex()
      .child(h_flex().h(32).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border).text_size(13)
        .child(this.button("back", "← back", t, (_e, cx) => this.back(cx)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.detailLabel(d)))
        .when(Boolean(data?.url), (e) => e.child(this.button("browser", "open ↗", t, () => this.open(data.url))))
        .child(this.reloadButton(t)))
      .when(Boolean(d.error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(d.error)))
      .child(data ? this.detailBody(d, t) : this.empty(d.error ? "" : "Loading…", t));
  }

  // header はパネル内タブの切り替え（無いパネルは null）、list は詳細を開いていないときの一覧を返す関数
  frame(t, header, list) {
    const { root, error, updated } = this.data;
    return v_flex().id(`right-sidebar-${this.panel}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(14)
      .when(Boolean(header), (e) => e.child(header))
      .when(Boolean(error), (e) => e.child(div().px(14).py(8).text_size(13).text_color(t.ansi1).child(error)))
      .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .child(this.detail ? this.detailView(t) : list()))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(root ? root.split("/").pop() : ""))
        .child(div().child(updated ? `updated ${new Date(updated).toLocaleTimeString()}` : "")));
  }
}
