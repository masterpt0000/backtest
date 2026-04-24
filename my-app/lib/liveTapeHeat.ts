/** Buckets temporais para heatmap do tape (agressão buy vs sell por volume). */

export function tapeBuyRatioBuckets(
  ticks: { t: number; side?: string; amount: number }[],
  bucketCount: number,
  spanSec: number,
): number[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - spanSec;
  const w = spanSec / bucketCount;
  const buyVol = new Array(bucketCount).fill(0);
  const sellVol = new Array(bucketCount).fill(0);
  for (const tk of ticks) {
    if (tk.t < start) continue;
    const i = Math.min(bucketCount - 1, Math.max(0, Math.floor((tk.t - start) / w)));
    const a = Number(tk.amount) || 0;
    const s = String(tk.side || "").toLowerCase();
    const isBuy = s.includes("buy");
    if (isBuy) buyVol[i] += a;
    else sellVol[i] += a;
  }
  return buyVol.map((b, i) => {
    const sv = sellVol[i];
    const t = b + sv;
    return t > 0 ? b / t : 0.5;
  });
}

export function bucketHeatColor(buyRatio: number): string {
  const r = Math.max(0, Math.min(1, buyRatio));
  const h = r * 120;
  return `hsl(${h} 62% 38%)`;
}
