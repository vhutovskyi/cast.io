import { createSvgIcon, svgShape } from "../../ui/dom";

/** Stone Skin's icon: a figure's outline plated in stone. Used by the ability slot and the kill feed. */
export function createStoneSkinIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Stone Skin", size);
  svg.append(
    svgShape("path", { d: "M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z", fill: "#8a6d4b" }), // shield of stone
    svgShape("path", { d: "M12 2l8 3v6c0 5-3.4 9.3-8 11z", fill: "#6b523a" }), // shaded half
    svgShape("path", { d: "M7 8l4 2-1 4 4 1M14 6l1 3 3 1M9 16l3-1 2 3", fill: "none", stroke: "#3d2f22", "stroke-width": 1.2, "stroke-linecap": "round" }), // cracks between plates
  );
  return svg;
}
