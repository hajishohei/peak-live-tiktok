// 全ページ・全APIに Basic 認証をかける（Vercel Edge Middleware・Hobbyプラン無料枠）
// - 社内共有: URL と「ユーザー名/パスワード」1組を共有。ブラウザが記憶するので入力は初回のみ。
// - 認証情報: Vercel 環境変数 DASH_USER / DASH_PASS に設定（設定後に再デプロイが必要）。
// - 例外（Basic認証をかけないパス）:
//   * /api/live_ingest … 別PCのHarboRボットが叩くため。代わりに LIVE_INGEST_KEY で保護（必ず設定すること）
//   * /api/callback   … TikTok OAuth のリダイレクト先（外部サービスはBasic認証を通せない）
//   * /favicon.svg    … 認証前のブラウザ挙動での余計なプロンプト防止
export const config = {
  matcher: ["/((?!api/live_ingest|api/callback|favicon.svg).*)"],
};

export default function middleware(req) {
  const user = process.env.DASH_USER || "";
  const pass = process.env.DASH_PASS || "";
  if (!user || !pass) {
    // 未設定のまま公開しない（fail closed）。設定手順をそのまま表示する。
    return new Response(
      JSON.stringify({ error: "認証が未設定です。Vercel の環境変数に DASH_USER / DASH_PASS を設定して再デプロイしてください。" }),
      { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const i = decoded.indexOf(":");
      const u = i >= 0 ? decoded.slice(0, i) : decoded;
      const p = i >= 0 ? decoded.slice(i + 1) : "";
      if (u === user && p === pass) return; // 認証OK → リクエストを通す
    } catch (e) { /* 不正なBase64は未認証扱い */ }
  }
  return new Response("認証が必要です / Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Peak TOKYO Dashboard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
