// OAuth 開始: /api/auth
// TikTok Shop の認可（Service Marketplace）へリダイレクトする。
// 日本 (ROW=rest of the world) は services.tiktokshop.com を使用。
export default function handler(req, res) {
  const SERVICE_ID = process.env.TTS_SERVICE_ID;
  const REGION = (process.env.TTS_REGION || "JP").toUpperCase();
  if (!SERVICE_ID) {
    res.status(500).send("TTS_SERVICE_ID が未設定です（Partner Center → アプリ → Service ID）");
    return;
  }
  // 認可リンクのドメインはマーケットで異なる。
  // US: services.tiktokshops.us / それ以外(日本含む ROW): services.tiktokshop.com
  const base =
    REGION === "US"
      ? "https://services.tiktokshops.us/open/authorize"
      : "https://services.tiktokshop.com/open/authorize";
  const state = Math.random().toString(36).slice(2);
  const url = `${base}?service_id=${encodeURIComponent(SERVICE_ID)}&state=${state}`;
  res.setHeader("Set-Cookie", `tts_state=${state}; Path=/; HttpOnly; SameSite=Lax`);
  res.writeHead(302, { Location: url });
  res.end();
}
