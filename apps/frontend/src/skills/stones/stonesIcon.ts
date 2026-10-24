import { createSvgIcon, svgShape } from "../../ui/dom";

/** Stone Fists' icon: a fist of stone punching right, its knuckles leading, dust streaking behind. Used by the ability slot and the kill feed. */
export function createStonesIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Stone Fists", size);
  svg.append(
    svgShape("path", { d: "M2 10.5h3M1.5 14h3.5M2 17.5h3", fill: "none", stroke: "#c9ab82", "stroke-width": 1.5, "stroke-linecap": "round" }), // dust streaks
    svgShape("path", { d: "M6 10l2-3 9-1 4 2 1 4-1 5-4 2-8-.5-3-2.5z", fill: "#7a6248", stroke: "#4a3a2a", "stroke-width": 1, "stroke-linejoin": "round" }), // the fist
    svgShape("path", { d: "M17 6l4 2 1 4-1 5-4 2z", fill: "#9a8366", stroke: "#4a3a2a", "stroke-width": 1, "stroke-linejoin": "round" }), // curled fingers, knuckles forward
    svgShape("path", { d: "M17.5 9.5h3.5M17.5 12.5h4M17.5 15.5h3.5", fill: "none", stroke: "#4a3a2a", "stroke-width": 1, "stroke-linecap": "round" }), // between the fingers
    svgShape("path", { d: "M9 17.5l2-3h5l1 2-2 2.5z", fill: "#8f7656", stroke: "#4a3a2a", "stroke-width": 1, "stroke-linejoin": "round" }), // thumb folded across
    svgShape("path", { d: "M8 8l3.5-.5-1.5 2z", fill: "#d2b48a" }), // lit facet
  );
  return svg;
}
