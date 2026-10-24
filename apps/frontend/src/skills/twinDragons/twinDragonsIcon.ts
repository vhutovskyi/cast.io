import { createSvgIcon, svgShape } from "../../ui/dom";

/** Twin Dragons' icon: two flames curving in to meet at a burst. Used by the ability slot and the kill feed. */
export function createTwinDragonsIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Twin Dragons", size);
  svg.append(
    svgShape("path", { // streams
      d: "M12 22C4 18 3 10 12 5M12 22C20 18 21 10 12 5",
      fill: "none", stroke: "#ff6a2b", "stroke-width": 2.5, "stroke-linecap": "round",
    }),
    svgShape("circle", { cx: 12, cy: 5, r: 3.5, fill: "#ffd27a" }), // burst
  );
  return svg;
}
