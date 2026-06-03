import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/** Alinhado com `DEFAULT_API_TIMEOUT_MS` em `lib/apiFetch.ts` (browser). */
export const BACKEND_PROXY_TIMEOUT_MS = 10_000;

/**
 * URL do FastAPI para pedidos **no servidor Node** (Route Handlers).
 * Força IPv4: com `--host 127.0.0.1`, `localhost` pode ir para `::1` e falhar no Windows.
 */
export function fastApiBaseUrl(): string {
  let u = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  u = u.replace(/:\/\/localhost\b/i, "://127.0.0.1");
  return u;
}

function buildTargetUrl(pathWithLeadingSlash: string): string {
  const base = fastApiBaseUrl();
  const path = pathWithLeadingSlash.startsWith("/") ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`;
  return `${base}${path}`;
}

/**
 * Pedido ao FastAPI com `http`/`https` nativos (não usa `fetch`/undici).
 * Evita falhas quando há HTTP(S)_PROXY e evita IPv6 em `localhost` vs uvicorn só em 127.0.0.1.
 */
function proxyNodeHttp(
  fullUrl: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string | undefined;
    timeoutMs: number;
  },
): Promise<Response> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Response) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let u: URL;
    try {
      u = new URL(fullUrl);
    } catch {
      finish(
        Response.json({ error: "BACKEND_URL inválido para o proxy do Next.js." }, { status: 500 }),
      );
      return;
    }

    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;

    const reqHeaders: Record<string, string> = {
      Connection: "close",
      ...options.headers,
    };

    const req = mod.request(
      {
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method: options.method,
        timeout: options.timeoutMs,
        headers: reqHeaders,
      },
      (inMsg) => {
        const headers = new Headers();
        const ct = inMsg.headers["content-type"];
        if (ct) {
          headers.set("content-type", Array.isArray(ct) ? ct[0] : ct);
        }
        headers.set("cache-control", "no-store");
        const webStream = Readable.toWeb(inMsg) as ReadableStream<Uint8Array>;
        finish(
          new Response(webStream, {
            status: inMsg.statusCode ?? 502,
            statusText: inMsg.statusMessage,
            headers,
          }),
        );
      },
    );

    req.on("error", (err: Error) => {
      finish(
        Response.json(
          {
            error: `FastAPI indisponível (${err.message}). Confirma BACKEND_URL; uvicorn deve escutar em 127.0.0.1:8000.`,
          },
          { status: 503 },
        ),
      );
    });

    req.on("timeout", () => {
      req.destroy();
      finish(
        Response.json(
          { error: "Timeout ao contactar o FastAPI (porta 8000 / BACKEND_URL)." },
          { status: 504 },
        ),
      );
    });

    if (options.body != null && options.body !== "") {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * GET para o FastAPI com limite de tempo.
 * O corpo é reencaminhado em stream (ex.: velas grandes).
 */
export async function proxyFastApiGet(
  pathWithLeadingSlash: string,
  timeoutMs: number = BACKEND_PROXY_TIMEOUT_MS,
): Promise<Response> {
  return proxyNodeHttp(buildTargetUrl(pathWithLeadingSlash), {
    method: "GET",
    timeoutMs,
  });
}

/** POST JSON — resposta típica pequena (ex. ``{ job_id }``). */
export async function proxyFastApiPostJson(
  pathWithLeadingSlash: string,
  body: unknown,
  timeoutMs: number = 30_000,
): Promise<Response> {
  return proxyNodeHttp(buildTargetUrl(pathWithLeadingSlash), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

export async function proxyFastApiPatchJson(
  pathWithLeadingSlash: string,
  body: unknown,
  timeoutMs: number = 30_000,
): Promise<Response> {
  return proxyNodeHttp(buildTargetUrl(pathWithLeadingSlash), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

export async function proxyFastApiPutJson(
  pathWithLeadingSlash: string,
  body: unknown,
  timeoutMs: number = 30_000,
): Promise<Response> {
  return proxyNodeHttp(buildTargetUrl(pathWithLeadingSlash), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

export async function proxyFastApiDelete(
  pathWithLeadingSlash: string,
  timeoutMs: number = 10_000,
): Promise<Response> {
  return proxyNodeHttp(buildTargetUrl(pathWithLeadingSlash), {
    method: "DELETE",
    timeoutMs,
  });
}
