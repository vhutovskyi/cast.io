import { createSvgIcon, svgShape } from "../../ui/dom";

/** Torrent's icon: a geyser of water bursting up between icicles. Used by the ability slot and the kill feed. */
export function createTorrentIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Torrent", size);
  svg.append(
    svgShape("path", { d: "M9 21c-1-5 0-10 1-13 .5-2 1.5-4 2-5 .5 1 1.5 3 2 5 1 3 2 8 1 13z", fill: "#3b8cff" }), // column
    svgShape("path", { d: "M11 20c-.5-4 0-8 1-12 1 4 1.5 8 1 12z", fill: "#bfe6ff" }), // core
    svgShape("path", { d: "M4 21l2-9 2 9z", fill: "#d8f4ff" }), // icicles
    svgShape("path", { d: "M16 21l2-11 2 11z", fill: "#d8f4ff" }),
    svgShape("ellipse", { cx: 12, cy: 21.5, rx: 10, ry: 1.5, fill: "#2a7bff" }), // pool
  );
  return svg;
}
