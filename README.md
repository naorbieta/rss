# X 投稿フィード Worker

これは Cloudflare Workers で動かす X 投稿収集 Worker です。まずローカルで試します。対象は following と検索語です。FxEmbed API v2 の結果を Cloudflare D1 に保存し、ChatGPT から読み書きできる JSON API を提供します。初回は「セットアップ」「検索語を管理する」「収集」「推薦候補を読む」の順に読み、障害時の動きと用語集は必要なときに参照してください。

## セットアップ

Node.js と npm を用意し、リポジトリ直下で実行します。

```sh
npm install
npm run types
npx wrangler d1 migrations apply rss-curator --local
```

検索語の変更APIは `ADMIN_TOKEN` で保護します。ローカルでは `.dev.vars` に推測されにくい値を設定します。このファイルは Git に入りません。`SOURCE_HANDLE` は空文字のままでも検索語の収集だけを利用できます。

```text
ADMIN_TOKEN=推測されにくい値
SOURCE_HANDLE=your_handle
```

Workersへ配置するときは、同じ名前の `ADMIN_TOKEN` を Workers Secret として設定します。平文の `vars` には置きません。Wrangler の設定値を変更したら `npm run types` をもう一度実行してください。

## 検索語を管理する

`GET /queries` は現在有効な検索語を返します。`PUT /queries` は有効な検索語全体を置き換えます。どちらも `ADMIN_TOKEN` が必要です。

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/queries"

curl -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"queries":["Claude Code","Codex 開発","プロダクトデザイン","OpenStreetMap","地方 移住","まちづくり","ホロライブ","VTuber"]}' \
  "http://localhost:8787/queries"
```

検索語は最大20件、1件につき200文字までです。同じ検索語は、大文字・小文字だけを変えても重複指定できません。空の配列を送ると検索語による収集をすべて停止します。置き換え前に収集した投稿は削除せず、指定した `hours` の期間中は feed に残ります。新しい検索語は次回の Cron から収集されます。

Cron 1 回につき、保存済みの巡回位置から検索語を最大 1 件処理します。各検索語は毎回 cursor なしの `feed=latest` を先に 1 ページ取得して保存し、途中の backlog cursor があれば続けて 1 ページ取得します。latest の取得成功時に `last_checked_at` を更新し、backlog 用 cursor は別の `collector_state` に保存します。backlog 中に fresh で新しい cursor が見つかった場合は `queued_cursor` に待機させ、現在の backlog が終端または stop watermark に到達してから切り替えます。最新ページで確認した投稿時刻が前回完了時の stop watermark より新しいとき、または同じ秒の未確認 ID があるときだけ backlog を開始し、stop watermark の既知 ID に到達するか終端になるまで続けます。巡回位置は成功・失敗にかかわらず進みます。同じ検索語を再び有効にすると、保存済みの収集位置から再開します。

## 収集を動かす

通常は `wrangler.jsonc` の Cron Trigger（15 分ごと）が `scheduled` handler を呼びます。ローカルで手動確認するときは専用収集 route を使わず、次を別のターミナルで実行します。

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

収集全体は実行開始時刻を基準に期限10分のリースで直列化します。重複実行は安全に何もせず、実行プロセスが終了してもリースの期限後に再取得できます。

1 回の実行には上限があります。取得は 1 ページ、アカウントは最大 1 件、検索語は最大 1 件です。FxEmbed APIには一覧の `count=50`、status と検索の `count=25` を指定します。following は20件、投稿は6件単位に分け、D1のバインド上限内で保存します。上流がこの件数を超えて返した場合は source 失敗として保存を進めません。取得対象の source handle、cursor、full sync marker、巡回位置、最終同期時刻は `collector_state` に保存します。`SOURCE_HANDLE` を変更した場合は、古い cursor と marker を使わず新しい full sync を開始し、SOURCE_HANDLE変更時または24時間再同期時の full sync が完了するまで保存済みアカウントの status 取得を止めます。空の `SOURCE_HANDLE` では取得と保存済みアカウントの status 取得を止めますが、検索語の収集と保存済みアカウントは維持します。full sync 完了後は24時間待ち、途中の同期だけ毎回1ページ進めます。同期を試みた実行では、成功・失敗にかかわらずアカウントの status 取得を行わず、次回 Cron 以降に回します。同期を行わない実行では、最大1アカウントについて status の cursor なし fresh を先に1ページ取得し、保存済み backlog cursor があれば同じ実行で1ページ進めます。backlog 中は固定した `since` を使い、fresh で新しい cursor が見つかれば待ち行列に保存して現在の backlog 終端後に切り替えます。最後の backlog と待ち行列が終端するまで `last_post_timestamp` は進めません。完了後は最新時刻と同じ秒の既知IDを状態に残し、同じ fresh を backlog として再開しません。protected アカウントは保存しますが、status は取得しません。
上限値はコードで固定しています。

D1 Free の1回の Worker invocation あたりのクエリ上限は50です（[Cloudflare公式の制限](https://developers.cloudflare.com/d1/platform/limits/)）。このWorkerは収集元を1アカウント・1検索語ずつ処理し、followingのアカウントと各ページの投稿を、上限100 bound parameters内のmulti-row SQLで保存します。最大ページを使うテストでも50クエリ以内であることを確認しています。

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
      "views": 1000,
      "bookmarks": 20,
      "author": { "id": "u1", "screen_name": "example", "name": "Example" },
      "quote": null,
      "media": null,
      "possibly_sensitive": false,
      "source": { "kind": "following", "key": "example" }
    }
  ]
}
```

