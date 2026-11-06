import { S3Client } from "bun";

const s3 = new S3Client({
  accessKeyId: Bun.env.S3_KEY,
  secretAccessKey: Bun.env.S3_SECRET,
  bucket: Bun.env.S3_BUCKET,
  endpoint: Bun.env.S3_ENDPOINT,
  region: "auto",
  virtualHostedStyle: true,
});
const PIN = Bun.env.TRAINER_PIN || "DG4D-2026";

const VENDOR = new Set(["jspdf.umd.min.js", "jspdf.plugin.autotable.min.js"]);
const PAGE = await Bun.file(import.meta.dir + "/index.html").text();
async function page(): Promise<string> { return PAGE; }

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
async function readResults(): Promise<Record<string, any>> {
  try {
    const f = s3.file("results.json");
    if (!(await f.exists())) return {};
    return JSON.parse(await f.text());
  } catch {
    return {};
  }
}
async function writeResults(r: Record<string, any>) {
  await s3.write("results.json", JSON.stringify(r), { type: "application/json" });
}

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  maxRequestBodySize: 2 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/results" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 60_000) return json({ error: "too large" }, 413);
      let r: any;
      try { r = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
      if (typeof r !== "object" || !r || typeof r.pct !== "number" || !r.ksa) return json({ error: "bad result" }, 400);
      const id = String(r.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      if (!id) return json({ error: "missing id" }, 400);
      r.id = id;
      r.received = Date.now();
      await serial(async () => {
        const all = await readResults();
        all[id] = r;
        await writeResults(all);
      });
      return json({ ok: true, id });
    }

    if (path === "/api/results" && req.method === "GET") {
      if (req.headers.get("x-pin") !== PIN) return json({ error: "wrong pin" }, 403);
      const all = await readResults();
      return json({ results: Object.values(all) });
    }

    if (path.startsWith("/api/results/") && req.method === "DELETE") {
      if (req.headers.get("x-pin") !== PIN) return json({ error: "wrong pin" }, 403);
      const id = decodeURIComponent(path.slice("/api/results/".length));
      await serial(async () => {
        const all = await readResults();
        delete all[id];
        await writeResults(all);
      });
      return json({ ok: true });
    }

    if (path === "/health") return json({ ok: true });

    if (req.method === "GET" && path.startsWith("/vendor/")) {
      const name = path.slice("/vendor/".length);
      if (VENDOR.has(name)) {
        return new Response(Bun.file(import.meta.dir + "/vendor/" + name), {
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
        });
      }
      return json({ error: "not found" }, 404);
    }

    if (req.method === "GET") {
      return new Response(await page(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log("DG simulation server running");
