# 全 project 共通の thread の決まり

<!--
どの project の thread も従う。thread の起動（bin/start）が欄の中身を thread の指示に写すので、thread はこのファイルを読まない。
書き換えは次に起動する thread から効く（動いている thread・再開した thread には効かない）。この説明のコメントと空の欄は写さない。
coordinator も読み、coordinator にも当てはまる行には coordinator も従う（同じ行を coordinator-rules.md に書かない）。
user が手で書く。~/.config/project-threads/thread-rules.md に置く。「- 」で 1 行ずつ書く。
repo 固有の決まり（<repo>/.local/hc-projects/repo-thread-rules.md）と食い違うときは、repo 固有が優先する。
どちらの欄にも書いていない操作は、これまでどおり破壊的・外向きなら確認する。
-->

## 自律的にやってよいこと

## 確認すること
