import type { NextRequest } from "next/server";

import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const META_TIMEOUT_MS = 15_000;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.search;
  return proxyFastApiGet(`/api/chart/talib-function-meta${q}`, META_TIMEOUT_MS);
}
