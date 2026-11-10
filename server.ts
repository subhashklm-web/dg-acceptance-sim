import { S3Client } from "bun";
import { createHmac } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";

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
const CERT = await Bun.file(import.meta.dir + "/certificate.html").text();
const PAGE = await Bun.file(import.meta.dir + "/index.html").text();
const PAGE_4E = await Bun.file(import.meta.dir + "/index-4e.html").text();

// ---- storage helpers (one JSON file per collection in the bucket) ----
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
// Storage: files on the Railway volume (DATA_DIR, e.g. /data); S3 bucket only if no DATA_DIR is set.
const DATA_DIR = Bun.env.DATA_DIR || "";
if (DATA_DIR) mkdirSync(DATA_DIR, { recursive: true });
async function readJSON(name: string, fallback: any) {
  try {
    if (DATA_DIR) {
      const f = Bun.file(DATA_DIR + "/" + name);
      if (!(await f.exists())) return fallback;
      return JSON.parse(await f.text());
    }
    const f = s3.file(name);
    if (!(await f.exists())) return fallback;
    return JSON.parse(await f.text());
  } catch (e) {
    console.error("read failed", name, e);
    return fallback;
  }
}
async function writeJSON(name: string, data: unknown) {
  const text = JSON.stringify(data);
  if (DATA_DIR) {
    const tmp = DATA_DIR + "/" + name + ".tmp";
    await Bun.write(tmp, text);
    renameSync(tmp, DATA_DIR + "/" + name);
    return;
  }
  await s3.write(name, text, { type: "application/json" });
}
// One context per assessment table. 4.1.D keeps its original file names and /api paths.
type Table = {
  key: string; code: string; resultsFile: string; settingsFile: string;
  settingsCache: { autoApprove: boolean } | null;
  sessions: Map<string, any>; // live participants (in memory)
  submitted: Set<string>; // ignore late heartbeats after a result arrives
  admitted: Map<string, number>; // participant id -> time the trainer admitted them
};
const mkTable = (key: string, code: string, resultsFile: string, settingsFile: string): Table =>
  ({ key, code, resultsFile, settingsFile, settingsCache: null, sessions: new Map(), submitted: new Set(), admitted: new Map() });
const TABLES: Record<string, Table> = {
  d: mkTable("d", "4.1.D", "results.json", "settings.json"),
  e: mkTable("e", "4.1.E", "results-4e.json", "settings-4e.json"),
};
const readResults = (t: Table): Promise<Record<string, any>> => readJSON(t.resultsFile, {});
const writeResults = (t: Table, r: Record<string, any>) => writeJSON(t.resultsFile, r);
async function getSettings(t: Table) {
  if (!t.settingsCache) t.settingsCache = { autoApprove: false, ...(await readJSON(t.settingsFile, {})) };
  return t.settingsCache!;
}
const live = (t: Table, now = Date.now()) => {
  let waiting = 0, online = 0;
  for (const v of t.sessions.values()) if (now - v.lastSeen < 120_000) v.waiting ? waiting++ : online++;
  return { waiting, online };
};

