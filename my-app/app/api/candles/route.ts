import type { NextRequest } from "next/server";

import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.search;
  return proxyFastApiGet(`/api/candles${q}`);
}