## 反応の弱い投稿を除いた推薦候補を読む

```sh
curl "http://localhost:8787/candidates?limit=20&hours=24"
```

`GET /candidates` は、指定時間内の投稿から反応がほぼない候補を除き、いいね、リポスト、引用、ブックマーク数をもとに並べます。公開直後は必要ないいね数を低くし、時間の経過とともに基準を上げます。following の投稿は一般検索より低い基準で残します。画像、引用、具体的な長文がある投稿は順位づけで加点します。同じ作者や取得元だけで埋まらないよう、まず1件ずつ選び、指定件数に足りない場合だけ重複候補で補います。

`limit` は1〜50、`hours` は正の数です。返却値の `criteria` に今回適用した基準、各投稿の `selection` に点数と判定材料が入ります。画像は `media`、引用は `quote` で確認できます。すべての投稿を時系列で確認したい場合だけ `GET /feed` を使います。

## ChatGPT から依頼する例

検索語を変える場合は、ChatGPTが `GET /queries` で現在値を確認し、会話から選んだ検索語全体を `PUT /queries` へ送ります。通常のChatGPTから呼び出すには、このWorkerのURLと `ADMIN_TOKEN` を利用できるコネクタまたはツールが必要です。トークンを会話本文へ貼り付けないでください。

推薦を受ける場合は `GET /candidates` の JSON を取得し、その `posts` を次のように渡します。

> `/candidates?limit=20&hours=24` の posts を読み、検索語の一致だけで選ばず、具体性、意外性、実用性、人間への洞察、画像の内容を見て候補を選んでください。各候補について、投稿 ID、URL、要約、推薦理由を返してください。候補がなければ「該当なし」と理由を書いてください。引用投稿は本文と quote の両方を比較してください。

Worker は反応数と投稿形式による足切りまで担当します。内容が本当に面白いか、どの理由で勧めるか、候補が0件でよいかは ChatGPT が判断します。Worker は ML、embedding、OpenAI API を使いません。

## 障害時の動き

外部 API の timeout・HTTP エラー・形式不正は source 単位で構造化ログに記録します。ほかのアカウントと検索語の処理は続けます。status の 204 は「新着なし」として成功扱いにし、アカウントの `last_checked_at` だけを更新します。アカウントは cursor なし fresh の失敗時に既存の backlog cursor を保持し、次回に fresh の後で同じ backlog を再試行します。status のページ途中で失敗した場合も cursor と固定した `since` を保持します。新しい fresh cursor は待ち行列に保持し、現在の backlog と待ち行列が終端するまで `last_post_timestamp` は進めません。検索語の latest 取得が成功すると `last_checked_at` を更新し、backlog の途中で失敗しても最新投稿と backlog cursor を保持して次回へ続けます。latest の取得失敗ではその検索語の保存を進めません。失敗したアカウントの時刻は進めませんが、選択した batch の巡回位置は進め、次の巡回で再試行します。検索結果の「404 + code:404 + 空の results」は新着なしとして checkpoint を更新します。検索語の巡回位置も成功・失敗にかかわらず進むため、失敗した検索語が後続の検索語を占有しません。一覧同期の full sync が失敗中または途中の場合は、旧アカウントの status 取得を行いません。一覧同期の full sync は全ページが成功した最後のページでだけ、前回同期にしか存在しないアカウントを削除します。収集全体の重複実行は期限付きリースで直列化し、取得できない実行は何もせず、プロセス異常終了後は期限切れで再開します。

投稿は X 投稿 ID を主キーに保存します。同じ Cron が重複実行されても投稿と checkpoint は重複せず、再取得した投稿の反応数、画像、表示数、ブックマーク数は更新されます。投稿保存と各 source の checkpoint は同じ D1 batch で更新します。アカウント一覧の upsert と各ページの投稿保存はmulti-row SQLにまとめ、全件成功後にだけ cursor と削除処理を更新します。

## 用語

- **following**: `SOURCE_HANDLE` がフォローしているアカウント一覧。
- **cursor**: following、アカウントの status、または検索語の次ページを指す上流 API の位置情報。
- **full sync marker**: 同期中に今回のページで確認したアカウントを識別する印。最後のページで古いアカウントを判定します。
- **quote**: 投稿が引用している投稿の JSON object。推薦判断の材料としてそのまま保存します。
- **D1**: この Worker が投稿、アカウント、検索語、収集位置を保存する SQLite 互換データベース。
- **リース**: 重複実行を防ぐ一時的な実行権。期限後は別の実行が取得できます。

このガイドで解決しない挙動は、実行した URL・source・構造化ログの `event` を添えて問い合わせてください。秘密値は貼らないでください。
