# peak-live-tiktok（PeaK TOKYO ライブ売上ダッシュボード / TikTok Shop版）

TikTok Shop Open API から注文データを取得・集計するWebアプリ。`peak-live-app`（Shopify版）の派生。

## コマンド

- デプロイ: `deploy.command`（Vercel）
- 進捗・仕様: `PROGRESS.md`、`原価在庫_設計書.md`、`配信時間連携_設計書.md` を必ず先に読む

## 構成

- `public/index.html` 画面 / `api/` serverless functions / `lib/` 共通ロジック / `scripts/` 補助スクリプト / `data/` ローカルデータ

## ルール

- 応答・コミットメッセージは日本語
- `.env.local`（TikTok Shop APIキー等）は読まない・変更しない・コミットしない
- `data/` は業務データ。削除・上書きは実行前にオーナーへ確認
- Desktopの `peak-live-tiktok.zip` は旧アーカイブ。参照しない（削除予定）
