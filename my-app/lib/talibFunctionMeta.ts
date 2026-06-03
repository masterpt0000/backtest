import { apiFetch } from "@/lib/apiFetch";

export type TalibParamMetaType = "integer" | "real" | "boolean";

export type TalibParamMeta = {
  name: string;
  default: number | boolean;
  type: TalibParamMetaType;
};

export type TalibFunctionMetaResponse = {
  available: boolean;
  function?: string;
  parameters?: TalibParamMeta[];
  error?: string;
};

function isParamMeta(x: unknown): x is TalibParamMeta {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const t = o.type;
  if (t !== "integer" && t !== "real" && t !== "boolean") return false;
  return typeof o.name === "string";
}

export async function fetchTalibFunctionMeta(functionName: string): Promise<TalibFunctionMetaResponse> {
  const u = new URL("/api/chart/talib-function-meta", window.location.origin);
  u.searchParams.set("function", functionName.trim());
  try {
    const r = await apiFetch(u.toString(), { cache: "no-store" }, 15_000);
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) {
      const detail =
        typeof j.detail === "string"
          ? j.detail
          : typeof j.error === "string"
            ? j.error
            : r.statusText;
      return { available: false, parameters: [], error: detail };
    }
    const available = Boolean(j.available);
    const parameters = Array.isArray(j.parameters)
      ? (j.parameters as unknown[]).filter(isParamMeta)
      : [];
    return {
      available,
      function: typeof j.function === "string" ? j.function : undefined,
      parameters,
      error: typeof j.error === "string" ? j.error : undefined,
    };
  } catch {
    return { available: false, parameters: [], error: "Pedido falhou" };
  }
}
