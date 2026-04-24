import type { NextRequest } from "next/server";

import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest) {
  return proxyFastApiGet("/api/live/store/status", 10_000);
}
