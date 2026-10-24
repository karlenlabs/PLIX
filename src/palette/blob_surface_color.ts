type RGB = [number, number, number];

// Resolve the flat base painted by design/surface.css, including the same
// relative-HSL saturation/lightness controls and alpha over rgb(--surface).
// No DOM insertion, screenshot, CSS mutation, or readback on the frame path.
export function flatSurfaceFromCSS(read: (name: string) => string): RGB {
  const base=read("--design-base-color").trim();
  if(!/^#[\da-f]{6}$/i.test(base)) throw new Error("B: unsupported base color; expected the existing #RRGGBB surface setting");
  const values=[1,3,5].map(i=>parseInt(base.slice(i,i+2),16)/255);
  const number=(key:string,fallback:number)=>{const raw=read(key).trim();const v=raw===""?fallback:Number(raw);if(!Number.isFinite(v))throw new Error("B: invalid surface variable "+key);return v;};
  const hi=Math.max(...values),lo=Math.min(...values),oldL=(hi+lo)/2,chroma=hi-lo;
  const L=Math.max(0,Math.min(1,oldL*number("--surface-brightness",1)));
  const S=Math.max(0,Math.min(1,(chroma?chroma/(1-Math.abs(2*oldL-1)):0)*number("--surface-saturation",1)));
  const newChroma=(1-Math.abs(2*L-1))*S;
  const adjusted=values.map(v=>L+(chroma?(v-oldL)/chroma*newChroma:0));
  const opacity=Math.max(0,Math.min(1,number("--design-base-opacity",1)));
  if(opacity===1)return adjusted as RGB;
  const under=read("--surface").trim().split(",").map(Number);
  if(under.length!==3||!under.every(v=>Number.isFinite(v)&&v>=0&&v<=255))throw new Error("B: invalid underlying CSS surface");
  return adjusted.map((v,i)=>v*opacity+under[i]/255*(1-opacity)) as RGB;
}
export function readFlatPlayerSurface(player: HTMLElement): RGB {
  const css=getComputedStyle(player);
  return flatSurfaceFromCSS(name=>css.getPropertyValue(name));
}
export function watchFlatPlayerSurface(player: HTMLElement, changed: () => void): () => void {
  const observer=new MutationObserver(changed);
  observer.observe(player,{attributes:true,attributeFilter:["style","class"]});
  observer.observe(document.documentElement,{attributes:true,attributeFilter:["style","class","data-theme"]});
  return ()=>observer.disconnect();
}
