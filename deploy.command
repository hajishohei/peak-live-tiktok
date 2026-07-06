#!/bin/bash
# Peak TOKYO ダッシュボード デプロイ用スクリプト
# このファイルをダブルクリックすると本番(Vercel)へデプロイします。
# 初回はブラウザでVercelログイン＆プロジェクト選択(peak-live-app)を聞かれます。
cd "$(dirname "$0")" || exit 1
echo "==> Peak TOKYO ダッシュボードを Vercel にデプロイします"
echo "==> フォルダ: $(pwd)"
echo ""
npx --yes vercel@latest --prod
echo ""
echo "==> 完了しました。上に表示された Production URL を確認してください。"
echo "（このウィンドウは閉じて大丈夫です）"
