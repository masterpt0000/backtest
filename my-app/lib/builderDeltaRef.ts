export const BUILDER_DELTA_SUFFIX = "_delta" as const;

export function builderDeltaRef(baseRef: string): string {
  return `${baseRef}${BUILDER_DELTA_SUFFIX}`;
}

export function splitBuilderDeltaRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed.endsWith(BUILDER_DELTA_SUFFIX)) return null;
  const base = trimmed.slice(0, -BUILDER_DELTA_SUFFIX.length);
  return base ? base : null;
}
