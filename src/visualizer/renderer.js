import { createHybridAudioColors } from "../palette/hybrid_palette.ts";
import { createColorTransition } from "./colors.ts";
import { Application, Container, Graphics, BlurFilter, Rectangle } from 'pixi.js';
import * as VisualModel from './geometry.js';
import * as SpectrumMapping from './spectrum-mapping.js';
const PIXI = { Application, Container, Graphics, BlurFilter, Rectangle };
// Port of the spike's canonical 16-band geometry. Canvas is transparent over
// the existing opaque player background; blur always comes from the preset.
export async function createBlobRenderer(host, initialOptions, failed) {
    let options = initialOptions;
    let input = { low: 0, mid: 0, high: 0, status: 'WAITING', received: 0 };
    const app = new PIXI.Application();
    try {
        await app.init({ width: 440, height: 164, backgroundColor: 0x000000, backgroundAlpha: 0,
            antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true,
            preference: 'webgl', powerPreference: 'low-power' });
        app.canvas.style.width = "100%";
        app.canvas.style.height = "100%";
        host.append(app.canvas);
        app.ticker.maxFPS = 60;
        const liquid = new PIXI.Container();
        const clip = new PIXI.Graphics().rect(0, 0, 440, 164).fill(0xffffff);
        app.stage.addChild(liquid, clip);
        liquid.mask = clip;
        const specs = [
            { x: 129, y: 86, rx: 110, ry: 54, color: 0x36a8b4, seed: 0.4, weights: [1.1, 0.85, 0.8] },
            { x: 302, y: 82, rx: 111, ry: 57, color: 0x6977d8, seed: 2.7, weights: [0.85, 1.1, 1.0] },
            { x: 216, y: 97, rx: 122, ry: 46, color: 0x377fbe, seed: 4.5, weights: [0.95, 1.0, 1.15] }
        ];
        const colors = createColorTransition(specs.map(s => s.color));
        const blobs = [];
        let positions = [];
        function createBlob(index) {
            const shape = new PIXI.Graphics();
            // Source-over preserves color without cumulative screen brightening.
            shape.blendMode = 'normal';
            const blur = new PIXI.BlurFilter({ strength: options.blur, quality: 4, resolution: 1 });
            shape.filters = [blur];
            shape.filterArea = new PIXI.Rectangle(0, 0, 440, 164);
            liquid.addChild(shape);
            return { spec: specs[index], shape, blur, drift: 0 };
        }
        for (let index = 0; index < options.blobCount; index++)
            blobs.push(createBlob(index));
        function apply(next) {
            options = next;
            positions = VisualModel.positions(options.layout, options.blobCount, options.layoutSeed);
            for (const blob of blobs)
                blob.blur.strength = options.blur;
        }
        apply(options);
        const smooth = [0, 0, 0];
        const spectrum16 = Array(16).fill(0);
        const variations = [-0.42, 0.38, -0.13, 0.63, -0.63, 0.17];
        const bounds = (value, max) => Math.min(max - 10, Math.max(10, value));
        function curve(shape, points, color) {
            shape.clear().moveTo(points[0].x, points[0].y);
            for (let i = 0; i < points.length; i++) {
                const p0 = points[(i - 1 + points.length) % points.length];
                const p1 = points[i], p2 = points[(i + 1) % points.length], p3 = points[(i + 2) % points.length];
                const t1 = p1.tension ?? 1, t2 = p2.tension ?? 1;
                shape.bezierCurveTo(bounds(p1.x + (p2.x - p0.x) / 6 * t1, 440), bounds(p1.y + (p2.y - p0.y) / 6 * t1, 164), bounds(p2.x - (p3.x - p1.x) / 6 * t2, 440), bounds(p2.y - (p3.y - p1.y) / 6 * t2, 164), p2.x, p2.y);
            }
            shape.closePath().fill(color);
        }
        let audioColors; // Independent DEV diagnostics.
        const hybridColors = createHybridAudioColors();
        let hybridEnabled = false, productionManaged = false;
        const render = ticker => {
            try {
                const dt = Math.min(0.05, ticker.deltaMS / 1000);
                let frameColors = colors.step(ticker.deltaMS);
                const fresh = input.status === 'LIVE' && Date.now() - input.received < 350;
                const target = fresh ? [input.low, input.mid, input.high] : [0, 0, 0];
                if (import.meta.env.DEV && audioColors && (!productionManaged || audioColors.enabled())) {
                  const diagnosticColors = audioColors.step(frameColors, target, dt, {
                    raw: { bass: input.low, mid: input.mid, treble: input.high }, fresh, status: input.status,
                  });
                  if (!productionManaged) frameColors = diagnosticColors;
                }
                if (hybridEnabled) frameColors = hybridColors.step(frameColors, target, dt, fresh && input.fresh !== false);
                SpectrumMapping.update(spectrum16, fresh ? input.bands16 : null, dt, options.spectrumSmoothing);
                const spectrum = spectrum16;
                // Visual parameter easing only. Never sent back to, or applied within, Rust DSP.
                for (let i = 0; i < 3; i++) {
                    const tau = target[i] > smooth[i] ? [0.2, 0.09, 0.04][i] : [0.45, 0.22, 0.12][i];
                    smooth[i] += (target[i] - smooth[i]) * (1 - Math.exp(-dt / tau));
                }
                const low = smooth[0] * options.low * options.audioResponse;
                const mid = smooth[1] * options.mid * options.audioResponse;
                const high = smooth[2] * options.high * options.audioResponse;
                liquid.visible = options.master;
                for (const [index, blob] of blobs.entries()) {
                    const { spec: s, shape, blur } = blob;
                    // Blur is constant across audio frames and changes only with the preset.
                    blur.strength = options.blur;
                    const individual = options.blobs[index];
                    blob.drift += dt * options.drift * individual.drift * (1 + options.variation * variations[index])
                        * (0.32 + low * individual.low * 0.12 + mid * individual.mid * 0.2);
                    if (!options.master)
                        continue;
                    const l = low * s.weights[0] * individual.low;
                    const m = mid * s.weights[1] * individual.mid;
                    const h = high * s.weights[2] * individual.high;
                    const phase = blob.drift + s.seed;
                    const anchor = VisualModel.anchor(positions[index], options, individual);
                    const cx = anchor.x + options.movement * (9 * Math.sin(phase * 0.74) + 23 * m * Math.sin(phase * 1.6) + 5 * l * Math.cos(phase));
                    const cy = anchor.y + options.movement * (5 * Math.cos(phase * 0.85) + 12 * m * Math.sin(phase * 1.9));
                    const points = [];
                    const pointCount = 16 * 4;
                    const samples = Array.from({ length: pointCount }, (_, i) => ({ angle: i * Math.PI * 2 / pointCount, radius: 1, tension: 1 }));
                    const gains = [options.low * individual.low, options.mid * individual.mid, options.high * individual.high];
                    for (const sample of samples) {
                        const { angle } = sample;
                        const organic = options.irregularity * (0.13 * Math.sin(angle * 3 + phase * 0.65) + 0.09 * Math.cos(angle * 2 - phase * 0.47));
                        const reactive = Math.max(-0.65, Math.min(0.8, SpectrumMapping.offset(angle, spectrum, s.seed, options.spectrumSmoothing, gains)
                            * options.spectrumInfluence * options.radialDeformation * options.audioResponse));
                        const baseRadius = 1 + options.deformation * (organic + reactive);
                        // Extreme multi-band gains must not invert a radial sector through its center.
                        const radius = Math.max(0.25, baseRadius) * sample.radius;
                        const size = options.size * individual.size;
                        // Overlap changes horizontal fullness; Spread changes anchor separation.
                        const fullness = 1 + (options.overlap - 0.5) * 0.65;
                        points.push({ x: bounds(cx + Math.cos(angle) * s.rx * radius * size * fullness, 440),
                            y: bounds(cy + Math.sin(angle) * s.ry * radius * size, 164), tension: sample.tension });
                    }
                    curve(shape, points, frameColors[index]);
                    shape.alpha = Math.min(1, options.opacity * (0.91 + h * 0.22));
                }
            }
            catch (error) {
                app.stop();
                failed(error);
            }
        };
        app.ticker.add(render);
        const lost = event => { event.preventDefault(); app.stop(); failed(new Error('Visualizer WebGL context lost')); };
        app.canvas.addEventListener('webglcontextlost', lost);
        let stopDiagnostics;
        if (import.meta.env.DEV) {
            const { attachBlobDiagnostics } = await import("../dev/blob_diagnostics_renderer");
            stopDiagnostics = attachBlobDiagnostics({ host, app, blobs });
            const { attachAudioDrivenColors } = await import("../dev/audio_driven_colors_renderer");
            audioColors = attachAudioDrivenColors(host.parentElement);
        }
        let destroyed = false;
        return {
            setPreset: apply,
            setHybridPalette: enabled => {
                productionManaged = true;
                hybridEnabled = enabled;
                hybridColors.configure(enabled);
            },
            // Only the shared blob container moves. Its stage sibling mask stays fixed.
            setHorizontalPosition: value => {
                const normalized = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
                liquid.position.x = normalized * app.screen.width * 0.25;
            },
            setColors: (palette, duration) => {
                colors.target(palette, duration);
                if (duration === 0) colors.step(3000); // Immediate Appearance ON/OFF only.
                hybridColors.retarget(palette);
                if (import.meta.env.DEV) audioColors?.retarget(palette);
            },
            getColors: () => (hybridEnabled && hybridColors.current()) || (!productionManaged && import.meta.env.DEV && audioColors?.current()) || colors.current(),
            audio: value => { input = value; },
            destroy() {
                if (destroyed)
                    return;
                destroyed = true;
                if (import.meta.env.DEV) { stopDiagnostics?.(); audioColors?.stop(); }
                app.canvas.removeEventListener('webglcontextlost', lost);
                app.stop();
                app.ticker.remove(render);
                for (const blob of blobs) {
                    blob.shape.filters = null;
                    blob.blur.destroy();
                }
                app.destroy(true, { children: true });
            }
        };
    }
    catch (error) {
        try {
            app.destroy(true, { children: true });
        }
        catch { }
        throw error;
    }
}
