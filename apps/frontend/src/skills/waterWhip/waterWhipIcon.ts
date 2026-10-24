import { createSvgIcon, svgShape } from "../../ui/dom";

/** Water Whip's icon: a lash of water cracking into a splash. Used by the ability slot and the kill feed. */
export function createWaterWhipIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Water Whip", size);
  svg.append(
    svgShape("path", { d: "M3 20c3-1 4-4 5-8s3-7 7-7c3 0 4 2 3 4", fill: "none", stroke: "#3b8cff", "stroke-width": 3, "stroke-linecap": "round" }), // lash
    svgShape("path", { d: "M3 20c3-1 4-4 5-8s3-7 7-7", fill: "none", stroke: "#bfe6ff", "stroke-width": 1, "stroke-linecap": "round" }), // shine
    svgShape("circle", { cx: 20, cy: 12, r: 1.6, fill: "#8fd3ff" }), // spray
    svgShape("circle", { cx: 21.5, cy: 8, r: 1.1, fill: "#8fd3ff" }),
    svgShape("circle", { cx: 17.5, cy: 13.5, r: 1, fill: "#8fd3ff" }),
  );
  return svg;
}
