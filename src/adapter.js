// Vercel Node 関数の (req, res) を Workers の Request/Response に変換する最小アダプター。
// api/*.js が使う範囲だけ実装: req.method/query/body/headers/url, res.status/json/send/setHeader/writeHead/end/redirect/statusCode
export async function vercelAdapter(handler, request) {
  const url = new URL(request.url);
  const query = {};
  for (const [k, v] of url.searchParams) {
    query[k] = k in query ? [].concat(query[k], v) : v;
  }
  const headers = Object.fromEntries(request.headers);
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    const ct = headers["content-type"] || "";
    if (ct.includes("application/json")) { try { body = text ? JSON.parse(text) : {}; } catch (e) { body = text; } }
    else if (ct.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(text));
    else body = text;
  }
  const req = { method: request.method, url: url.pathname + url.search, headers, query, body };

  return new Promise((resolve, reject) => {
    const out = new Headers();
    let done = false;
    const res = {
      statusCode: 200,
      setHeader(k, v) { out.delete(k); for (const x of [].concat(v)) out.append(k, String(x)); return res; },
      getHeader(k) { return out.get(k); },
      status(c) { res.statusCode = c; return res; },
      writeHead(c, h) { res.statusCode = c; for (const [k, v] of Object.entries(h || {})) res.setHeader(k, v); return res; },
      end(data) {
        if (done) return res;
        done = true;
        resolve(new Response(data == null ? null : data, { status: res.statusCode, headers: out }));
        return res;
      },
      send(data) {
        if (data !== null && typeof data === "object") return res.json(data);
        if (!out.has("Content-Type")) out.set("Content-Type", "text/html; charset=utf-8");
        return res.end(data);
      },
      json(obj) {
        if (!out.has("Content-Type")) out.set("Content-Type", "application/json; charset=utf-8");
        return res.end(JSON.stringify(obj));
      },
      redirect(a, b) {
        const [code, loc] = typeof a === "number" ? [a, b] : [307, a];
        return res.writeHead(code, { Location: loc }).end();
      },
    };
    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => { if (!done) res.end(); })
      .catch((e) => {
        if (!done) { done = true; resolve(new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } })); }
        else reject(e);
      });
  });
}
