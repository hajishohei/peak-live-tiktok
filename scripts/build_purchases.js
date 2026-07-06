// SD仕入履歴テキスト(data/仕入履歴*.txt)から、日付・購入先つきの仕入台帳を生成する。
// 出力: api/purchases.js （請求書照合用。何月にどの商品をいくらで何個仕入れたか）
// 使い方: セラー(SD)の仕入履歴を data/仕入履歴_pageN.txt として保存 → node scripts/build_purchases.js → 再デプロイ
//
// 入力フォーマット（1注文ブロック）:
//   注文日時 2026年6月22日 15:16 購入先 ゼノンインターナショナル
//   <注文ID>|<商品名>|<カラー>|<SKU>|<メーカー品番>|<バーコード>|<原価>|<数量>
//   ...（同じ購入先の明細が続く）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT = path.join(__dirname, "..", "lib", "purchases.js");

// SKU(例 15171630S2) から base(8桁の品番) を取り出す
function baseFromSku(sku) {
  const m = String(sku || "").match(/(\d{6,})\s*S?\d*$/i);
  if (m) return m[1].slice(0, 8);
  const d = String(sku || "").match(/\d{8}/);
  return d ? d[0] : "";
}
function toISODate(s) {
  const m = String(s || "").match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

function parseFile(text) {
  const rows = [];
  let curDate = "", curVendor = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^注文日時\s+(.+?)\s+購入先\s+(.+)$/);
    if (head) { curDate = toISODate(head[1]); curVendor = head[2].trim(); continue; }
    if (!line.includes("|")) continue;
    const f = line.split("|");
    if (f.length < 8) continue;
    const [orderId, name, color, sku, maker, , costStr, qtyStr] = f;
    const cost = Number(String(costStr).replace(/[^\d.]/g, "")) || 0;
    const qty = Number(String(qtyStr).replace(/[^\d.]/g, "")) || 0;
    if (!cost && !qty) continue;
    rows.push({
      date: curDate, vendor: curVendor, orderId: String(orderId).trim(),
      base: baseFromSku(sku), name: String(name).trim(), color: String(color).trim(),
      sku: String(sku).trim(), maker: String(maker).trim(), cost, qty,
    });
  }
  return rows;
}

const files = fs.readdirSync(DATA_DIR).filter((f) => /仕入履歴.*\.txt$/.test(f)).sort();
let all = [];
for (const f of files) {
  const rows = parseFile(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  console.log(`  ${f}: ${rows.length} 明細`);
  all = all.concat(rows);
}
// 重複(同一注文ID+SKU)を排除
const seen = new Set();
all = all.filter((r) => { const k = r.orderId + "|" + r.sku; if (seen.has(k)) return false; seen.add(k); return true; });

const dates = all.map((r) => r.date).filter(Boolean).sort();
const meta = {
  builtAt: new Date().toISOString(),
  sources: files,
  rows: all.length,
  dateMin: dates[0] || null,
  dateMax: dates[dates.length - 1] || null,
};
const body =
  "// 自動生成: SD仕入履歴(日付・購入先つき)の仕入台帳。請求書照合用。\n" +
  `// 生成: ${meta.builtAt} / 明細 ${meta.rows} 件 / 期間 ${meta.dateMin || "?"}〜${meta.dateMax || "?"}\n` +
  "// 更新方法: data/仕入履歴_pageN.txt を追加→ node scripts/build_purchases.js → 再デプロイ\n" +
  `export const PURCHASES_META = ${JSON.stringify(meta)};\n` +
  `export const PURCHASES = ${JSON.stringify(all)};\n`;
fs.writeFileSync(OUT, body);
console.log(`生成: ${OUT}  (${meta.rows}件, ${meta.dateMin}〜${meta.dateMax})`);
