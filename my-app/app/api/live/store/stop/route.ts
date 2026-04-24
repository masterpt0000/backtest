import { proxyFastApiPostJson } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return proxyFastApiPostJson("/api/live/store/stop", {}, 15_000);
}
