/** Evita que pedidos ao FastAPI (via rewrites do Next) fiquem pendentes indefinidamente quando o backend/DB estão parados. */
export const DEFAULT_API_TIMEOUT_MS = 10_000;

function mergedAbortForFetch(
  timeoutMs: number,
  userSignal: AbortSignal | undefined,
): { signal: AbortSignal; clearTimer: () => void } {
  const timeoutCtrl = new AbortController();
  const id = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const clearTimer = () => clearTimeout(id);

  if (!userSignal) {
    return { signal: timeoutCtrl.signal, clearTimer };
  }

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return {
      signal: AbortSignal.any([timeoutCtrl.signal, userSignal]),
      clearTimer,
    };
  }

  const merged = new AbortController();
  const forward = () => merged.abort();
  timeoutCtrl.signal.addEventListener("abort", forward);
  userSignal.addEventListener("abort", forward);
  if (timeoutCtrl.signal.aborted || userSignal.aborted) merged.abort();
  return { signal: merged.signal, clearTimer };
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  const userSignal = init?.signal ?? undefined;
  const { signal: mergedSignal, clearTimer } = mergedAbortForFetch(timeoutMs, userSignal);
  try {
    return await fetch(input, { ...init, signal: mergedSignal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (userSignal?.aborted) {
        throw e;
      }
      throw new Error(
        "Timeout ao contactar o servidor (confirma que o FastAPI e a base de dados estão a correr).",
      );
    }
    throw e;
  } finally {
    clearTimer();
  }
}
