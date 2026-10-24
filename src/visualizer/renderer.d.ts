import type { Options, Renderer } from "./controller";
export function createBlobRenderer(host: HTMLElement, options: Options, failed: (error: unknown) => void): Promise<Renderer>;
