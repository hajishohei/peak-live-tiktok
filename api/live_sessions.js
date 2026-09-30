// LIVEセッション（配信1回ごと・紹介時間つき）の保存/読み出し。
//
// このエンドポイントは middleware.js のBasic認証の対象外にしてある。
// ローカルの収集スクリプト(scripts/collect_lives.mjs)から叩くのに、社内共有している
// ダッシュボードのパスワードをスクリプトに持たせたくないため。
// 代わりに COLLECT_KEY（このスクリプト専用の合言葉）を必須にしている。
//
// GET  /api/live_sessions?key=xxx            … 保存済み一覧（サマリ）
// GET  /api/live_sessions?key=xxx&full=1     … pins込みの全データ
// POST /api/live_sessions  {key, sessions:[…]} … 登録・更新（liveIdをキーに上書き）
import { loadLiveSessions, saveLiveSessions } from "./query.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    // 合言葉の確認。未設定のまま公開しない（fail closed）。
    const need = process.env.COLLECT_KEY;
    if (!need) {
      res.status(200).json({ ok: false, error: "COLLECT_KEY が未設定です。Vercelの環境変数に設定してください（このエンドポイントはBasic認証の対象外のため必須）" });
      return;
    }
    let bodyForKey = req.body;
    if (typeof bodyForKey === "string") { try { bodyForKey = JSON.parse(bodyForKey); } catch (e) { bodyForKey = {}; } }
    const given = String((req.query && req.query.key) || (bodyForKey && bodyForKey.key) || "");
    if (given !== String(need)) {
      res.status(200).json({ ok: false, error: "合言葉(key)が違います" });
      return;
    }
    if (req.method === "POST") {
      let p = req.body;
      if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = {}; } }
      let arr = (p || {}).sessions;
      if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (e) { arr = null; } }
      if (!Array.isArray(arr) || !arr.length) {
        res.status(200).json({ ok: false, error: "sessions（配列）が必要です" }); return;
      }
      const r = await saveLiveSessions(arr);
      res.status(200).json({ ok: true, saved: r.saved, totalSessions: r.total });
      return;
    }
    const cur = await loadLiveSessions();
    const all = Object.values(cur || {}).sort((a, b) => String(b.date + (b.startTime || "")).localeCompare(String(a.date + (a.startTime || ""))));
    if (String((req.query || {}).full || "") === "1") {
      res.status(200).json({ ok: true, total: all.length, sessions: all }); return;
    }
    res.status(200).json({
      ok: true, total: all.length,
      sessions: all.map((s) => ({
        liveId: s.liveId, date: s.date, startTime: s.startTime, endTime: s.endTime,
        durationSec: s.durationSec, durationMin: s.durationSec ? Math.round(s.durationSec / 60) : null,
        gmv: s.gmv, units: s.units, viewers: s.viewers, impressions: s.impressions,
        pinCount: (s.pins || []).length, updatedAt: s.updatedAt,
      })),
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
