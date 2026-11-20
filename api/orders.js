// Vercel serverless function: stores orders in Redis (Upstash, added from Vercel Marketplace / Storage tab)
// GET  /api/orders  -> { orders: [...] }
// POST /api/orders  -> body: one order object, or { orders: [...] } ; saved by id (newer updatedAt wins)

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HASH = "kebda_sogo2_orders";

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function clean(o) {
  if (!o || typeof o !== "object") return null;
  if (typeof o.id !== "string" || !/^[a-z0-9]{4,40}$/i.test(o.id)) return null;
  const items = (Array.isArray(o.items) ? o.items : [])
    .filter((i) => i && typeof i.key === "string")
    .map((i) => ({
      key: String(i.key).slice(0, 20),
      qty: Math.max(1, Math.min(999, parseInt(i.qty, 10) || 1)),
      price: Number.isFinite(+i.price) ? +i.price : 0,
    }));
  return {
    id: o.id,
    num: Math.max(0, parseInt(o.num, 10) || 0),
    name: String(o.name || "").trim().slice(0, 60),
    items,
    total: items.reduce((s, i) => s + i.qty * i.price, 0),
    createdAt: +o.createdAt || Date.now(),
    updatedAt: +o.updatedAt || Date.now(),
    deleted: !!o.deleted,
    done: !!o.done,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) {
    return res.status(500).json({ error: "Database not connected (missing KV_REST_API_URL / KV_REST_API_TOKEN)" });
  }
  try {
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", HASH])) || [];
      const orders = [];
      for (let i = 1; i < flat.length; i += 2) {
        try { orders.push(JSON.parse(flat[i])); } catch (e) {}
      }
      return res.status(200).json({ orders });
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const list = (Array.isArray(body.orders) ? body.orders : [body]).map(clean).filter(Boolean).slice(0, 500);
      if (!list.length) return res.status(400).json({ error: "No valid orders" });
      const ids = list.map((o) => o.id);
      const existing = await redis(["HMGET", HASH, ...ids]);
      const args = ["HSET", HASH];
      let n = 0;
      list.forEach((o, i) => {
        let prev = null;
        try { prev = existing[i] ? JSON.parse(existing[i]) : null; } catch (e) {}
        if (!prev || o.updatedAt >= (prev.updatedAt || 0)) { args.push(o.id, JSON.stringify(o)); n++; }
      });
      if (n) await redis(args);
      return res.status(200).json({ ok: true, saved: n });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
