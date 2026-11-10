// 許可待ちの通知で、どの agent をいつ知らせ、terminal-notifier に何を渡すかを決める。
// herdr に依存させず、node のテストから読めるようにしてある。

// my-agents が一覧に出す agent と、その「Needs you」の判定を写したもの。my-agents の一覧と通知の対象がずれないよう、
// my-agents の判定を変えたらここも合わせる。
// - pane を持つ agent は agents() の 1 件。status が blocked なら Needs you
// - pane を持たない子（hc run で起動された sub-agent）は、一覧の agent の子孫で動いている terminal。
//   status は agents() に載っていればそれ、無ければ terminals() の status。error も Needs you に数える
// 返すのは address ごとの { needsYou, target }。target は通知の文面と押したときの行き先に使う
export function attentionOf(agents, terminals) {
  const listed = new Map(agents.map((a) => [a.address, a]));
  const out = new Map();
  for (const a of agents) {
    out.set(a.address, {
      needsYou: a.status === "blocked",
      target: { address: a.address, pane: a.pane, name: a.program?.name || a.app || "agent", where: whereOf(a), body: a.title || a.address },
    });
  }
  const visit = (root, parent) => {
    for (const k of terminals) {
      if (k.parent !== parent || k.state !== "live") continue;
      if (!out.has(k.address)) {
        const s = listed.get(k.address)?.status ?? k.status;
        out.set(k.address, {
          needsYou: s === "blocked" || s === "error",
          target: {
            address: k.address,
            pane: null,
            rootPane: root.pane,
            name: k.name || k.template || k.program?.name || k.address,
            where: `${whereOf(root)} · ${root.address} の子`,
            body: k.title || k.cwd || k.address,
          },
        });
      }
      visit(root, k.address);
    }
  };
  for (const a of agents) visit(a, a.address);
  return out;
}

// space と、人が名前を付けたタブ（番号だけのタブ名は何も言わないので出さない）
function whereOf(a) {
  const tab = a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : "";
  return [a.space_name, tab].filter(Boolean).join(" · ");
}

// 前回と今回の判定を比べて、出す通知を決める。
// prev: 前回の address → needsYou（初回は null）。current: attentionOf の結果。
// - Needs you でなかった agent が Needs you になったときだけ出す。答えて戻り、また Needs you になれば、また出す
// - 初回と、今回初めて見えた agent は覚えるだけで出さない。herdr-app の起動・mod の読み直し・core の再接続で
//   全 agent が一度に見え直したとき、すでに許可待ちのものを一斉に鳴らさないため
// - 見ている agent（Herdr の window が前面で、その terminal にフォーカスがある）は出さない。herdr-app 本体の toast と音で足りる
// 返すのは { notices: target の配列, state: 次の prev }
export function nextNotices(prev, current, view = { windowActive: false, focusedTerminal: null }) {
  const state = new Map([...current].map(([address, x]) => [address, x.needsYou]));
  if (prev === null) return { notices: [], state };
  const notices = [];
  for (const [address, x] of current) {
    if (!x.needsYou || prev.get(address) !== false) continue;
    if (view.windowActive && view.focusedTerminal === address) continue;
    notices.push(x.target);
  }
  return { notices, state };
}

// sh の 1 語として渡すための引用
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// 押したときに実行するコマンド。通知を押すと terminal-notifier が sh で実行する。通知の仕組みから起動されるので
// PATH は最小で、herdr-app は絶対パスで呼ぶ。
// - pane を持つ agent: my-agents の行を押したときと同じ pane.focus（別の space・tab の pane でもそこへ切り替わる）
// - pane を持たない子: 一覧の親の agent の pane へ移ってから、my-agents の子の行を押したときと同じ terminal.peek で重ねて開く
export function clickCommand(target, herdrApp) {
  const doIt = (name, args) => `${shellQuote(herdrApp)} do ${name} ${shellQuote(JSON.stringify(args))}`;
  if (target.pane) return doIt("pane.focus", { pane: target.pane });
  return `${doIt("pane.focus", { pane: target.rootPane })} && ${doIt("terminal.peek", { terminal: target.address })}`;
}

// terminal-notifier の引数。-sound は付けない（herdr-app 本体が blocked の音を鳴らすので重ねない）。
// -group が同じ通知は置き換わるので、同じ agent の通知は 1 件にまとまる。
// -message が空だと terminal-notifier は標準入力から本文を読もうとするので、空にしない
export function notifierArgs(target, herdrApp) {
  return [
    "-title", `⚠️ ${target.name} needs you`,
    "-subtitle", target.where || target.address,
    "-message", target.body || target.address,
    "-group", `herdr-permission-${target.address}`,
    "-activate", "dev.herdr.app",
    "-execute", clickCommand(target, herdrApp),
  ];
}

// 通知を 1 件出す関数を作る。exec と notify は herdr の同名の関数（テストでは偽物）。
// 出せなければ黙って飛ばさず、herdr-app の画面内の通知で理由を出す。出せない理由を一度知らせたら、
// 出せるようになるまで同じ知らせを繰り返さない（許可待ちのたびに error の toast を重ねないため）
export function createPoster({ exec, notify }) {
  let herdrApp = null;
  let failing = false;
  const fail = (program, error) => {
    if (failing) return;
    failing = true;
    notify(failureNotice(program, error));
  };
  return async (target) => {
    if (!herdrApp) {
      const r = await exec("/bin/sh", ["-c", "command -v herdr-app"]);
      if (r.code !== 0 || !r.stdout.trim()) return fail("herdr-app", r);
      herdrApp = r.stdout.trim();
    }
    let r;
    try {
      r = await exec("terminal-notifier", notifierArgs(target, herdrApp));
    } catch (e) {
      return fail("terminal-notifier", e);
    }
    if (r.code !== 0) return fail("terminal-notifier", r);
    failing = false;
  };
}

// macOS の通知を出せなかったときに、herdr-app の画面内の通知（notify()）で出す中身。
// error: exec が投げたもの（プログラムが見つからない・起動できない）か、{ code, stderr }（終了コードが 0 でない）。
// 投げられた Error も code（"ENOENT" など）を持つことがあるので、終了コードが数値かどうかで見分ける
export function failureNotice(program, error) {
  if (program === "terminal-notifier" && typeof error?.code !== "number") {
    return {
      title: "許可待ちの macOS 通知を出せません",
      body: `terminal-notifier を起動できません（${String(error)}）。brew install terminal-notifier で入れてください`,
      level: "error",
    };
  }
  if (program === "herdr-app") {
    return {
      title: "許可待ちの macOS 通知を出せません",
      body: "herdr-app コマンドが PATH に見つからないので、通知を押したときの移動先を作れません",
      level: "error",
    };
  }
  return {
    title: "許可待ちの macOS 通知を出せません",
    body: `${program} が失敗しました（終了コード ${error.code}）: ${String(error.stderr ?? "").trim()}`,
    level: "error",
  };
}
