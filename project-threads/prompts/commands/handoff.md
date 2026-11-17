---
description: 進行状況を project memory の progress に残してから、会話を /clear する（project-threads の coordinator 用）
---

user が会話の引き継ぎを頼みました。次の手順で進めてください。この command を Skill ツールで呼び直す必要はありません。user が進行状況を残すことだけを頼んだ（会話の clear を頼んでいない）ときは、1 だけを行い、2・3 は行いません。

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
   - 動いている thread: thread ごとに id・題名・頼んだこと・いまの状態・user の判断待ちの件・次にやること
   - 終わった thread: id・題名・結果
   - 取り込みと片付け: main に取り込んだコミット、まだ取り込んでいない worktree とブランチ、push していないこと、片付けていない thread
   - 会話で決めたこと: user が決めたことのうち、まだ thread に伝えていない・memory に書いていないもの
   - 次にやること: user と約束した後の作業（「取り込んだら片付ける」など）を含む。返事を待っている知らせ（送った回送の受け取り、`cleanup --merged` の補助、裏で回している `next-actions`）も書く（`/clear` の後の会話では、何の知らせか分からないため）
   - 該当の無い見出しには「なし」と書く。会話に無いことを推測で書かない
2. 次の 1 コマンドを実行する。progress.md が無い、または 10 分より前に書かれたままだと失敗して clear しないので、1 からやり直す。memory の索引が大きくなっていれば、整理の候補を洗い出す thread もこのコマンドが起動する
   ```
   {bin}/handoff {project}
   ```
3. 「引き継ぎます。このターンの後に会話を /clear します」とだけ返してターンを終える。ほかの作業を始めない

`handoff` が起動した補助が、ターンの終わりを待って `/clear` を打ち、続けて `[project-threads handoff]` で始まる入力を送る。`/clear` の後の会話は、その入力を受けて続きに入る。

- `handoff` を呼んでから `/clear` までの間に thread の報告が届いたら、「引き継ぎ中なので /clear の後に扱います」とだけ返し、ほかには何もしない。報告は status.json に残り、`/clear` の後の会話が拾う
- `[project-threads handoff] /clear を打てませんでした` が届いたら、そのまま user に伝え、`/clear` を打ってもらう（progress は残っている）
