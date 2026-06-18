# Peak TOKYO ライブ売上ダッシュボード（Vercel + TikTok Shop API）

URLを開くたびに **TikTok Shop** から最新の注文データを取得して集計表示するライブWebアプリです。
Shopify版（`peak-live-app`）の画面・構成をベースに、データ取得元を TikTok Shop Open API に置き換えたものです。

```
peak-live-tiktok/
├─ public/index.html   ← 画面（ダッシュボード。/api/query を叩く）
├─ api/query.js        ← TikTok Shop API プロキシ（署名+注文集計。トークンはサーバー側のみ）
├─ api/auth.js         ← OAuth 開始（/api/auth → 認可画面へ）
├─ api/callback.js     ← OAuth コールバック（auth_code → access_token 交換して表示）
├─ package.json
└─ README.md（このファイル）
```

---

## 背景（Shopify版との違い・重要）
- TikTok Shop の Open API は **app_key / app_secret による署名（HMAC-SHA256）** と **OAuth で取得した access_token**（ヘッダ `x-tts-access-token`）で認証します。
- 認可リンクのドメインはマーケットで異なり、**日本は ROW 扱い**で `services.tiktokshop.com` を使います（US は `services.tiktokshops.us`）。
- access_token は **約7日で失効**します（refresh_token で更新）。当面は失効時に再認可 or リフレッシュで対応。
- **顧客LTV / 全期間リピート率 / ロイヤル顧客ランキング**は、Shopify の顧客API（顧客単位の累計購入額）に依存していた機能で、TikTok Shop には同等APIが無いため、現状は「期間内のバイヤーID重複」による参考値です（顧客タブに注記あり）。全期間LTV相当は追加実装で対応可能。

## 既に用意が必要なもの（TikTok Shop Partner Center）
- アプリ（App）: Partner Center で作成
- App Key / App Secret / Service ID: アプリ詳細ページで取得
- スコープ（API権限）: 注文管理（Order）必須。商品・財務なども必要に応じて
- Redirect URL: 本アプリの `https://<vercel-domain>/api/callback` を登録

Partner Center: https://partner.tiktokshop.com/

---

## 認証情報の取得手順（app_key / app_secret / service_id）

1. **Partner Center にログイン** → https://partner.tiktokshop.com/
2. 左メニュー **App & Service → Manage apps**（アプリ管理）を開く。
3. 目的のアプリを選ぶ（無ければ **Create app** で作成。Custom App でOK。名前・カテゴリ・対象マーケット=Japan を設定）。
4. アプリ詳細ページの **Developing → Credentials**（資格情報）に以下が表示されます:
   - **App key**（= app_key。コピーアイコンで取得）
   - **App secret**（= app_secret。「Manage app secret」から表示/再発行）
   - **Service ID**（= service_id。認可リンクに使用）
5. **Basic Information → Manage API**（または「Access scope」）で、**Order（注文）系のスコープ**が有効か確認。無ければ申請（審査に2〜3営業日かかる場合あり）。
6. **Redirect URL** 欄に `https://<vercel-domain>/api/callback` を入力して保存（手順はデプロイ後に確定）。

> メモ: App secret は一度しか平文表示されないことがあります。表示されたら安全な場所に控えてください（コードには書きません）。

---

## セットアップ手順（開発者）

### 1. Vercel にデプロイ
このフォルダを GitHub に push → Vercel で Import（Framework: Other）→ Deploy。
発行URL（例 `https://peak-live-tiktok.vercel.app`）を控える。

### 2. Vercel 環境変数を設定
| 名前 | 値 |
|---|---|
| `TTS_APP_KEY` | アプリの App key |
| `TTS_APP_SECRET` | アプリの App secret |
| `TTS_SERVICE_ID` | アプリの Service ID |
| `TTS_REGION` | `JP`（日本=ROM。US の場合のみ `US`） |
| `TTS_SHOP` | 店舗の表示名（任意・ラベル用） |

（`TTS_ACCESS_TOKEN` / `TTS_REFRESH_TOKEN` は手順4で取得後に追加）

### 3. Partner Center で Redirect URL を設定
アプリ詳細の **Redirect URL** に `https://<vercel-domain>/api/callback` を登録して保存。

### 4. インストール（認可）してトークンを取得
ブラウザで以下を開く:
```
https://<vercel-domain>/api/auth
```
→ TikTok Shop の認可画面でショップを選び承認 → `/api/callback` に戻り、**access_token / refresh_token** が表示される。

### 5. トークンを環境変数に設定 → 再デプロイ
Vercel 環境変数に追加:
| `TTS_ACCESS_TOKEN` | 手順4で表示された access_token |
| `TTS_REFRESH_TOKEN` | 手順4で表示された refresh_token |

→ Redeploy。

### 6. 確認
`https://<vercel-domain>/` を開く → ダッシュボードに売上・商品・日別・時間帯が表示されれば完了。

---

## データ取得の仕組み
- フロント `public/index.html` は `POST /api/query`（`{mode:"dashboard", since, until}`）を呼ぶ。
- `api/query.js` がサーバー側で **署名を付与**し、`x-tts-access-token` を付けて TikTok Shop Open API を呼ぶ。トークンはブラウザに出ない。
  - 認可済みショップ: `GET /authorization/202309/shops`（`shop_cipher` を取得）
  - 注文検索: `POST /order/202309/orders/search`（期間内を全ページ取得）
- 取得した注文を**サーバー側で集計**（総売上・注文数・AOV・販売個数・商品別・日別・時間帯/曜日別・期間内リピート率）して返す。
- 売上集計は注文の `payment.total_amount`、商品別は注文明細 `line_items`（1明細=1個として個数カウント、`sale_price` を売上計上）。`CANCELLED` / `UNPAID` は集計から除外。

## 署名アルゴリズム（公式準拠・api/query.js の `calcSign`）
1. `sign` と `access_token` を除く全クエリパラメータを辞書順ソート
2. `{key}{value}` を連結し、先頭に API パスを付与
3. Content-Type が multipart でなければ JSON body を末尾に付与
4. `app_secret` で前後を包む → HMAC-SHA256 → 16進小文字

## トラブルシュート
- `/api/query` が error → 応答メッセージを確認。`code`/`message` が TikTok 側のエラー。
- 署名エラー（sign 不一致）→ `TTS_APP_SECRET` が正しいか、サーバー時刻ズレが無いか確認。
- 認可で example.com 等に飛ぶ／コールバックが来ない → Partner Center の **Redirect URL** が Vercel の `/api/callback` になっているか確認。
- access_token 失効（約7日）→ 再度 `/api/auth` で認可し直す（将来 refresh 自動化を実装予定）。
- 注文が0件 → 期間・ショップ認可状態・Order スコープを確認。

## アクセス制限（推奨）
URLを知っていれば誰でも開けるため、社内限定にするなら Vercel の Deployment Protection（Vercel Authentication / Password）を有効化。

## 今後の拡張（次フェーズ候補）
- 顧客台帳の内部構築（長期間の注文取得 → 顧客単位の累計でLTV/全期間リピート率/ロイヤル顧客ランキングを Shopify版同等に）
- access_token の自動リフレッシュ（`/api/refresh` cron）
- 配信・担当者タブ（シフト/ライブ予定の手入力×注文の時間帯マッチング）の移植
