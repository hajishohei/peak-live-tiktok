# Peak TOKYO ダッシュボード — レビュー用ガイド（AI粗探し用）

このツールは「TikTok Shop ライブコマースの売上分析ダッシュボード」です。別のAIに問題点を洗い出してもらうための案内です。**まず本ファイルを読ませ、次に下の優先順位でコードを読ませてください。**

## ⚠️ 先に注意（セキュリティ）
- **`.env.local` は共有しないでください**（TikTok Shopのアクセストークン等の秘密情報が入っています）。レビューには不要です。
- 購入者IDはスナップショットでは扱いに注意（顧客特定用に user_id / 受取人名を保持。保存先は非公開のVercel Blob）。この設計の是非もレビュー観点になります。

## 読むべきファイル（優先順位）
1. **`public/index.html`（約1,650行）** — フロント全部（HTML+CSS+JSの単一ファイル）。UI・集計表示・比較・並び替え・アコーディオン・モバイル対応など。
2. **`api/query.js`（約1,150行）** — バックエンドの心臓部。TikTok Shop APIコール、署名、トークン自動更新、注文スナップショット（Vercel Blob）、原価/粗利、返金(returns)、配信時間マージ、集計 `aggregate()`、比較用の light/compare モード、GET `?debug=live`。
3. `api/live_ingest.js` — 配信時間の取り込み口（保存/読取/一括入替）。
4. `api/snapshot.js` / `api/stock_snapshot.js` / `api/product_analytics.js` — 補助エンドポイント。
5. `api/auth.js` / `api/callback.js` — TikTok OAuth（初回認可）。
6. `api/order_probe.js` / `api/returns_probe.js` — 診断用（本番運用では不要になったら削除可）。
7. `package.json` / `scripts/build_*.js` — 依存とデータ生成スクリプト。
- **読まなくてよい**：`node_modules/`、`lib/*.js`（自動生成データ）、`data/*`（元データ）、`.env.local`（秘密）。

## アーキテクチャ / データフロー
- **配信形態**：Vercel のサーバーレス関数（`api/*.js`, ESM）＋ 静的SPA（`public/index.html`）。Hobbyプラン（関数は12個上限・実行時間制限あり）。
- **データ源**：TikTok Shop Open API（注文 `order/202309`、商品 `product/202309`、返金 `return_refund/202309`、分析 `analytics/202405`）。HMAC-SHA256署名 + `x-tts-access-token`。トークンは失効時に refresh で自動更新。
- **永続化**：Vercel Blob（非公開）に「注文スナップショット」「配信時間 日次」「商品在庫」等をキャッシュ。毎回は直近ぶんだけAPI取得して合体（`getAllOrders` は直近45日を再取得して最新項目で上書き）。
- **原価**：SD（スーパーデリバリー）仕入れ実績＝実原価。非SD＝売価×係数(既定50%)の推定。ブランドは商品名から自動推定。
- **配信時間**：TikTok LIVE Backstage から別PCのスケジュールタスクが日次取得→ `/api/live_ingest`（Blob）→ ダッシュボードが集計。「配信1時間あたり売上」等を算出。
- **主要指標**：売上(返金差引後・TT負担クーポン込み)、粗利、AOV、新規/リピート、キャンセル(発送前)、返品(発送後)、配信効率、期間比較。

## 特に粗探ししてほしい観点（意図的仕様は誤検知しないよう明記）
- **タイムゾーン**：集計はJST基準、TikTok APIはUTC epoch。JST/UTC変換の境界バグがないか（`jst()`, `resolveRange`, 日次配信時間の窓）。
- **パフォーマンス/タイムアウト**：Hobbyの実行時間制限。`/api/query` は注文+返金+商品+45日再取得と重い。ドリルや比較で `light`/`compare` モードにより一部を省略している。冷スタート時のタイムアウトリスク。
- **売上の定義**：`sales = 顧客支払(total_amount) + TT負担クーポン(platform_discount + shipping_fee_platform_discount) − 返金(該当注文のみ)`。二重計上/取りこぼしがないか（発送前キャンセルは未計上なので引かない、返金済みのみ引く、という設計）。
- **返金(returns)**：`return_refund/202309/returns/search` を直近400日取得。期間表示は「その期間の注文に紐づく返金」に限定。累計/今月の数え方、CANCELLED扱いの返金との排他。
- **スナップショット整合性**：`getAllOrders` の自動ロール/45日再取得で、古い項目（buyer_name, tt_funded 等）が欠ける期間がないか。
- **エラーハンドリング**：APIコール失敗時に画面が固まらないか（try/catchの網羅、`?list=1` 等の読取専用の安全性、無限「読み込み中」対策）。
- **セキュリティ**：署名生成、トークン更新、購入者PII（user_id/氏名）の保持と表示、Blobの公開範囲、診断エンドポイントの露出。
- **推定の妥当性**：ブランド自動推定（`brandFromTitle`）、非SD原価の係数推定、商品名マッチング（`matchBase`）の誤マッチ。
- **フロントの堅牢性**：単一HTMLの巨大さ、localStorageキー、並び替え/アコーディオン/比較のイベント多重登録、モバイル(≤640px)崩れ。
- **数値の一貫性**：日別・週別・月別の配信時間合計が一致するか、キャンセル(件数)とTTS(点数)の差の説明、比較タブの差分/変化率の符号・色。

## 動かし方 / 検証
- デプロイ：フォルダ内 `deploy.command` をダブルクリック（`vercel --prod`）。
- 静的検証：`node --check api/query.js`。フロントJSは `<script>` を抽出して構文チェック。
- 本番診断（GET・読取専用）：`/api/query?debug=live`（配信データ）、`/api/live_ingest?list=1`（保存済み配信時間）。
- データ生成：`node scripts/build_costs.js` / `build_livehours.js` / `build_purchases.js`（出力は `lib/`）。

## 既知の制約（バグではない・設計判断）
- 非SDブランドの「仕入れ実績（何個・いつ・いくら）」は未整備（商品DB化は方針決め待ち）。現状の個別ブランド原価は販売×推定原価。
- @ユーザー名はTikTok APIから取得不可。購入者は数値user_id＋受取人名（マスクの場合あり）で表示。
- 配信時間はBackstageが1〜2日遅れて確定。直近数日は暫定/空になり得る。
- ランキング`data.json`側は別プロダクト（当月書き込みは別課題）。ダッシュボードは日次パイプラインで独立。
