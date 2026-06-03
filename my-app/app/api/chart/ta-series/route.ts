import type { NextRequest } from "next/server";

import { proxyFastApiPostJson } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TA_TIMEOUT_MS = 120_000;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  return proxyFastApiPostJson("/api/chart/ta-series", body, TA_TIMEOUT_MS);
}
