export type ChartJobStart<T> = {
  job_id: string;
  status: string;
  cached?: boolean;
  result?: T;
  error?: string;
};

export type ChartJobStatus<T> = {
  job_id: string;
  status: string;
  progress?: number;
  cached?: boolean;
  result?: T;
  error?: string;
};

export function parseChartJobStart<T>(
  raw: unknown,
  parseResult: (x: unknown) => T | null,
): ChartJobStart<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.job_id !== "string" || typeof o.status !== "string") return null;
  const result = o.result === undefined ? undefined : parseResult(o.result);
  return {
    job_id: o.job_id,
    status: o.status,
    ...(typeof o.cached === "boolean" ? { cached: o.cached } : {}),
    ...(result ? { result } : {}),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
  };
}

export function parseChartJobStatus<T>(
  raw: unknown,
  parseResult: (x: unknown) => T | null,
): ChartJobStatus<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.job_id !== "string" || typeof o.status !== "string") return null;
  const result = o.result === undefined ? undefined : parseResult(o.result);
  return {
    job_id: o.job_id,
    status: o.status,
    ...(typeof o.progress === "number" ? { progress: o.progress } : {}),
    ...(typeof o.cached === "boolean" ? { cached: o.cached } : {}),
    ...(result ? { result } : {}),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
  };
}
