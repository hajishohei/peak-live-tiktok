#!/bin/bash
# Peak TOKYO ダッシュボード デプロイ用スクリプト
# このファイルをダブルクリックすると本番(Cloudflare Workers)へデプロイします。
# 初回はブラウザで Cloudflare ログインを聞かれます。通常は GitHub push で自動デプロイされます。
cd "$(dirname "$0")" || exit 1
echo "==> Peak TOKYO ダッシュボードを Cloudflare Workers にデプロイします"
echo "==> フォルダ: $(pwd)"
echo ""
npx --yes wrangler deploy
echo ""
echo "==> 完了しました。上に表示された Production URL を確認してください。"
echo "（このウィンドウは閉じて大丈夫です）"
