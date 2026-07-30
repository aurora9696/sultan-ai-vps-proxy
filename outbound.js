// ============================================================================
// Outbound Relay — semua request keluar aplikasi ditembakkan dari server ini,
// bukan dari edge function. IP asli infrastruktur tidak pernah terlihat provider.
//
// Alur: Edge Function --(HMAC signed)--> /out --(upstream proxy opsional)--> Provider
//
// ENV:
//   OUTBOUND_RELAY_SECRET   (wajib) shared secret HMAC, sama dengan di backend
//   OUTBOUND_PROXIES        (opsional) daftar proxy upstream dipisah koma:
//                           http://user:pass@host:port,http://user:pass@host2:port
//   OUTBOUND_ALLOW_DIRECT   "1" = boleh direct kalau proxy tidak ada (default 1)
// ============================================================================
const crypto = require("crypto");
const express = require("express");
const { ProxyAgent, request: undiciRequest } = require("undici");

const SECRET = process.env.OUTBOUND_RELAY_SECRET || "";
const ALLOW_DIRECT = (process.env.OUTBOUND_ALLOW_DIRECT ?? "1") !== "0";
const MAX_SKEW_MS = 5 * 60 * 1000;

const POOL = (process.env.OUTBOUND_PROXIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let rr = 0;
function pickPoolProxy() {
  if (!POOL.length) return null;
  rr = (rr + 1) % POOL.length;
  return POOL[rr];
}

const agentCache = new Map();
function agentFor(url) {
  if (!url) return undefined;
  if (!agentCache.has(url)) agentCache.set(url, new ProxyAgent(url));
  return agentCache.get(url);
}

function verify(rawBody, ts, sig) {
  if (!SECRET) return false;
  if (!ts || !sig) return false;
  const drift = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(drift) || drift > MAX_SKEW_MS) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const router = express.Router();

router.get("/out/health", (_req, res) =>
  res.json({ ok: true, configured: Boolean(SECRET), proxies: POOL.length, allowDirect: ALLOW_DIRECT }),
);

router.post("/out", express.text({ type: "*/*", limit: "60mb" }), async (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  if (!verify(raw, req.get("x-relay-ts"), req.get("x-relay-sign"))) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: "bad_payload" });
  }

  const { url, method = "GET", headers = {}, bodyB64 = null, proxy = null, timeoutMs = 120000 } = spec;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "bad_url" });

  const chosen = proxy || pickPoolProxy();
  if (!chosen && !ALLOW_DIRECT) return res.status(502).json({ error: "no_proxy_available" });

  const outHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (["host", "content-length", "connection", "x-relay-ts", "x-relay-sign"].includes(lk)) continue;
    if (lk.startsWith("x-supabase") || lk === "x-deno-subhost" || lk === "x-client-info") continue;
    outHeaders[k] = v;
  }

  const body = bodyB64 ? Buffer.from(bodyB64, "base64") : undefined;

  const send = async (proxyUrl) =>
    undiciRequest(url, {
      method,
      headers: outHeaders,
      body,
      dispatcher: agentFor(proxyUrl),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 5,
    });

  let upstream;
  try {
    upstream = await send(chosen);
  } catch (err) {
    if (chosen && ALLOW_DIRECT) {
      try {
        upstream = await send(null);
      } catch (err2) {
        return res.status(502).json({ error: "upstream_failed", detail: String(err2?.message || err2).slice(0, 200) });
      }
    } else {
      return res.status(502).json({ error: "upstream_failed", detail: String(err?.message || err).slice(0, 200) });
    }
  }

  const passthrough = {};
  for (const [k, v] of Object.entries(upstream.headers || {})) {
    const lk = k.toLowerCase();
    if (["content-encoding", "transfer-encoding", "connection", "content-length"].includes(lk)) continue;
    passthrough[lk] = Array.isArray(v) ? v.join(", ") : v;
  }

  res.status(200);
  res.setHeader("x-relay-status", String(upstream.statusCode));
  res.setHeader("x-relay-headers", Buffer.from(JSON.stringify(passthrough)).toString("base64"));
  res.setHeader("x-relay-egress", chosen ? "proxy" : "direct");
  if (passthrough["content-type"]) res.setHeader("content-type", passthrough["content-type"]);
  upstream.body.pipe(res);
});

module.exports = { outboundRouter: router };
