export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isFinitePosition = (
  value: unknown,
): value is { x: number; y: number } => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybePosition = value as { x?: unknown; y?: unknown };
  return isFiniteNumber(maybePosition.x) && isFiniteNumber(maybePosition.y);
};

export const distanceBetween = (
  left: { x: number; y: number },
  right: { x: number; y: number },
) => Math.hypot(left.x - right.x, left.y - right.y);
