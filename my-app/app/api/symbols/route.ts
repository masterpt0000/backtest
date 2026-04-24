import { proxyFastApiGet } from "@/lib/server/proxyToFastApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return proxyFastApiGet("/api/symbols");
}
