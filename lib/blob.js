// @vercel/blob の get/put と同じ形で Cloudflare R2（バインディング名 DATA）を読み書きする薄いラッパー。
// 既存コードの `res.statusCode === 200 && res.stream` / `put(path, body, { contentType })` をそのまま使える。
import { env } from "cloudflare:workers";

export function blobConfigured() {
  return !!(env && env.DATA);
}
export async function get(path) {
  const obj = await env.DATA.get(path);
  return obj ? { statusCode: 200, stream: obj.body } : null;
}
export async function put(path, body, opts = {}) {
  await env.DATA.put(path, body, { httpMetadata: { contentType: opts.contentType || "application/json" } });
  return { pathname: path };
}
