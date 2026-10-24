import { createSvgIcon, svgShape } from "../../ui/dom";

/** Sun Strike's icon: a sun with rays. Used by the ability slot and the kill feed. */
export function createSunStrikeIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Sun Strike", size);
  svg.append(
    svgShape("circle", { cx: 12, cy: 12, r: 5, fill: "#ffd27a" }), // sun
    svgShape("path", { // rays
      d: "M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1",
      stroke: "#ff8c2b", "stroke-width": 2, "stroke-linecap": "round",
    }),
  );
  return svg;
}
