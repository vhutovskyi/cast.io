import type { MagicElement } from "@ligma/backend/shared/elements";
import { createSvgIcon, svgShape } from "./dom";

interface ElementStyle {
  label: string;
  /** Body tint and icon colour. */
  color: number;
  /** 24×24 icon: filled shapes, plus stroked lines for wind. */
  fills: { d: string; color: string }[];
  strokes?: string[];
}

export const ELEMENT_STYLES: Record<MagicElement, ElementStyle> = {
  fire: {
    label: "Fire",
    color: 0xff6a2b,
    fills: [
      { d: "M12 2c1 3.6-1.6 5.6-3.1 7.6C7.6 11.5 7 13 7 14.6 7 17.6 9.2 20 12 20s5-2.3 5-5.4c0-2-1-3.6-2.1-4.6.2 1.5-.3 2.6-1.2 3.1.4-3.1-.9-6.6-1.7-11.1z", color: "#ff6a2b" },
      { d: "M12 12.2c.6 1.5-1.1 2.4-1.1 3.8a1.6 1.6 0 0 0 3.2 0c0-1.3-.8-2.5-2.1-3.8z", color: "#ffd24e" },
    ],
  },
  water: {
    label: "Water",
    color: 0x3b8cff,
    fills: [{ d: "M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z", color: "#3b8cff" }],
  },
  wind: {
    label: "Wind",
    color: 0x9be7d8,
    fills: [],
    strokes: ["M3 8h11a3 3 0 1 0-3-3", "M3 12h15a3 3 0 1 1-3 3", "M3 16h7"],
  },
  earth: {
    label: "Earth",
    color: 0xb08850,
    fills: [{ d: "M2 20 9 9l4 6 3-4 6 9z", color: "#b08850" }],
  },
};

/** Builds an element icon with DOM APIs — static, trusted path data only. */
export function createElementIcon(element: MagicElement, size = 16): SVGSVGElement {
  const style = ELEMENT_STYLES[element];
  const svg = createSvgIcon(style.label, size);
  for (const { d, color } of style.fills) {
    svg.append(svgShape("path", { d, fill: color }));
  }
  for (const d of style.strokes ?? []) {
    svg.append(svgShape("path", { d, fill: "none", stroke: `#${style.color.toString(16).padStart(6, "0")}`, "stroke-width": 2, "stroke-linecap": "round" }));
  }
  return svg;
}
