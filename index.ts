// Audia → Tunearo bridge. Keeps the Tunearo key server-side.
// Auth: header `x-audia-key` must equal the AUDIA_APP_KEY secret.
// Body: { action: "health" | "sync" | "status" | "submit" | "register-webhook" | "proxy", ... }
import { createClient } from "npm:@supabase/supabase-js@2.58.0";

const BASE = "https://dashboard.tunearo.com/api/public/v1";
const EVENTS = [
  "release.submitted",
  "release.approved",
  "release.rejected",
  "release.live",
  "release.takedown_completed",
  "royalties.imported",
];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-audia-key, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function adminKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const k = JSON.parse(keys);
      if (k.default) return k.default;
      const first = Object.values(k)[0];
      if (first) return String(first);
    } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), { auth: { persistSession: false } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function tunearo(method: string, path: string, body?: unknown) {
  const key = Deno.env.get("TUNEARO_API_KEY");
  if (!key) throw new Error("TUNEARO_API_KEY secret is not set");
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

const fullRow = (r: any) => ({
  id: r.id,
  title: r.title ?? null,
  artist_name: r.artist_name ?? null,
  release_type: r.release_type ?? null,
  release_date: r.release_date ?? null,
  status: r.status ?? null,
  rejection_reason: r.rejection_reason ?? null,
  upc: r.upc ?? null,
  raw: r,
  updated_at: r.updated_at ?? null,
  synced_at: new Date().toISOString(),
});

async function listAll(status?: string) {
  const out: any[] = [];
  const limit = 50;
  for (let offset = 0; offset <= 5000; offset += limit) {
    const q = `/releases?limit=${limit}&offset=${offset}${status ? `&status=${status}` : ""}`;
    const r = await tunearo("GET", q);
    if (!r.ok) throw new Error(`Tunearo ${r.status}: ${JSON.stringify(r.data)}`);
    const page = r.data?.data ?? [];
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

async function sync() {
  const all = await listAll();
  if (all.length) {
    const { error } = await db.from("tunearo_releases").upsert(all.map(fullRow));
    if (error) throw new Error(`DB: ${error.message}`);
  }
  const by_status: Record<string, number> = {};
  for (const r of all) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
  return {
    total: all.length,
    by_status,
    releases: all.map((r) => ({
      id: r.id, title: r.title, artist: r.artist_name, status: r.status,
      release_date: r.release_date, rejection_reason: r.rejection_reason ?? null,
    })),
  };
}

async function status(id: string) {
  const r = await tunearo("GET", `/releases/${id}/status`);
  if (!r.ok) return { id, error: r.data, http: r.status };
  await db.from("tunearo_releases").upsert({
    id, status: r.data.status, rejection_reason: r.data.rejection_reason ?? null,
    upc: r.data.upc ?? null, updated_at: r.data.updated_at ?? null, synced_at: new Date().toISOString(),
  });
  return r.data;
}

// Checks Tunearo would otherwise reject on. Final approval is Tunearo's.
async function preflight(id: string) {
  const issues: string[] = [];
  const rel = await tunearo("GET", `/releases/${id}`);
  if (!rel.ok) return { ok: false, issues: [`Release lookup failed (${rel.status})`], release: null };
  const r = rel.data.release;
  if (!["draft", "rejected"].includes(r.status)) issues.push(`Status is '${r.status}'; only draft/rejected can be submitted`);
  if ("cover_artwork_url" in r && !r.cover_artwork_url) issues.push("Missing cover artwork");
  const tr = await tunearo("GET", `/releases/${id}/tracks`);
  const tracks = tr.data?.tracks ?? [];
  if (!tracks.length) issues.push("No tracks");
  return { ok: issues.length === 0, issues, release: r };
}

async function submit(ids: string[], force: boolean) {
  const results = [];
  for (const id of ids) {
    const pf = await preflight(id);
    if (!pf.ok && !force) {
      results.push({ id, title: pf.release?.title ?? null, submitted: false, issues: pf.issues });
      continue;
    }
    const s = await tunearo("POST", `/releases/${id}/submit`);
    if (s.ok && s.data?.release) {
      await db.from("tunearo_releases").upsert({
        id, status: s.data.release.status, updated_at: s.data.release.updated_at ?? null,
        synced_at: new Date().toISOString(),
      });
    }
    results.push({
      id, title: pf.release?.title ?? null, submitted: s.ok,
      status: s.data?.release?.status ?? null, error: s.ok ? undefined : s.data,
    });
  }
  return results;
}

async function registerWebhook() {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tunearo-webhook`;
  const existing = await tunearo("GET", "/webhooks");
  for (const w of existing.data?.webhooks ?? []) {
    if (w.url === url) await tunearo("DELETE", `/webhooks/${w.id}`);
  }
  const r = await tunearo("POST", "/webhooks", { url, events: EVENTS });
  if (!r.ok) throw new Error(`Tunearo ${r.status}: ${JSON.stringify(r.data)}`);
  const w = r.data.webhook;
  const { error } = await db.from("app_settings").upsert([
    { key: "tunearo_webhook_secret", value: w.secret, updated_at: new Date().toISOString() },
    { key: "tunearo_webhook_id", value: w.id, updated_at: new Date().toISOString() },
  ]);
  if (error) throw new Error(`DB: ${error.message}`);
  return { registered: true, id: w.id, url: w.url, events: w.events };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  if (body.action === "health") {
    return json({
      tunearo_key_set: Boolean(Deno.env.get("TUNEARO_API_KEY")),
      app_key_set: Boolean(Deno.env.get("AUDIA_APP_KEY")),
    });
  }

  const appKey = Deno.env.get("AUDIA_APP_KEY");
  if (!appKey) return json({ error: "AUDIA_APP_KEY secret is not set" }, 503);
  if (!safeEqual(req.headers.get("x-audia-key") ?? "", appKey)) return json({ error: "Unauthorized" }, 401);

  try {
    switch (body.action) {
      case "sync":
        return json(await sync());
      case "status":
        if (!body.release_id) return json({ error: "release_id required" }, 400);
        return json(await status(body.release_id));
      case "submit": {
        let ids: string[] = body.release_ids ?? (body.release_id ? [body.release_id] : []);
        if (body.all_drafts) ids = (await listAll("draft")).map((r) => r.id);
        if (!ids.length) return json({ error: "release_id, release_ids or all_drafts required" }, 400);
        return json({ results: await submit(ids, Boolean(body.force)) });
      }
      case "register-webhook":
        return json(await registerWebhook());
      case "proxy": {
        const method = String(body.method ?? "GET").toUpperCase();
        const path = String(body.path ?? "");
        if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) return json({ error: "Bad method" }, 400);
        if (!path.startsWith("/") || path.includes("..") || path.includes("://")) return json({ error: "Bad path" }, 400);
        const r = await tunearo(method, path, body.body);
        return json(r.data, r.status);
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
