# LIVE配信データ収集スクリプト セットアップ

毎朝のLIVE収集を、AIエージェントではなくスクリプトで回すための手順です。
判断が要らない決め打ちの処理しか無いので、スクリプトのほうが速く・確実で、トークンも消費しません。

---

## 1. 準備（初回のみ）

### 1-1. Playwrightをインストール

```
cd ~/Desktop/peak-live-tiktok
npm install playwright
npx playwright install chromium
```

### 1-2. スクリプト専用の合言葉を決める

ダッシュボードのBasic認証（DASH_USER / DASH_PASS）は社内で共有しているものなので、
スクリプトには持たせません。代わりに `COLLECT_KEY` という専用の合言葉を1つ決めて、
**Vercelとローカルの両方に同じ値**を設定します。値は何でも構いません（推測されにくい文字列にしてください）。

**Vercel側**: vercel.com → プロジェクト peak-live-tiktok → Settings → Environment Variables
→ Add Environment Variable → Key に `COLLECT_KEY`、Value に決めた文字列 → Production と Preview の両方にチェック → Save
→ 保存後、Deployments から最新のデプロイを Redeploy（環境変数は再デプロイしないと反映されません）

**ローカル側**:

```
echo 'export COLLECT_KEY="決めた文字列"' >> ~/.zshrc
source ~/.zshrc
```

### 1-3. TikTokにログインする

初回だけブラウザが開くので、そこでTikTok Shopセラーセンターにログインしてください。
ログイン状態は `scripts/.browser-profile/` に保存され、以降は自動で使われます。

```
node scripts/collect_lives.mjs --login
```

ログインが終わったらターミナルで Ctrl+C を押して終了します。

---

## 2. 実行

```
# 通常実行（直近7日の配信一覧＋紹介時間を4件ぶん収集）
node scripts/collect_lives.mjs

# バックフィルを多めに回す（過去分を一気に埋めたいとき）
node scripts/collect_lives.mjs --pins 10
```

実行結果は `scripts/collect_lives.log` に追記されます。

### 過去35配信を一晩で埋めたい場合

```
node scripts/collect_lives.mjs --pins 40
```

1配信あたり約2分なので、35本で70分ほどかかります。寝ている間に流しておけば翌朝には揃います。

---

## 3. 毎朝の自動実行（launchd）

`~/Library/LaunchAgents/com.harbor.bclive.collect.plist` を作ります。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.harbor.bclive.collect</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd ~/Desktop/peak-live-tiktok &amp;&amp; node scripts/collect_lives.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/bclive-collect.out</string>
  <key>StandardErrorPath</key><string>/tmp/bclive-collect.err</string>
</dict>
</plist>
```

登録します。

```
launchctl load ~/Library/LaunchAgents/com.harbor.bclive.collect.plist
```

`COLLECT_KEY` は `~/.zshrc` に書いてあれば `zsh -lc` 経由で読まれます。

---

## 4. 壊れたときの見分け方

スクリプトは失敗すると終了コード1で終わり、ログに理由を書きます。次のメッセージが出たら対応が必要です。

| メッセージ | 意味 | 対応 |
|---|---|---|
| TikTokのログインが切れています | セッション期限切れ | `--login` で入り直す |
| 合言葉(COLLECT_KEY)が違います | VercelとローカルでCOLLECT_KEYが不一致 | 両方を同じ値にしてVercelを再デプロイ |
| LIVE一覧が0件でした | 画面構造の変更 | Claudeに調査を依頼 |
| グラフの幅が想定外です | チャートの描画方法の変更 | 同上 |
| 紹介時間を1件も取得できませんでした | ツールチップの構造変更 | 同上 |

TikTok側の画面が変わるとスクリプトは黙って空データを返すのではなく、上記のように止まる作りにしてあります。

---

## 5. スケジュールタスクとの関係

Claudeの毎朝タスク（`bc-choice-live-collect`）は、このスクリプトが安定稼働したら無効化してください。
両方動くと同じデータを二重に取りに行くことになります（上書き保存なので壊れはしませんが無駄です）。

当面は、スクリプトが壊れたときの調査役としてClaudeを残しておくのが安全です。

---

## 6. 仕組みのメモ

このスクリプトが使っている2つの手法は、いずれもTikTokの画面構造を調べて見つけたものです。

**LIVE一覧の取得**: 一覧テーブルのDOMには `live_id` が含まれていません。Reactの内部プロパティ
（`__reactFiber$...`）を親方向に辿ると、行データの配列に `liveId` が入っているのでそこから取ります。

**紹介時間の取得**: グラフはcanvas描画なのでDOMから値を読めません。合成マウスイベント
（`pointermove` / `mousemove`）をcanvasに送るとツールチップが出るので、横方向に走査して
5分刻みのデータを集めます。刻み幅を変えて2回走査することで取りこぼしを防いでいます。

公式APIで取れないもの（自社LIVE一覧・ピン留め）だけをここで補い、それ以外
（流入元内訳・動画別実績・商品別実績・分単位実績）はサーバー側のAPIで取得しています。
