import { createSvgIcon, svgShape } from "../../ui/dom";

/** Leap's icon: a gust swept forward into a dash, wind streaks trailing behind. Used by the ability slot and the kill feed. */
export function createLeapIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Leap", size);
  svg.append(
    svgShape("path", { d: "M10 5l12 7-12 7 3.5-7z", fill: "#9be7d8" }), // the dash's arrowhead
    svgShape("path", { d: "M10 5l12 7h-8.5z", fill: "#d4f6ef" }), // its lit upper half
    svgShape("path", { // wind streaks trailing behind
      d: "M2 8h7M1 12h10M3 16h6",
      fill: "none", stroke: "#9be7d8", "stroke-width": 1.6, "stroke-linecap": "round",
    }),
    svgShape("path", { d: "M5 20c2.5 1.5 6 1.5 8.5-.5", fill: "none", stroke: "#5fb3a3", "stroke-width": 1.2, "stroke-linecap": "round" }), // a swirl kicked up off the ground
  );
  return svg;
}
