import { proxyFastApiGet, proxyFastApiPostJson } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const u = new URL(request.url);
  const q = u.searchParams.toString();
  const path = q ? `/api/presets?${q}` : "/api/presets";
  return proxyFastApiGet(path, 15_000);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const upstream = await proxyFastApiPostJson("/api/presets", body, 15_000);
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(text, { status: upstream.status, headers });
}
