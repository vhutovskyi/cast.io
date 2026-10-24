import { createSvgIcon, svgShape } from "../../ui/dom";

/** Skyfall's icon: a mage plunging out of the sky on a gust, onto a shockwave. Used by the ability slot and the kill feed. */
export function createSkyfallIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Skyfall", size);
  svg.append(
    svgShape("path", { d: "M5 3c3 1 4 3 3 5M19 3c-3 1-4 3-3 5", fill: "none", stroke: "#5fd6c0", "stroke-width": 1.4, "stroke-linecap": "round" }), // wind trailing behind
    svgShape("path", { d: "M12 2c-2 3-3 6-3 9h6c0-3-1-6-3-9z", fill: "#bff5ea", opacity: 0.55 }), // the trail
    svgShape("path", { d: "M12 17l-4-6h8z", fill: "#9be7d8" }), // the plunging mage, feet first
    svgShape("circle", { cx: 12, cy: 9, r: 2, fill: "#e8fffa" }),
    svgShape("ellipse", { cx: 12, cy: 20.5, rx: 10, ry: 2, fill: "none", stroke: "#bff5ea", "stroke-width": 1.4 }), // shockwave
    svgShape("ellipse", { cx: 12, cy: 20.5, rx: 5, ry: 1, fill: "#5fd6c0" }),
  );
  return svg;
}
