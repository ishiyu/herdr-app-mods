---
description: 進行状況を project memory の progress に残してから、coordinator の claude を /exit で終える。open <name> --new で開き直すと、新しい prompt の会話が progress を読んで続ける（project-threads の coordinator 用）
---

user が引き継ぎの資料を残して claude を終えることを頼みました。次の手順で進めてください。この command を Skill ツールで呼び直す必要はありません。

1. `{project}/memory/progress.md` を次の形で書く。上書きし、古い進行状況を残さない。保存時刻は `date -u +%Y-%m-%dT%H:%M:%SZ` で得る。索引の `{project}/memory/MEMORY.md` に progress の行が無ければ足す
   ```
   ---
   name: progress
   description: 前回の coordinator の進行状況（<保存時刻> に引き継ぎで保存）
   ---

   保存: <保存時刻>

   ## 動いている thread
   ## 終わった thread
   ## 取り込みと片付け
   ## 会話で決めたこと
   ## 次にやること
   ```
   - 動いている thread: thread ごとに id・題名・頼んだこと・いまの状態・user の判断待ちの件・次にやること。done でも、user の動作確認や続きの依頼を待つ thread はここに書く（ここに無い終わった thread は、2 の `handoff` が片付ける）
   - 終わった thread: id・題名・結果
   - 取り込みと片付け: main に取り込んだコミット、まだ取り込んでいない worktree とブランチ、push していないこと
   - 会話で決めたこと: user が決めたことのうち、まだ thread に伝えていない・memory に書いていないもの
   - 次にやること: user と約束した後の作業（「取り込んだら片付ける」など）を含む。返事を待っている知らせ（送った回送の受け取り、`cleanup --merged` で merge queue の PR を見張りに任せた thread、裏で回している `next-actions`）も書く（引き継いだ後の会話では、何の知らせか分からないため）
   - 該当の無い見出しには「なし」と書く。会話に無いことを推測で書かない
2. 次の 1 コマンドを実行する。progress.md が無い、または 10 分より前に書かれたままだと失敗して終えないので、1 からやり直す。memory の索引が大きくなっていれば、整理の候補を洗い出す thread もこのコマンドが起動する
   ```
   {bin}/handoff --exit {project}
   ```
3. 「引き継ぎます。このターンの後に claude を終えます。開き直すときは <2 の出力の開き直しのコマンド> を打ってください（新しい会話が progress を読んで続けます）」とだけ返してターンを終える。ほかの作業を始めない

`handoff` が起動した補助が、ターンの終わりと終わった thread の片付けを待ち、片付けの結果を progress の末尾に足してから `/exit` を打つ。開き直した会話は、最初の入力を受けて「会話を始めるとき」の手順で progress と status.json を読む。

- `handoff` を呼んでから claude が終わるまでの間に thread の報告が届いたら、「引き継ぎ中なので、開き直した後の会話で扱います」とだけ返し、ほかには何もしない。報告は status.json に残り、開き直した会話が拾う
- `[project-threads handoff] /exit を打てませんでした` が届いたら、そのまま user に伝え、`/exit` を打ってもらう（progress は残っている）
