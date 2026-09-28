// LIVEセッション（配信1回ごと・紹介時間つき）の保存/読み出し。
// middleware.js のBasic認証が効く配下に置いてあるため、ブラウザでダッシュボードにログイン済みなら
// そのままfetchで書き込める（スケジュールタスクがAPIキーを持ち回らなくて済む）。
//
// GET  /api/live_sessions                 … 保存済み一覧（サマリ）
// GET  /api/live_sessions?full=1          … pins込みの全データ
// POST /api/live_sessions  {sessions:[…]} … 登録・更新（liveIdをキーに上書き）
import { loadLiveSessions, saveLiveSessions } from "./query.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
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
