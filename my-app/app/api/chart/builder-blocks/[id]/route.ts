import {
  proxyFastApiDelete,
  proxyFastApiGet,
  proxyFastApiPutJson,
} from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  return proxyFastApiGet(`/api/chart/builder-blocks/${encodeURIComponent(id)}`, 20_000);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const upstream = await proxyFastApiPutJson(
    `/api/chart/builder-blocks/${encodeURIComponent(id)}`,
    body,
    25_000,
  );
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(text, { status: upstream.status, headers });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  const upstream = await proxyFastApiDelete(
    `/api/chart/builder-blocks/${encodeURIComponent(id)}`,
    25_000,
  );
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(text, { status: upstream.status, headers });
}
