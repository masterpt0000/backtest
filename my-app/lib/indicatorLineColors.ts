/** Paleta para várias instâncias RSI sem cor guardada — deve coincidir com o gráfico. */
export const RSI_LINE_PALETTE = [
  "#a78bfa",
  "#22d3ee",
  "#fbbf24",
  "#fb7185",
  "#4ade80",
  "#f472b6",
] as const;

/** Cor por defeito no canvas quando o utilizador ainda não gravou override (mesma regra que OhlcvChart). */
export function defaultRsiLineColor(indicatorId: string): string {
  let h = 0;
  for (let i = 0; i < indicatorId.length; i++) h = (h * 31 + indicatorId.charCodeAt(i)) | 0;
  return RSI_LINE_PALETTE[Math.abs(h) % RSI_LINE_PALETTE.length];
}

export function effectiveRsiLineColor(indicatorId: string, explicit?: string): string {
  if (explicit) return explicit;
  return defaultRsiLineColor(indicatorId);
}
