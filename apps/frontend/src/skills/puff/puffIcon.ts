import { createSvgIcon, svgShape } from "../../ui/dom";

/** Puff's icon: a swirl of wind bursting out in curls all round. Used by the ability slot and the kill feed. */
export function createPuffIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Puff", size);
  svg.append(
    svgShape("circle", { cx: 12, cy: 12, r: 10, fill: "none", stroke: "#4fa89a", "stroke-width": 1, "stroke-dasharray": "3 2.2" }), // the burst's edge
    svgShape("path", { d: "M12 4.5c3 0 5 2 4 4.5M19.5 12c0 3-2 5-4.5 4M12 19.5c-3 0-5-2-4-4.5M4.5 12c0-3 2-5 4.5-4", fill: "none", stroke: "#9be7d8", "stroke-width": 1.8, "stroke-linecap": "round" }), // curls blown outward
    svgShape("path", { d: "M12 9.5a2.5 2.5 0 1 1-2.2 1.3", fill: "none", stroke: "#dcfaf3", "stroke-width": 1.6, "stroke-linecap": "round" }), // the swirl at its heart
  );
  return svg;
}
