// Vercel Blob の中身を blob-export/ に丸ごと保存する（Cloudflare R2 への移行用・1回だけ使う）。
// 使い方: BLOB_READ_WRITE_TOKEN=（Vercel → Storage → Blobストア → .env.local タブの値） node scripts/export_vercel_blob.mjs
// 保存後、Cloudflare → R2 → peak-live-tiktok-data → Upload で blob-export/ 内のファイルをそのまま（同じファイル名で）アップロードする。
// blob-export/ は業務データ・トークンを含むので .gitignore 済み。コミットしないこと。
import fs from "node:fs";
import path from "node:path";
import { list, get } from "@vercel/blob";

if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error("BLOB_READ_WRITE_TOKEN が未設定です"); process.exit(1); }
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "blob-export");
fs.mkdirSync(OUT, { recursive: true });
let cursor;
do {
  const page = await list({ cursor });
  for (const b of page.blobs) {
    const r = await get(b.pathname, { access: "private" });
    if (!r || r.statusCode !== 200 || !r.stream) { console.log("skip", b.pathname); continue; }
    const file = path.join(OUT, b.pathname);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await new Response(r.stream).arrayBuffer()));
    console.log("saved", b.pathname, b.size, "bytes");
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log("完了:", OUT);
