import { createSvgIcon, svgShape } from "../../ui/dom";

/** Boulders' icon: a boulder risen from the ground, with a kick's motion lines. Used by the ability slot and the kill feed. */
export function createBouldersIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Boulders", size);
  svg.append(
    svgShape("path", { d: "M8 21l-2-6 3-6 6-2 4 4 1 6-3 4z", fill: "#7a6450" }), // the boulder
    svgShape("path", { d: "M9 9l6-2 4 4-5 1z", fill: "#8a6d4b" }), // its lit top
    svgShape("path", { d: "M1 10h4M2 14h3M1 18h4", stroke: "#b59b7c", "stroke-width": 1.6, "stroke-linecap": "round" }), // motion
    svgShape("path", { d: "M3 22h19", stroke: "#b59b7c", "stroke-width": 2 }), // ground
  );
  return svg;
}
