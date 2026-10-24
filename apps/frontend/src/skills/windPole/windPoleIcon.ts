import { createSvgIcon, svgShape } from "../../ui/dom";

/** Wind Pole's icon: a wooden pole, and a gust of wind — a crescent with streaks behind it. Used by the ability slot and the kill feed. */
export function createWindPoleIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Wind Pole", size);
  svg.append(
    svgShape("path", { d: "M2 21L15 16", fill: "none", stroke: "#8a5a3b", "stroke-width": 2.4, "stroke-linecap": "round" }), // pole
    svgShape("path", { d: "M12 2c-3 3-3 8 0 11M14 3c-2 2.5-2 6.5 0 9", fill: "none", stroke: "#9fb4c3", "stroke-width": 1.4, "stroke-linecap": "round" }), // crescent
    svgShape("path", { d: "M15 5h7M16 7.5h5M15 10h6", fill: "none", stroke: "#9fb4c3", "stroke-width": 1.2, "stroke-linecap": "round" }), // streaks
  );
  return svg;
}
