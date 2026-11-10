// agent が許可待ち（Herdr の「Needs you」）になったら、macOS の通知を出す。押すとその agent の pane へ移る。
// 画面には何も描かない。layout のどこかに小さな block として置き、herdr-app が開いている間動かし続ける
// （mod の copy は一度表示されると、隠れても block が layout にある間は動き続ける）。
// herdr-app 本体の音と画面内の toast はそのまま。この mod は window を見ていないときのための macOS 通知だけを足す。

import { View, div } from "gpui-kit";
import { agents, terminals, focused, window, exec, notify } from "herdr";
import { attentionOf, nextNotices, createPoster } from "./notice.js";

// render は Herdr の live データが変わるたびに呼ばれるが、window が隠れている間も呼ばれるかは分からないので、
// timer でも同じ判定を回す（timer は隠れていても動く）。判定は軽く、画面も描き直さない
const INTERVAL = 2000;

export default class PermissionNotify extends View {
  init(_props, cx) {
    this.prev = null;
    this.post = createPoster({ exec, notify });
    cx.timer.every(INTERVAL, (cx) => this.check(cx));
  }

  check(cx) {
    const { notices, state } = nextNotices(this.prev, attentionOf(agents(), terminals()), {
      // window の無いとき（herdr-app check で読み込んだときなど）は null が返る
      windowActive: window()?.active ?? false,
      focusedTerminal: focused()?.terminal ?? null,
    });
    this.prev = state;
    if (notices.length) cx.spawn(async () => { for (const n of notices) await this.post(n); });
  }

  render(cx) {
    this.check(cx);
    return div().size_full();
  }
}
