import { proxyFastApiGet, proxyFastApiPostJson } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 20_000;

export async function GET() {
  return proxyFastApiGet("/api/chart/builder-blocks", TIMEOUT_MS);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const upstream = await proxyFastApiPostJson("/api/chart/builder-blocks", body, 25_000);
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(text, { status: upstream.status, headers });
}