const certKey = (id: string) => createHmac("sha256", PIN).update(id).digest("hex").slice(0, 24);
function certNo(r: any) {
  const d = new Date(r.submitted || r.received || Date.now());
  return "ATC-" + d.toISOString().slice(2, 10).replace(/-/g, "") + "-" + String(r.id).slice(-6).toUpperCase();
}
function approve(r: any, by = "trainer") {
  r.status = "approved";
  r.approvedAt = Date.now();
  r.approvedBy = by;
  if (r.competent && !r.certNo) r.certNo = certNo(r);
}

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cleanId = (s: unknown) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
const isTrainer = (req: Request) => req.headers.get("x-pin") === PIN;

Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  maxRequestBodySize: 2 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    // /api/4e/... = Table 4.1.E; /api/... = Table 4.1.D (unchanged)
    let T = TABLES.d;
    if (path.startsWith("/api/4e/")) { T = TABLES.e; path = "/api/" + path.slice("/api/4e/".length); }
    const sessions = T.sessions, submitted = T.submitted, admitted = T.admitted;

    // trainer: live counts for every table (for the 4.1.D / 4.1.E switch)
    if (path === "/api/summary" && req.method === "GET") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      const now = Date.now();
      return json({ d: live(TABLES.d, now), e: live(TABLES.e, now) });
    }

    // participant heartbeat while taking the assessment
    if (path === "/api/session" && req.method === "POST") {
      let b: any;
      try { b = JSON.parse(await req.text()); } catch { return json({ error: "bad json" }, 400); }
      const id = cleanId(b.id);
      if (!id) return json({ error: "missing id" }, 400);
      if (submitted.has(id)) return json({ ok: true });
      const s = (v: unknown, n = 120) => String(v ?? "").slice(0, n);
      sessions.set(id, {
        id, name: s(b.name), job: s(b.job), company: s(b.company), facil: s(b.facil),
        start: Number(b.start) || 0, stage: Number(b.stage) || 1, answered: Number(b.answered) || 0,
        waiting: b.phase === "wait" && !admitted.has(id),
        lastSeen: Date.now(),
      });
      return json({ ok: true, admitted: admitted.has(id), admittedAt: admitted.get(id) || null });
    }

    if (path === "/api/results" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 60_000) return json({ error: "too large" }, 413);
      let r: any;
      try { r = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
      if (typeof r !== "object" || !r || typeof r.pct !== "number" || !r.ksa) return json({ error: "bad result" }, 400);
      const id = cleanId(r.id);
      if (!id) return json({ error: "missing id" }, 400);
      r.id = id;
      r.received = Date.now();
      delete r.status; delete r.approvedAt; delete r.approvedBy; delete r.certNo;
      const settings = await getSettings(T);
      await serial(async () => {
        const all = await readResults(T);
        if (all[id]?.status === "approved") return; // never overwrite an approved record
        r.status = "pending";
        if (settings.autoApprove) approve(r, "auto");
        all[id] = r;
        await writeResults(T, all);
      });
      submitted.add(id);
      sessions.delete(id);
      return json({ ok: true, id });
    }

    if (path === "/api/results" && req.method === "GET") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      const all = await readResults(T);
      const now = Date.now();
      for (const [k, v] of sessions) if (now - v.lastSeen > 3 * 3600_000) sessions.delete(k);
      const results = Object.values(all).map((r: any) => ({
        ...r,
        status: r.status || "pending",
        certKey: r.status === "approved" && r.competent ? certKey(r.id) : undefined,
      }));
      return json({ results, sessions: [...sessions.values()], settings: await getSettings(T), now, table: T.code });
    }

    // trainer admits waiting participants: {ids:[...]} or {all:true}
    if (path === "/api/admit" && req.method === "POST") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      let b: any = {};
      try { b = JSON.parse(await req.text()); } catch {}
      const ids: string[] = b.all ? [...sessions.values()].filter((v) => v.waiting).map((v) => v.id) : (Array.isArray(b.ids) ? b.ids.map(cleanId) : []);
      const now = Date.now();
      for (const id of ids) if (id) { admitted.set(id, now); const v = sessions.get(id); if (v) v.waiting = false; }
      return json({ ok: true, admitted: ids.length });
    }

    const ap = path.match(/^\/api\/results\/([A-Za-z0-9_-]+)\/approve$/);
    if (ap && req.method === "POST") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      let b: any = {};
      try { b = JSON.parse(await req.text()); } catch {}
      const id = ap[1];
      const out = await serial(async () => {
        const all = await readResults(T);
        const r = all[id];
        if (!r) return null;
        if (b.approve === false) { r.status = "pending"; delete r.approvedAt; delete r.approvedBy; }
        else approve(r, "trainer");
        await writeResults(T, all);
        return r;
      });
      return out ? json({ ok: true, status: out.status }) : json({ error: "not found" }, 404);
    }

    if (path === "/api/settings" && req.method === "POST") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      let b: any = {};
      try { b = JSON.parse(await req.text()); } catch {}
      const s = await getSettings(T);
      s.autoApprove = !!b.autoApprove;
      await writeJSON(T.settingsFile, s);
      return json({ ok: true, settings: s });
    }

    if (path.startsWith("/api/results/") && req.method === "DELETE") {
      if (!isTrainer(req)) return json({ error: "wrong pin" }, 403);
      const id = decodeURIComponent(path.slice("/api/results/".length));
      await serial(async () => {
        const all = await readResults(T);
        delete all[id];
        await writeResults(T, all);
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

    // Certificate: trainer only (signed link), approved Competent / Distinction results only
    if (req.method === "GET" && path === "/certificate") {
      const id = cleanId(url.searchParams.get("id"));
      const k = String(url.searchParams.get("k") || "");
      const CT = url.searchParams.get("t") === "4e" ? TABLES.e : TABLES.d;
      const all = id && k === certKey(id) ? await readResults(CT) : {};
      const r = all[id];
      if (!r || !r.competent || r.status !== "approved") {
        return new Response(
          "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Certificate not available</title><body style='font:16px Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;color:#142b56'><h2>Certificate not available</h2><p>Certificates are issued by the trainer for approved Competent and Distinction results. Open it from the trainer dashboard.</p></body>",
          { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      const d = new Date(r.submitted || r.received || Date.now());
      const qs = new URLSearchParams({
        name: String(r.name || ""),
        date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
        result: String(r.grade || "") + " (" + r.pct + "%)",
        ref: String(r.certNo || certNo(r)),
        assessor: String(r.facil || ""),
      });
      if (url.searchParams.get("download") === "1") qs.set("download", "1");
      const html = CERT.replaceAll("FIT4.1.D", "FIT" + CT.code).replace("__CERTQS__", () => JSON.stringify(qs.toString()).replace(/</g, "\\u003c"));
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (req.method === "GET" && (path === "/4e" || path === "/4e/" || path === "/4.1e" || path === "/4.1E")) {
      return new Response(PAGE_4E, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (req.method === "GET") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log("DG simulation server running");
