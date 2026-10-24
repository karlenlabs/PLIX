// OKLab matrices: https://bottosson.github.io/posts/oklab/ (public domain).
// Final RGB correction only; neither the artwork palette nor animation is mutated.
type Triple = [number, number, number];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function hexToOklab(hex: string): Triple {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .7936177850*m - .0040720468*s,
    1.9779984951*l - 2.4285922050*m + .4505937099*s,
    .0259040371*l + .7827717662*m - .8086757660*s];
}
function linearRgb(L: number, C: number, h: number): Triple {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + .3963377774*a + .2158037573*b) ** 3;
  const m = (L - .1055613458*a - .0638541728*b) ** 3;
  const s = (L - .0894841775*a - 1.2914855480*b) ** 3;
  return [4.0767416621*l - 3.3077115913*m + .2309699292*s,
    -1.2684380046*l + 2.6097574011*m - .3413193965*s,
    -.0041960863*l - .7034186147*m + 1.7076147010*s];
}
function gamutHex(L: number, C: number, h: number): string {
  const inside = (values: Triple) => values.every(v => v >= -1e-7 && v <= 1 + 1e-7);
  let values = linearRgb(L, C, h);
  if (!inside(values)) {
    // Reduce chroma along the same hue instead of clipping channels into a new hue.
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inside(linearRgb(L, mid, h))) lo = mid; else hi = mid;
    }
    values = linearRgb(L, lo, h);
  }
  return '#' + values.map(v => {
    const c = v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055;
    return Math.round(clamp(c, 0, 1)*255).toString(16).padStart(2, '0');
  }).join('');
}
export function contrastBlobColors(colors: [string, string, string], amount: number): [string, string, string] {
  if (amount === 0) return colors; // Exact legacy RGB, with no color-space roundtrip.
  const lab = colors.map(hexToOklab);
  const distance = (a: Triple, b: Triple) => Math.hypot(...a.map((n, i) => n-b[i]));
  const nearest = Math.min(distance(lab[0],lab[1]), distance(lab[0],lab[2]), distance(lab[1],lab[2]));
  const strength = clamp(amount, 0, 1) * clamp(1 - nearest/.15, 0, 1);
  if (strength === 0) return colors;
  const order = [0,1,2].sort((a,b) => lab[a][0]-lab[b][0] || a-b);
  const mean = lab.reduce((sum,c) => sum+c[0],0)/3;
  const center = clamp(mean,.30,.75);
  return lab.map(([L,a,b],i) => {
    const rank = order.indexOf(i)-1;
    const target = clamp(L + center-mean + rank*.16, .12, .92);
    const C = Math.hypot(a,b), h = Math.atan2(b,a);
    return gamutHex(L+(target-L)*strength, C*(1-.08*Math.abs(rank)*strength), h);
  }) as [string,string,string];
}
