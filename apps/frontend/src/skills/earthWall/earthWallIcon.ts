import { createSvgIcon, svgShape } from "../../ui/dom";

/** Earth Wall's icon: a wall of heaped stone rising out of the ground. Used by the ability slot and the kill feed. */
export function createEarthWallIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Earth Wall", size);
  svg.append(
    svgShape("path", { d: "M3 21V9l3-3 4 2 3-4 4 3 4-1v15z", fill: "#7a6450" }), // the wall
    svgShape("path", { d: "M3 13h18M3 17h18M9 9v4M15 9v4M6 13v4M12 13v4M18 13v4M9 17v4M15 17v4", stroke: "#4a3b2e", "stroke-width": 1.1, fill: "none" }), // courses of stone
    svgShape("path", { d: "M1 22h22", stroke: "#b59b7c", "stroke-width": 2 }), // ground
  );
  return svg;
}
