# 完成条件と確認結果

13 条件を、実装箇所とローカル確認に対応づけます。Worker は反応数と投稿形式による足切りまで行い、内容の最終判断は ChatGPT が担当します。

| 条件 | 実装 | 確認 |
| --- | --- | --- |
| 1. following を cursor 分割同期 | `syncFollowingPage`（`/2/profile/{handle}/following`） | pathname、cursor 2 ページ、無関係な配列だけを含む不正応答の拒否、D1 local migration |
| 2. 保存済みアカウントを since 収集、返信を除外 | `collectAccountStatuses`、`normalizeStatus` | `since`、`with_replies` 未指定、返信除外、204成功と時刻更新、`retweets`→`reposts`、fresh先行・固定sinceのstatus cursor、queued cursorの切替、新規アカウントの発見時刻からの複数ページ取得、既存NULL時の初回履歴抑止、同秒IDを含むidle watermark、失敗時保持を確認 |
| 3. enabled query を latest 収集 | `collectSearchQueries`、`saveSearchLatest`、`saveSearchBacklog` | cursorなしの latest と backlog cursor を毎回別取得、空404成功、検索語ごとの cursor 継続・query変更時リセット、backlog中の新着 cursor を `queued_cursor` に保持して切替、latest 成功時の `last_checked_at`、stop watermarkと同秒IDの境界での backlog 終了、成功可否に依存しない巡回位置を確認 |
| 4. 投稿 ID 主キー、quote・画像・反応詳細を保存 | migration の `posts.id`、`postsStatements`、`details_json` | following/searchの同一ID 1件保存、`quote_json`、画像、表示数、ブックマーク数、6件単位の分割保存を確認 |
| 5. Cron、checkpoint、実行上限 | `scheduled`、`collectOnce`、`collector_state` | 5分Cron、scheduled handler、24時間再同期、SOURCE_HANDLE変更時・24時間再同期の再開とfull sync完了前status停止、空SOURCE_HANDLE時のstatus停止、status/query の巡回、失敗batchの巡回、following=50・status/search=25の上流count検証、accounts=1・queries=1、`0|`最終cursor、4分リースによる重複実行の直列化と期限復帰、D1 Free 50クエリ内、typecheck、Vitest |
| 6. `/feed` の pagination・hours・ISO・降順 | `feed` | `generated_at` / `posts`、ページング、hours、`created_at`、ID同率順、quote、media、不正paginationを確認 |
| 7. ChatGPT 向け安定 JSON | `feed` の `generated_at` / `posts` envelope | Worker fetch の JSON テスト、README の payload 例 |
| 8. Workers 上で会話から検索語を確認・置換 | `GET /queries`、`PUT /queries`、Workers Secret の `ADMIN_TOKEN` | 未認証401、認証済み一覧取得、全置換、空配列による全停止、重複・過大入力の拒否、D1への反映を確認 |
| 9. ChatGPT がWorkerを直接呼び出す | OAuth 2.1で保護した`/mcp`、固定`MCP_ALLOWED_HOST`、CIMD・DCR、`get_recommendation_candidates`、`get_search_queries`、`replace_search_queries` | 未認証401、DCR、PKCE付き認可コード、CSRF・未許可Host・Origin拒否、設定済み本番hostのHTTPS Origin許可、認可stateの原子的な一回消費、同じブラウザでの並行認可、未完了stateを全体20件に制限して超過時429、誤った管理トークンの後に正しい値で再送可能、token交換、MCP初期化、3ツールの一覧・呼び出し、D1反映、本番`/feed`・`/candidates`のBearer認証を確認 |
| 10. 反応ゼロ級の一般検索結果を推薦候補から除く | `GET /candidates`、`requiredLikes` | 経過時間に応じた最低反応数、following の緩和、ブックマーク数による通過を上限適用前に判定し、適格候補が脱落しないことを確認 |
| 11. 保存したくなる投稿形式を候補順位へ反映 | `candidateFor`、`candidates` | 適格候補を全件採点し、画像、引用、具体的な長文の signal と順位、media の返却、安定した作者ID・取得元を1件ずつ先に出す分散、候補の `hours` を0より大きく24以下に制限し、上限超過・巨大入力を拒否することを確認 |
| 12. 投稿を再取得時に更新 | `postsStatements` の upsert | 本文・URL・作者情報と明示された反応数の減少を反映し、次の取得で省略された本文・作者ID・表示名・反応数・画像・センシティブ判定を保持することを確認 |
| 13. 有料 API・有料サービスなし | FxEmbed 公開 API、D1、Workers KV、Cron | 本番D1・KV・Workerを無料枠の構成で作成し、追加の有料APIや有料LLMを使わずに実通信を確認 |

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
curl "http://127.0.0.1:8791/__scheduled?cron=*/5+*+*+*+*"
curl "http://127.0.0.1:8791/feed?page=1&limit=3&hours=24"
curl "http://127.0.0.1:8791/candidates?limit=20&hours=24"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://127.0.0.1:8787/queries"
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" --data '{"queries":["OpenAI Codex","Cloudflare Workers","Astro web framework"]}' "http://127.0.0.1:8787/queries"
npx wrangler d1 export rss-curator --local --skip-confirmation --output /tmp/rss-curator-backup.sql
npx wrangler d1 execute rss-curator-restore --local --config /tmp/rss-curator-restore-wrangler.jsonc --file /tmp/rss-curator-backup.sql
npx wrangler d1 migrations apply rss-curator --remote --env production
npx wrangler deploy --env production
```

上記の確認はすべて成功しました。一時 local state へ migration を適用し、同じ D1 エンジンの schema を確認しています。自動テスト69件には、OAuthの認可からMCPの3ツール呼び出しまでの統合確認、同時認可でもstateを一度だけ消費する確認、同じブラウザで並行した認可を維持する確認、未完了認可stateの上限、本番hostの正規Origin許可と悪性Origin拒否、本番の確認用JSON APIをD1アクセス前に拒否する確認、途中まで保存されたfollowing設定を元へ戻した際の再同期と収集再開、account backlogのcursor循環防止、無関係な配列だけを含むfollowing応答の拒否を含みます。FxEmbed の実通信では following 71件を同期し、公開70件の投稿を収集、protected 1件を取得対象外として確認しました。実APIで `count` 指定より多い投稿と `0|` で始まる最終cursorを検出し、分割保存と完了判定へ反映しています。検索語8件も一巡し、ローカルD1には合計1,355投稿を保存しました。

本番D1へmigrationを適用し、KVとWorkers Secretを設定したWorkerを `https://rss-curator.nao-a01.workers.dev` へ配置しました。未認証アクセスの拒否、Bearer認証、OAuth discovery、ChatGPTからの検索語取得と推薦候補取得を確認しています。毎日8:00（日本時間）の定期タスクを作成し、「今すぐ実行」でもMCPを呼び出して推薦結果が返ることを確認しました。

`/__scheduled` は Wrangler が開発サーバーに提供する入口なので、外部 API を mock できる `test/index.test.ts` で `scheduled` handler を直接呼び出して同じ収集処理を確認しました。手動確認用の URL は README に記載しています。
