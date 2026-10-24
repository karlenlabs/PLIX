import { hexToOklab } from './color_contrast.ts';

type Colors = [string, string, string];
type Lch = { L: number; C: number; h: number };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const smooth = (n: number) => n*n*(3-2*n);
const distance = (a: Lch, b: Lch) => Math.hypot(a.L-b.L, a.C*Math.cos(a.h)-b.C*Math.cos(b.h), a.C*Math.sin(a.h)-b.C*Math.sin(b.h));

// Separate implementation intentionally keeps the current algorithm byte-for-byte frozen.
// Same public-domain OKLab inverse matrices as color_contrast.ts; reduce chroma
// along a fixed hue to fit sRGB, rather than clipping individual RGB channels.
function toHex({ L, C, h }: Lch): string {
  const linear = (chroma: number) => {
    const a = chroma*Math.cos(h), b = chroma*Math.sin(h);
    const l = (L+.3963377774*a+.2158037573*b)**3;
    const m = (L-.1055613458*a-.0638541728*b)**3;
    const s = (L-.0894841775*a-1.2914855480*b)**3;
    return [4.0767416621*l-3.3077115913*m+.2309699292*s,
      -1.2684380046*l+2.6097574011*m-.3413193965*s,
      -.0041960863*l-.7034186147*m+1.7076147010*s];
  };
  const inside = (values: number[]) => values.every(v => v >= -1e-7 && v <= 1+1e-7);
  if (!inside(linear(C))) {
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) { const mid = (lo+hi)/2; if (inside(linear(mid))) lo = mid; else hi = mid; }
    C = lo;
  }
  return '#' + linear(C).map(v => {
    const c = v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055;
    return Math.round(clamp(c,0,1)*255).toString(16).padStart(2,'0');
  }).join('');
}

export function adaptiveBlobColors(colors: Colors, amount: number): Colors {
  if (amount === 0) return colors;
  const original = colors.map(color => {
    const [L,a,b] = hexToOklab(color); return { L, C: Math.hypot(a,b), h: Math.atan2(b,a) };
  });
  const order = [0,1,2].sort((a,b)=>original[a].L-original[b].L || a-b);
  const pairs = [[0,1],[0,2],[1,2]].map(([i,j]) => {
    const d = distance(original[i], original[j]);
    const need = smooth(clamp((.14-d)/.14,0,1));
    // Stable direction also works for identical colors; no random hue generation.
    const direction = Math.sign(order.indexOf(i)-order.indexOf(j));
    return { i, j, need, direction, goal: d+(.16-d)*need };
  }).filter(pair => pair.need > 0);
  if (!pairs.length) return colors; // Already distinct: exact original HEX.
  const need = original.map((_,i) => Math.max(0,...pairs.filter(p=>p.i===i||p.j===i).map(p=>p.need)));
  const active = original.filter((_,i)=>need[i]>0);
  const mean = active.reduce((sum,c)=>sum+c.L,0)/active.length;
  const shift = clamp(mean,.30,.75)-mean;
  // Keep each source endpoint admissible: near-threshold pairs must not jump
  // merely because their original lightness is outside the working interior.
  const lower = original.map(c=>Math.min(c.L,.12)), upper = original.map(c=>Math.max(c.L,.92));
  const target = original.map((c,i) => ({ ...c, L: c.L+shift*need[i] }));
  for (const {i,j,need:weight,direction} of pairs) {
    target[i].L += direction*.11*weight; target[j].L -= direction*.11*weight;
    // No synthetic chroma for neutral artwork. Limit amplification to existing tones.
    const chroma = Math.min(original[i].C,original[j].C)*.12*weight*direction;
    target[i].C += chroma; target[j].C -= chroma;
  }
  for (let i=0;i<3;i++) if (need[i]>0) {
    target[i].L = clamp(target[i].L,lower[i],upper[i]);
    target[i].C = clamp(target[i].C,original[i].C*.70,Math.min(original[i].C*1.25,Math.max(original[i].C,.18)));
  }
  // Repair residual close pairs locally; an already-separated third color is untouched.
  for (let iteration=0;iteration<10;iteration++) for (const {i,j,goal,direction} of pairs) {
    const deficit = goal-distance(target[i],target[j]);
    if (deficit <= .001) continue;
    target[i].L = clamp(target[i].L+direction*deficit*.5,lower[i],upper[i]);
    target[j].L = clamp(target[j].L-direction*deficit*.5,lower[j],upper[j]);
  }
  // A tiny hue adjustment is a last resort for chromatic colors only, within ±3°
  // of each source tone and only when both source hues belong to the same family.
  for (const {i,j,goal,need:weight,direction} of pairs) {
    const hueGap = Math.atan2(Math.sin(original[i].h-original[j].h),Math.cos(original[i].h-original[j].h));
    if (distance(target[i],target[j]) < goal*.9 && Math.min(original[i].C,original[j].C) > .02 && Math.abs(hueGap)<.25) {
      target[i].h = original[i].h+direction*Math.PI/60*weight;
      target[j].h = original[j].h-direction*Math.PI/60*weight;
    }
  }
  const intensity = clamp(amount,0,1);
  return target.map((c,i) => need[i] === 0 ? colors[i] : toHex({
    L: original[i].L+(c.L-original[i].L)*intensity,
    C: original[i].C+(c.C-original[i].C)*intensity,
    h: original[i].h+(c.h-original[i].h)*intensity,
  })) as Colors;
}
