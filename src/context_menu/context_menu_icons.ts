// Lucide SVG paths, ISC/MIT; see context-menu-icons/LICENSE.
const paths = {
  sliders: ["M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"],
  pin: ["M12 17v5", "M9 9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1 3 3 0 0 0 3 3h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a3 3 0 0 0 3-3"],
  power: ["M12 2v10", "M18.36 6.64a9 9 0 1 1-12.73 0"],
  check: ["m20 6-11 11-5-5"],
} as const;

export function menuIcon(name: keyof typeof paths): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) icon.setAttribute(key, value);
  for (const d of paths[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d); icon.appendChild(path);
  }
  return icon;
}
