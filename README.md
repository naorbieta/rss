# X 投稿フィード Worker

これはローカル完結の MVP です。まずローカルで試します。対象は following と検索語です。FxEmbed API v2 の結果を Cloudflare D1 に保存します。ChatGPT から読める JSON を返す最小構成の Worker です。初回は「セットアップ」「収集」「feed」の順に読み、障害時の動きと用語集は必要なときに参照してください。

## セットアップ

Node.js と npm を用意し、リポジトリ直下で実行します。

```sh
npm install
npm run types
npx wrangler d1 migrations apply rss-curator --local
```

`SOURCE_HANDLE` は `wrangler.jsonc` の空文字が既定値です。following を使う場合は、ローカルだけなら `.dev.vars` に次のように書きます（このファイルは Git に入りません）。

```text
SOURCE_HANDLE=your_handle
```

Wrangler の設定値を変更したら `npm run types` をもう一度実行してください。デプロイはこの MVP の手順に含めません。

## 検索語を追加する

有効な検索語は D1 の `search_queries` に登録します。初回の追加例は次のとおりです。

```sh
npx wrangler d1 execute rss-curator --local --command "INSERT INTO search_queries (query) VALUES ('cloudflare')"
```

無効化・再有効化は `enabled` を `0`・`1` に更新します。Cron 1 回につき、保存済みの巡回位置から最大 5 件を処理します。巡回位置は成功・失敗にかかわらず進み、検索語ごとの cursor は途中ページを次回へ引き継ぎます。`search_queries.query` を変更すると、古い cursor を使わず初回ページから再開します。`last_checked_at` は最終ページまで成功した検索語の checkpoint として保存されます。

## 収集を動かす

通常は `wrangler.jsonc` の Cron Trigger（15 分ごと）が `scheduled` handler を呼びます。ローカルで手動確認するときは専用収集 route を使わず、次を別のターミナルで実行します。

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

1 回の実行には上限があります。following は 1 ページ、アカウントは最大 20 件、検索語は最大 5 件です。following の source handle、cursor、full sync marker、巡回位置、最終同期時刻は `collector_state` に保存します。`SOURCE_HANDLE` を変更した場合は、古い cursor と marker を使わず新しい full sync を開始します。空の `SOURCE_HANDLE` では following と保存済みアカウントの status 取得を止めますが、検索語の収集と保存済みアカウントは維持します。full sync 完了後は24時間待ち、途中の同期だけ毎回1ページ進めます。アカウントの status 取得も1アカウント1ページとし、ページ途中の cursor、固定した `since`、取得済みページの最新時刻を `collector_state` に保存して次回へ続けます。protected アカウントは保存しますが、status は取得しません。

## feed を読む

```sh
curl "http://localhost:8787/feed?page=1&limit=100&hours=24"
```

`page` は 1 以上、`limit` は 1〜100、`hours` は正の数です。`hours` の既定値は 24 です。返却形式は `generated_at`、ページ情報、`posts` の envelope で、投稿の `created_at` は ISO 8601 文字列、`quote` は引用がなければ `null`、あれば JSON object です。投稿は投稿日時の降順（同時刻は ID の降順）で返します。

```json
{
  "generated_at": "2026-08-31T00:00:00.000Z",
  "page": 1,
  "limit": 100,
  "hours": 24,
  "posts": [
    {
      "id": "123",
      "url": "https://x.com/example/status/123",
      "text": "本文",
      "created_at": "2026-08-31T00:00:00.000Z",
      "likes": 10,
      "reposts": 2,
      "quotes": 1,
      "replies": 0,
      "author": { "id": "u1", "screen_name": "example", "name": "Example" },
      "quote": null,
      "source": { "kind": "following", "key": "example" }
    }
  ]
}
```

## ChatGPT から依頼する例

まず `GET /feed` の JSON を取得し、その `posts` をそのまま次のように渡します。

> `/feed?page=1&limit=100&hours=24` の posts を読み、重要度・新規性・私の関心との関連で候補を選んでください。各候補について、投稿 ID、URL、要約、推薦理由を返してください。候補がなければ「該当なし」と理由を書いてください。引用投稿は本文と quote の両方を比較してください。

推薦、推薦理由、0 件の判断は ChatGPT 側の責務です。この Worker は取得、重複排除、保存、安定した JSON の提供だけを担当し、推薦エンジン・ML・embedding・OpenAI API は持ちません。

## 障害時の動き

外部 API の timeout・HTTP エラー・形式不正は source 単位で構造化ログに記録します。ほかのアカウントと検索語の処理は続けます。status の 204 は「新着なし」として成功扱いにし、アカウントの `last_checked_at` だけを更新します。status のページ途中で失敗した場合は、保存済みの cursor と固定した `since` を変えずに同じページを次回再試行します。`last_post_timestamp` は最後のページまで成功したときだけ進みます。検索語もページ途中で失敗した場合は cursor を保持し、最後のページまで成功するまで `last_checked_at` を進めません。失敗したアカウントの時刻は進めませんが、選択した batch の巡回位置は進め、次の巡回で再試行します。検索結果の「404 + code:404 + 空の results」は新着なしとして checkpoint を更新します。検索語の巡回位置も成功・失敗にかかわらず進むため、失敗した検索語が後続の検索語を占有しません。following full sync は全ページが成功した最後のページでだけ、前回同期にしか存在しないアカウントを削除します。

投稿は X 投稿 ID を主キーに `INSERT OR IGNORE` で保存します。同じ Cron が重複実行されても、投稿と checkpoint は重複しません。投稿保存と各 source の checkpoint は同じ D1 batch で更新します。following のアカウント upsert は複数の小さな batch に分けます。全件成功後にだけ cursor と削除処理を更新します。

## 用語

- **following**: `SOURCE_HANDLE` がフォローしているアカウント一覧。
- **cursor**: following、アカウントの status、または検索語の次ページを指す上流 API の位置情報。
- **full sync marker**: 同期中に今回のページで確認したアカウントを識別する印。最後のページで古いアカウントを判定します。
- **quote**: 投稿が引用している投稿の JSON object。推薦判断の材料としてそのまま保存します。
- **D1**: この Worker が投稿、アカウント、検索語、収集位置を保存する SQLite 互換データベース。

このガイドで解決しない挙動は、実行した URL・source・構造化ログの `event` を添えて問い合わせてください。秘密値は貼らないでください。
