import type { NextRequest } from "next/server";

import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 10_000;

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyFastApiGet(`/api/chart/footprint/jobs/${encodeURIComponent(id)}`, TIMEOUT_MS);
}
