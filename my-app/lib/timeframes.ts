/** Timeframes: 1m = velas cruas em candles_1m; resto = SAMPLE BY na QuestDB. */

export const TIMEFRAME_TO_SAMPLE: Record<string, string | null> = {
  "1m": null,
  "2m": "2m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "45m": "45m",
  "1h": "1h",
  "2h": "2h",
  "3h": "3h",
  "4h": "4h",
  "6h": "6h",
  "12h": "12h",
  "1d": "1d",
  "7d": "7d",
  "1w": "1w",
};

export const TIMEFRAME_OPTIONS = Object.keys(TIMEFRAME_TO_SAMPLE);

export function isValidTimeframe(tf: string): boolean {
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_TO_SAMPLE, tf);
}
