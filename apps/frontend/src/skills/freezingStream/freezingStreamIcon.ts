import { createSvgIcon, svgShape } from "../../ui/dom";

/** Freezing Stream's icon: a jet of water shooting out and freezing into an ice crystal. Used by the ability slot and the kill feed. */
export function createFreezingStreamIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Freezing Stream", size);
  svg.append(
    svgShape("path", { d: "M2 21L13 10", fill: "none", stroke: "#2a7bff", "stroke-width": 4, "stroke-linecap": "round" }), // jet
    svgShape("path", { d: "M2 21L13 10", fill: "none", stroke: "#6fc8ff", "stroke-width": 1.5, "stroke-linecap": "round" }), // shine
    svgShape("path", { // ice crystal at the head
      d: "M17 3v12M11 9h12M12.8 4.8l8.4 8.4M21.2 4.8l-8.4 8.4",
      fill: "none", stroke: "#d8f4ff", "stroke-width": 1.6, "stroke-linecap": "round",
    }),
    svgShape("circle", { cx: 17, cy: 9, r: 2, fill: "#ffffff" }),
    svgShape("circle", { cx: 6, cy: 13.5, r: 1, fill: "#d8f4ff" }), // frost along the jet
    svgShape("circle", { cx: 9.5, cy: 18, r: 0.9, fill: "#d8f4ff" }),
  );
  return svg;
}
