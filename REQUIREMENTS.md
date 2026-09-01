# 完成条件と確認結果

12 条件を、実装箇所とローカル確認に対応づけます。Worker は反応数と投稿形式による足切りまで行い、内容の最終判断は ChatGPT が担当します。

| 条件 | 実装 | 確認 |
| --- | --- | --- |
| 1. following を cursor 分割同期 | `syncFollowingPage`（`/2/profile/{handle}/following`） | pathname、cursor 2 ページ、D1 local migration |
| 2. 保存済みアカウントを since 収集、返信を除外 | `collectAccountStatuses`、`normalizeStatus` | `since`、`with_replies` 未指定、返信除外、204成功と時刻更新、`retweets`→`reposts`、fresh先行・固定sinceのstatus cursor、queued cursorの切替、初回履歴抑止、同秒IDを含むidle watermark、失敗時保持を確認 |
| 3. enabled query を latest 収集 | `collectSearchQueries`、`saveSearchLatest`、`saveSearchBacklog` | cursorなしの latest と backlog cursor を毎回別取得、空404成功、検索語ごとの cursor 継続・query変更時リセット、backlog中の新着 cursor を `queued_cursor` に保持して切替、latest 成功時の `last_checked_at`、stop watermarkと同秒IDの境界での backlog 終了、成功可否に依存しない巡回位置を確認 |
| 4. 投稿 ID 主キー、quote・画像・反応詳細を保存 | migration の `posts.id`、`postsStatements`、`details_json` | following/searchの同一ID 1件保存、`quote_json`、画像、表示数、ブックマーク数、6件単位の分割保存を確認 |
| 5. Cron、checkpoint、実行上限 | `scheduled`、`collectOnce`、`collector_state` | Cron、scheduled handler、24時間再同期、SOURCE_HANDLE変更時・24時間再同期の再開とfull sync完了前status停止、空SOURCE_HANDLE時のstatus停止、status/query の巡回、失敗batchの巡回、following=50・status/search=25の上流count検証、accounts=1・queries=1、`0|`最終cursor、収集全体の期限付きリースによる重複実行の直列化と期限復帰、D1 Free 50クエリ内、typecheck、Vitest |
| 6. `/feed` の pagination・hours・ISO・降順 | `feed` | `generated_at` / `posts`、ページング、hours、`created_at`、ID同率順、quote、media、不正paginationを確認 |
| 7. ChatGPT 向け安定 JSON | `feed` の `generated_at` / `posts` envelope | Worker fetch の JSON テスト、README の payload 例 |
| 8. Workers 上で会話から検索語を確認・置換 | `GET /queries`、`PUT /queries`、Workers Secret の `ADMIN_TOKEN` | 未認証401、認証済み一覧取得、全置換、空配列による全停止、重複・過大入力の拒否、D1への反映を確認 |
| 9. 反応ゼロ級の一般検索結果を推薦候補から除く | `GET /candidates`、`requiredLikes` | 経過時間に応じた最低反応数、following の緩和、ブックマーク数による通過を確認 |
| 10. 保存したくなる投稿形式を候補順位へ反映 | `candidateFor`、`candidates` | 画像、引用、具体的な長文の signal と順位、media の返却、作者・取得元を1件ずつ先に出す分散を確認 |
| 11. 伸びた投稿の反応数を再取得時に更新 | `postsStatements` の upsert | 初回1いいねの投稿が再取得後250いいね、ブックマーク80へ更新されることを確認 |
| 12. 有料 API・有料サービスなし | FxEmbed 公開 API、D1、Cron のみ | `package.json` の開発依存だけを確認、deploy 非実行 |

## 実行した確認

```sh
npm install
npm run types
npm run typecheck
npm test
npm run check
npx wrangler d1 migrations apply rss-curator --local --persist-to /tmp/rss-curator-fresh-20260831
npx wrangler d1 migrations apply rss-curator --local --persist-to /tmp/rss-curator-fresh-20260831
sqlite3 /tmp/rss-curator-fresh-20260831/v3/d1/miniflare-D1DatabaseObject/a36f84ea60804f30bb0c7f7cad9f5336a6cca0165abdab8b9241d93dbf0b6006.sqlite '.schema posts' '.schema accounts'
npx wrangler dev --local --test-scheduled --persist-to /tmp/rss-curator-smoke
curl "http://127.0.0.1:8791/__scheduled?cron=*/15+*+*+*+*"
curl "http://127.0.0.1:8791/feed?page=1&limit=3&hours=24"
curl "http://127.0.0.1:8791/candidates?limit=20&hours=24"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://127.0.0.1:8787/queries"
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" --data '{"queries":["OpenAI Codex","Cloudflare Workers","Astro web framework"]}' "http://127.0.0.1:8787/queries"
npx wrangler d1 export rss-curator --local --skip-confirmation --output /tmp/rss-curator-backup.sql
npx wrangler d1 execute rss-curator-restore --local --config /tmp/rss-curator-restore-wrangler.jsonc --file /tmp/rss-curator-backup.sql
```

上記の確認はすべて成功しました。一時 local state へ migration を適用し、同じ D1 エンジンの schema を確認しています。FxEmbed の実通信では following 71件を同期し、公開70件の投稿を収集、protected 1件を取得対象外として確認しました。実APIで `count` 指定より多い投稿と `0|` で始まる最終cursorを検出し、分割保存と完了判定へ反映しています。検索語8件も一巡し、ローカルD1には合計1,355投稿を保存しました。実デプロイと remote DB 操作は実行していません。

`/__scheduled` は Wrangler が開発サーバーに提供する入口なので、外部 API を mock できる `test/index.test.ts` で `scheduled` handler を直接呼び出して同じ収集処理を確認しました。手動確認用の URL は README に記載しています。
