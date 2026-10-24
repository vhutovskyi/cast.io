/** An element index.html is known to have. */
export const $ = (id: string) => document.getElementById(id)!;

const SVG_NS = "http://www.w3.org/2000/svg";

/** An empty 24×24 icon to draw into. Static, trusted path data only. */
export function createSvgIcon(label: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-label", label);
  svg.classList.add("element-icon");
  return svg;
}

/** A child shape for an icon, with its attributes. */
export function svgShape<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const shape = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) { shape.setAttribute(name, String(value)); }
  return shape;
}
