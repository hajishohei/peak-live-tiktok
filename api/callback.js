// OAuth コールバック: リダイレクトURLに ?code=... が返る。
// auth_code を access_token に交換して画面に表示する（トークンは環境変数へ手動設定）。
// トークン交換エンドポイントは署名不要（auth ドメイン）。
export default async function handler(req, res) {
  const APP_KEY = process.env.TTS_APP_KEY;
  const APP_SECRET = process.env.TTS_APP_SECRET;
  const q = req.query || {};
  const code = q.code;
  const error = q.error;
  const send = (t) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      "<pre style='font-family:monospace;white-space:pre-wrap;padding:20px;line-height:1.6'>" + t + "</pre>"
    );
  };
  if (!APP_KEY || !APP_SECRET) {
    send("ENV未設定: TTS_APP_KEY=" + !!APP_KEY + " / TTS_APP_SECRET=" + !!APP_SECRET);
    return;
  }
  if (error || !code) {
    send("認可がキャンセル/失敗しました。受信パラメータ: " + JSON.stringify(q));
    return;
  }
  try {
    const url =
      "https://auth.tiktok-shops.com/api/v2/token/get" +
      "?app_key=" + encodeURIComponent(APP_KEY) +
      "&app_secret=" + encodeURIComponent(APP_SECRET) +
      "&auth_code=" + encodeURIComponent(code) +
      "&grant_type=authorized_code";
    const r = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch (e) {}
    const data = j.data || {};
    const at = data.access_token;
    const rt = data.refresh_token;
    if (at) {
      send(
        "✅ 成功！\n\n" +
        "以下を Vercel の環境変数に設定して Redeploy してください:\n\n" +
        "── TTS_ACCESS_TOKEN ──\n" + at + "\n\n" +
        "── TTS_REFRESH_TOKEN ──\n" + (rt || "(なし)") + "\n\n" +
        "access_token 有効期限(秒): " + (data.access_token_expire_in || "?") + "\n" +
        "refresh_token 有効期限(秒): " + (data.refresh_token_expire_in || "?") + "\n" +
        "seller_name: " + (data.seller_name || "") + "\n" +
        "open_id: " + (data.open_id || "") + "\n\n" +
        "(access_token 先頭: " + at.slice(0, 8) + " / 長さ: " + at.length + ")"
      );
    } else {
      send(
        "❌ トークン取得に失敗しました。\n" +
        "HTTP " + r.status + "\n" +
        "code=" + (j.code != null ? j.code : "?") + " message=" + (j.message || "") + "\n\n" +
        "応答(先頭600字):\n" + text.slice(0, 600)
      );
    }
  } catch (e) {
    send("通信エラー: " + String(e));
  }
}
