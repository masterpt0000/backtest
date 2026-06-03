import type { NextRequest } from "next/server";

import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TALIB_CATALOG_TIMEOUT_MS = 20_000;

export async function GET(_request: NextRequest) {
  return proxyFastApiGet("/api/chart/talib-catalog", TALIB_CATALOG_TIMEOUT_MS);
}
