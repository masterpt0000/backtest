export function fmtCur(n: number, currency = "USD"): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)} ${currency}`;
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
