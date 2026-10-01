#!/bin/zsh
# BCチョイス LIVE収集スクリプトを、毎朝9時に自動実行するよう登録する（macOS launchd）
#
# 使い方:
#   zsh scripts/install_daily.sh            登録（すでにあれば入れ直し）
#   zsh scripts/install_daily.sh --uninstall 登録解除
#   zsh scripts/install_daily.sh --run-now   登録して今すぐ1回動かす（動作確認用）
#
# 手書きのplistだと動かない理由と、このスクリプトでの対処:
#   1) launchd から起動したシェルは ~/.zshrc を読まないので、COLLECT_KEY が入らない
#      → いまのターミナルの COLLECT_KEY を読み取り、plist の環境変数に直接書き込む
#   2) launchd の PATH は最小限なので node が見つからない
#      → いまの node の絶対パスを解決して plist に書き込む
#   Macがスリープ中で9時を過ぎた場合は、起きたときに1回実行される（launchdの仕様）。

set -e
LABEL="com.harbor.bclive.collect"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_OUT="$REPO/scripts/launchd.out.log"
LOG_ERR="$REPO/scripts/launchd.err.log"

if [[ "$1" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "登録を解除しました。"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node が見つかりません。Node.js をインストールしてから実行してください。"; exit 1
fi
if [[ -z "$COLLECT_KEY" ]]; then
  echo "COLLECT_KEY が未設定です。先に次を実行してください:"
  echo "  echo 'export COLLECT_KEY=\"（Vercelに登録した合言葉）\"' >> ~/.zshrc && source ~/.zshrc"
  exit 1
fi
if [[ ! -d "$REPO/scripts/.browser-profile" ]]; then
  echo "TikTokのログイン情報（scripts/.browser-profile）がまだありません。先に次を実行してください:"
  echo "  node scripts/collect_lives.mjs --login"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
# 合言葉を含むので、本人以外が読めないように作る
umask 077
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/scripts/collect_lives.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COLLECT_KEY</key><string>$COLLECT_KEY</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG_OUT</string>
  <key>StandardErrorPath</key><string>$LOG_ERR</string>
</dict>
</plist>
PLISTEOF

# 入れ直しに対応するため、いったん外してから登録する
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "登録しました。毎朝9:00に自動で収集します。"
echo "  node: $NODE_BIN"
echo "  ログ: scripts/collect_lives.log（結果） / scripts/launchd.err.log（エラー）"

if [[ "$1" == "--run-now" ]]; then
  echo "今すぐ1回実行します…（1〜2分）"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  sleep 3
  echo "実行を開始しました。結果は scripts/collect_lives.log の末尾で確認できます:"
  echo "  tail -5 scripts/collect_lives.log"
fi
