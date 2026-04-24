/** Evita que pedidos ao FastAPI (via rewrites do Next) fiquem pendentes indefinidamente quando o backend/DB estão parados. */
export const DEFAULT_API_TIMEOUT_MS = 10_000;

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        "Timeout ao contactar o servidor (confirma que o FastAPI e a base de dados estão a correr).",
      );
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}
