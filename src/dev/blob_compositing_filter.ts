import { Filter, GlProgram, UniformGroup } from "pixi.js";
import type { RGB } from "./blob_compositing_model";

export const compositingVertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main() {
  vec2 p=aPosition*uOutputFrame.zw+uOutputFrame.xy;
  p.x=p.x*(2.0/uOutputTexture.x)-1.0;
  p.y=p.y*(2.0*uOutputTexture.z/uOutputTexture.y)-uOutputTexture.z;
  gl_Position=vec4(p,0.0,1.0);
  vTextureCoord=aPosition*(uOutputFrame.zw*uInputSize.zw);
}`;
export const compositingFragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uBrightnessStrength;
uniform float uSurfaceStrength;
uniform vec3 uDarkSurface;
vec3 decodeSRGB(vec3 v) {
  return mix(pow((v+0.055)/1.055,vec3(2.4)),v/12.92,lessThanEqual(v,vec3(0.04045)));
}
vec3 encodeSRGB(vec3 v) {
  v=max(v,vec3(0.0));
  return mix(1.055*pow(v,vec3(1.0/2.4))-0.055,12.92*v,lessThanEqual(v,vec3(0.0031308)));
}
vec3 labFromRGB(vec3 rgb) {
  vec3 c=decodeSRGB(rgb);
  vec3 root=pow(max(vec3(dot(c,vec3(0.4122214708,0.5363325363,0.0514459929)),
    dot(c,vec3(0.2119034982,0.6806995451,0.1073969566)),dot(c,vec3(0.0883024619,0.2817188376,0.6299787005))),vec3(0.0)),vec3(1.0/3.0));
  return vec3(dot(root,vec3(0.2104542553,0.7936177850,-0.0040720468)),
    dot(root,vec3(1.9779984951,-2.4285922050,0.4505937099)),dot(root,vec3(0.0259040371,0.7827717662,-0.8086757660)));
}
vec3 linearFromLab(vec3 lab) {
  vec3 lms=vec3(lab.x+0.3963377774*lab.y+0.2158037573*lab.z,
    lab.x-0.1055613458*lab.y-0.0638541728*lab.z,lab.x-0.0894841775*lab.y-1.2914855480*lab.z);
  lms=lms*lms*lms;
  return vec3(dot(lms,vec3(4.0767416621,-3.3077115913,0.2309699292)),
    dot(lms,vec3(-1.2684380046,2.6097574011,-0.3413193965)),dot(lms,vec3(-0.0041960863,-0.7034186147,1.7076147010)));
}
bool inGamut(vec3 c) { return all(greaterThanEqual(c,vec3(0.0)))&&all(lessThanEqual(c,vec3(1.0))); }
vec3 compensateBrightness(vec3 rgb) {
  vec3 lab=labFromRGB(rgb);
  if(lab.x<=0.35)return rgb;
  float capped=0.35+0.15*(1.0-exp(-(lab.x-0.35)/0.15));
  lab.x=mix(lab.x,capped,uBrightnessStrength);
  vec3 linear=linearFromLab(lab);
  if(!inGamut(linear)) {
    float lo=0.0,hi=1.0;
    for(int i=0;i<10;i++) {
      float mid=(lo+hi)*0.5;
      if(inGamut(linearFromLab(vec3(lab.x,lab.yz*mid))))lo=mid;else hi=mid;
    }
    linear=linearFromLab(vec3(lab.x,lab.yz*lo));
  }
  return clamp(encodeSRGB(linear),0.0,1.0);
}
vec3 compositeWithDarkSurface(vec3 rgb) {
  const vec3 weights=vec3(0.2126,0.7152,0.0722);
  vec3 linear=decodeSRGB(rgb);
  float sourceY=dot(linear,weights);
  float targetY=dot(decodeSRGB(uDarkSurface),weights);
  if(sourceY<=targetY)return rgb;
  vec3 chroma=linear-vec3(sourceY);
  float scale=1.0;
  for(int i=0;i<3;i++) {
    if(chroma[i]>0.0)scale=min(scale,(1.0-targetY)/chroma[i]);
    else if(chroma[i]<0.0)scale=min(scale,targetY/-chroma[i]);
  }
  vec3 tinted=encodeSRGB(clamp(vec3(targetY)+chroma*scale,0.0,1.0));
  return mix(rgb,tinted,uSurfaceStrength);
}
void main() {
  vec4 source=texture(uTexture,vTextureCoord);
  if(source.a<=0.0) { finalColor=source;return; }
  vec3 rgb=clamp(source.rgb/source.a,0.0,1.0);
  if(uBrightnessStrength>0.0)rgb=compensateBrightness(rgb);
  if(uSurfaceStrength>0.0)rgb=compositeWithDarkSurface(rgb);
  // Only the merged blobs are processed; never fill the transparent canvas or
  // touch DOM controls. Preserve alpha and restore Pixi premultiplied RGB.
  finalColor=vec4(rgb*source.a,source.a);
}`;

export class BlobCompositingFilter extends Filter {
  constructor() {
    super({ glProgram:GlProgram.from({name:"dev-blob-compositing",vertex:compositingVertex,fragment:compositingFragment}),
      resolution:"inherit",padding:0,resources:{compositingUniforms:new UniformGroup({
        uBrightnessStrength:{value:0,type:"f32"},uSurfaceStrength:{value:0,type:"f32"},
        uDarkSurface:{value:new Float32Array([0,0,0]),type:"vec3<f32>"},
      })} });
  }
  update(brightness: number, surfaceStrength: number, surface: RGB) {
    const u=this.resources.compositingUniforms.uniforms;
    u.uBrightnessStrength=brightness;u.uSurfaceStrength=surfaceStrength;u.uDarkSurface.set(surface);
  }
}
