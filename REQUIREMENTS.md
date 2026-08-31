# 完成条件と確認結果

11 条件を、実装箇所とローカル確認に対応づけます。推薦判断は実装対象外で、README に境界を記載しています。

| 条件 | 実装 | 確認 |
| --- | --- | --- |
| 1. following を cursor 分割同期 | `syncFollowingPage`（`/2/profile/{handle}/following`） | pathname、cursor 2 ページ、D1 local migration |
| 2. 保存済みアカウントを since 収集、返信を除外 | `collectAccountStatuses`、`normalizeStatus` | `since`、`with_replies` 未指定、返信除外、204成功と時刻更新、`retweets`→`reposts`、fresh先行・固定sinceのstatus cursor、queued cursorの切替、初回履歴抑止、同秒IDを含むidle watermark、失敗時保持を確認 |
| 3. enabled query を latest 収集 | `collectSearchQueries`、`saveSearchLatest`、`saveSearchBacklog` | cursorなしの latest と backlog cursor を毎回別取得、空404成功、検索語ごとの cursor 継続・query変更時リセット、backlog中の新着 cursor を `queued_cursor` に保持して切替、latest 成功時の `last_checked_at`、stop watermarkと同秒IDの境界での backlog 終了、成功可否に依存しない巡回位置を確認 |
| 4. 投稿 ID 主キー、quote 保存 | migration の `posts.id`、`postsStatement` | following/searchの同一ID 1件保存、`quote_json` を確認 |
| 5. Cron、checkpoint、実行上限 | `scheduled`、`collectOnce`、`collector_state` | Cron、scheduled handler、24時間再同期、SOURCE_HANDLE変更時・24時間再同期の再開とfull sync完了前status停止、空SOURCE_HANDLE時のstatus停止、status/query の巡回、失敗batchの巡回、following=20・status/search=6の上流count検証、accounts=2・queries=3、収集全体の期限付きリースによる重複実行の直列化と期限復帰、D1 Free 50クエリ内（最大49、following実行回43）の実D1計測、typecheck、Vitest |
| 6. `/feed` の pagination・hours・ISO・降順 | `feed` | `generated_at` / `posts`、ページング、hours、`created_at`、ID同率順、quote、不正paginationを確認 |
| 7. ChatGPT 向け安定 JSON | `feed` の `generated_at` / `posts` envelope | Worker fetch の JSON テスト、README の payload 例 |
| 8. 推薦ロジックを入れない | `src/index.ts` に推薦処理なし | README の責務境界 |
| 9. 推薦理由を入れない | 同上 | README の ChatGPT 依頼例 |
| 10. 0 件判断を入れない | 同上 | README の責務境界 |
| 11. 有料 API・有料サービスなし | FxEmbed 公開 API、D1、Cron のみ | `package.json` の開発依存だけを確認、deploy 非実行 |

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
npx wrangler d1 export rss-curator --local --skip-confirmation --output /tmp/rss-curator-backup.sql
npx wrangler d1 execute rss-curator-restore --local --config /tmp/rss-curator-restore-wrangler.jsonc --file /tmp/rss-curator-backup.sql
```

上記の確認はすべて成功しました。一時 local state へ初回 migration を適用し、同じ D1 エンジンの schema を確認しています。FxEmbed の実通信では検索結果を一時 D1 に保存し、`/feed` から取得できました。識別用 User-Agent がないと 401 になることも実通信で検出し、Worker の要求ヘッダーとテストに反映しています。バックアップは別 ID の一時ローカル D1 へ復元し、必要なテーブルを確認しました。実デプロイと remote DB 操作は実行していません。

natural-japanese quick lint は README.md と REQUIREMENTS.md ともに指摘なしでした。

`/__scheduled` は Wrangler が開発サーバーに提供する入口なので、外部 API を mock できる `test/index.test.ts` で `scheduled` handler を直接呼び出して同じ収集処理を確認しました。手動確認用の URL は README に記載しています。
