import { createSvgIcon, svgShape } from "../../ui/dom";

/** Fireball's icon: a hot ball trailing flame. Used by the ability slot and the kill feed. */
export function createFireballIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Fireball", size);
  svg.append(
    svgShape("path", { d: "M22 2c-4.2.4-8.6 2-11.9 4.6A7 7 0 1 0 17.4 13.9C20 10.6 21.6 6.2 22 2z", fill: "#ff6a2b" }), // flame
    svgShape("circle", { cx: 9, cy: 15, r: 4, fill: "#ffd24e" }), // core
  );
  return svg;
}
