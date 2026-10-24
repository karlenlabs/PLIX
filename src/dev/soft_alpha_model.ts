// DEV-only reference for the shader: plateau at full density, C2-continuous fade.
// Radius is elliptical distance from the current (unfiltered) geometry bounds.
export function softAlphaAt(radius: number, softness: number): number {
  const t = Math.max(0, Math.min(1, (radius - (1 - softness)) / softness));
  return Math.max(0, Math.min(1, 1 - t * t * t * (t * (t * 6 - 15) + 10)));
}
export function softAlphaFrame(bounds: { x: number; y: number; width: number; height: number }) {
  return new Float32Array([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2,
    Math.max(.001, bounds.width / 2), Math.max(.001, bounds.height / 2)]);
}
