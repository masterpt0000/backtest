import {
  proxyFastApiDelete,
  proxyFastApiGet,
  proxyFastApiPatchJson,
} from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  return proxyFastApiGet(`/api/presets/${encodeURIComponent(id)}`, 15_000);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const upstream = await proxyFastApiPatchJson(
    `/api/presets/${encodeURIComponent(id)}`,
    body,
    15_000,
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
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: "id inválido" }, { status: 400 });
  }
  return proxyFastApiDelete(`/api/presets/${encodeURIComponent(id)}`, 15_000);
}
