import { createSvgIcon, svgShape } from "../../ui/dom";

/** Flame Breath's icon: a fan of fire widening from the hand. Used by the ability slot and the kill feed. */
export function createFlameBreathIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Flame Breath", size);
  svg.append(
    svgShape("path", { d: "M2 12 21 3.5c-1.6 2.6-2.4 5.4-1.2 8.5-1.2 3.1-.4 5.9 1.2 8.5z", fill: "#ff6a2b" }), // fan
    svgShape("path", { d: "M2 12 14 8c-.9 1.4-1.2 2.7-.6 4-.6 1.3-.3 2.6.6 4z", fill: "#ffd24e" }), // core
  );
  return svg;
}
