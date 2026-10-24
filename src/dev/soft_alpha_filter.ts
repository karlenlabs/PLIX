import { Filter, GlProgram, Matrix, Sprite, Texture, UniformGroup, type FilterSystem, type Graphics, type RenderSurface } from "pixi.js";
import { softAlphaFrame } from "./soft_alpha_model";

// Same filter projection/UV convention as Pixi 8's MaskFilter. The extra matrix
// maps pooled input texture UVs back to blob-local pixels (including clipping,
// filter padding, resolution, and the translated parent container).
export const softAlphaVertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vLocalPosition;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform mat3 uLocalMatrix;
void main() {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  vLocalPosition = (uLocalMatrix * vec3(vTextureCoord, 1.0)).xy;
}`;
export const softAlphaFragment = `
in vec2 vTextureCoord;
in vec2 vLocalPosition;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uEllipse;
uniform float uSoftness;
void main() {
  float radius = length((vLocalPosition - uEllipse.xy) / uEllipse.zw);
  float t = clamp((radius - (1.0 - uSoftness)) / uSoftness, 0.0, 1.0);
  float alpha = clamp(1.0 - t * t * t * (t * (t * 6.0 - 15.0) + 10.0), 0.0, 1.0);
  // Pixi uses premultiplied RGBA: scale RGB together with alpha, retaining hue
  // and avoiding bright fringes when the existing BlurFilter samples the edge.
  finalColor = texture(uTexture, vTextureCoord) * alpha;
}`;

export class SoftAlphaFilter extends Filter {
  private readonly coordinates = new Sprite(Texture.WHITE);
  constructor(private readonly shape: Graphics, softness: number) {
    super({ glProgram: GlProgram.from({ name: "dev-soft-alpha", vertex: softAlphaVertex, fragment: softAlphaFragment }),
      resolution: 1, padding: 0,
      resources: { softAlphaUniforms: new UniformGroup({
        uLocalMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
        uEllipse: { value: new Float32Array([0, 0, 1, 1]), type: "vec4<f32>" },
        uSoftness: { value: softness, type: "f32" },
      }) } });
  }
  set softness(value: number) { this.resources.softAlphaUniforms.uniforms.uSoftness = value; }
  override apply(manager: FilterSystem, input: Texture, output: RenderSurface, clear: boolean) {
    // A detached, never rendered coordinate sprite lets Pixi's public mapping
    // API account for input cropping. It owns no new texture or scene layers.
    const transform = this.coordinates.worldTransform.copyFrom(this.shape.worldTransform);
    const group = this.shape.renderGroup || this.shape.parentRenderGroup;
    if (group?.cacheToLocalTransform) transform.prepend(group.cacheToLocalTransform);
    const uniforms = this.resources.softAlphaUniforms.uniforms;
    manager.calculateSpriteMatrix(uniforms.uLocalMatrix, this.coordinates)
      .scale(this.coordinates.texture.orig.width, this.coordinates.texture.orig.height);
    uniforms.uEllipse.set(softAlphaFrame(this.shape.getLocalBounds()));
    manager.applyFilter(this, input, output, clear);
  }
  override destroy() {
    this.coordinates.destroy(); // Texture.WHITE is shared and is not destroyed.
    super.destroy();
  }
}
