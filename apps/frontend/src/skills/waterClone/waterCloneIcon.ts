import { createSvgIcon, svgShape } from "../../ui/dom";

/** Water Clone's icon: a mage of water stepping out from behind a solid one. Used by the ability slot and the kill feed. */
export function createWaterCloneIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Water Clone", size);
  svg.append(
    svgShape("circle", { cx: 15.5, cy: 6.5, r: 3, fill: "#8fd3ff", "fill-opacity": 0.75 }), // the clone's head
    svgShape("path", { d: "M10 21c0-5 2.5-8.5 5.5-8.5S21 16 21 21z", fill: "#3b8cff", "fill-opacity": 0.7 }), // the clone's body
    svgShape("path", { d: "M12.5 13.5c1-.6 2-1 3-1", fill: "none", stroke: "#dff3ff", "stroke-width": 1, "stroke-linecap": "round" }), // shine on the water
    svgShape("circle", { cx: 8, cy: 8, r: 3, fill: "#2b5fa8" }), // the mage's head
    svgShape("path", { d: "M2.5 21c0-5 2.5-8.5 5.5-8.5s5.5 3.5 5.5 8.5z", fill: "#1d4680" }), // the mage's body
  );
  return svg;
}
