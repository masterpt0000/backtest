import { proxyFastApiPostJson } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upstream = await proxyFastApiPostJson(
    `/api/backtest/jobs/${encodeURIComponent(id)}/cancel`,
    {},
    15_000,
  );
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(text, { status: upstream.status, headers });
}
