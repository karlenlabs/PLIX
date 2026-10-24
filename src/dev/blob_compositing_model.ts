// DEV-only CPU reference. RGB values are normalized encoded sRGB; light
// measurements and B's budget use linear-light relative luminance.
export type RGB = [number, number, number];
export const decode = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
export const encode = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - .055;
export const luminance = (rgb: RGB) => rgb.map(decode).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
export function oklab(rgb: RGB): RGB {
  const [r,g,b] = rgb.map(decode);
  const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b);
  const m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b);
  const s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];
}
function labLinear([L,a,b]: RGB): RGB {
  const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
  return [4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s];
}
export function brightnessCompensation(rgb: RGB, strength: number): RGB {
  if (strength === 0) return [...rgb];
  const [L,a,b]=oklab(rgb);
  if (L <= .35) return [...rgb];
  const capped=.35+.15*(1-Math.exp(-(L-.35)/.15)); // soft knee, asymptotic L ceiling .50
  const target=L+(capped-L)*strength;
  const inside=(values: RGB)=>values.every(v=>v>=0&&v<=1);
  let linear=labLinear([target,a,b]);
  if (!inside(linear)) {
    let lo=0,hi=1;
    for(let i=0;i<10;i++) { const mid=(lo+hi)/2; if(inside(labLinear([target,a*mid,b*mid])))lo=mid;else hi=mid; }
    linear=labLinear([target,a*lo,b*lo]); // preserve OKLab hue, keep maximum available input chroma
  }
  return linear.map(v=>Math.max(0,Math.min(1,encode(v)))) as RGB;
}
export function darkSurfaceComposite(rgb: RGB, surface: RGB, strength: number): RGB {
  if (strength === 0) return [...rgb];
  const linear=rgb.map(decode),ys=luminance(rgb),surfaceY=luminance(surface);
  if (ys <= surfaceY) return [...rgb];
  const target=surfaceY;
  const chroma=linear.map(v=>v-ys);
  let scale=1;
  for(const d of chroma) { if(d>0)scale=Math.min(scale,(1-target)/d);else if(d<0)scale=Math.min(scale,target/-d); }
  const tinted=chroma.map(d=>encode(Math.max(0,Math.min(1,target+d*scale))));
  return rgb.map((v,i)=>v+(tinted[i]-v)*strength) as RGB;
}
export function compositeOnSurface(rgb: RGB, alpha: number, surface: RGB): RGB {
  return rgb.map((v,i)=>v*alpha+surface[i]*(1-alpha)) as RGB;
}

export function shadeMergedPixel(pixel: [number,number,number,number], brightness: number, surfaceStrength: number, surface: RGB): [number,number,number,number] {
  if (pixel[3] === 0 || (brightness === 0 && surfaceStrength === 0)) return [...pixel];
  let rgb=pixel.slice(0,3).map(v=>Math.max(0,Math.min(1,v/pixel[3]))) as RGB;
  if(brightness>0)rgb=brightnessCompensation(rgb,brightness);
  if(surfaceStrength>0)rgb=darkSurfaceComposite(rgb,surface,surfaceStrength);
  return [...rgb.map(v=>v*pixel[3]),pixel[3]] as [number,number,number,number];
}
