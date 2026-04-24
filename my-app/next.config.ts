import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  /** Proxy FastAPI: rotas em app/api e lib/server/proxyToFastApi.ts (timeout; sem rewrites). */
};

export default nextConfig;
