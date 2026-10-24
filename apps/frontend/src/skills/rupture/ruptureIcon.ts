import { createSvgIcon, svgShape } from "../../ui/dom";

/** Rupture's icon: rock spikes bursting up across a fan of cracked ground. Used by the ability slot and the kill feed. */
export function createRuptureIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Rupture", size);
  svg.append(
    svgShape("path", { d: "M12 23L1 9h22z", fill: "#5c4630" }), // the fan of torn ground
    svgShape("path", { // cracks running out from the caster's feet
      d: "M12 23l-1.5-5 1-3-1-4M12 23l3-6-.5-3 2.5-3",
      fill: "none", stroke: "#2a1f15", "stroke-width": 1.2, "stroke-linecap": "round", "stroke-linejoin": "round",
    }),
    svgShape("path", { d: "M3 13l2.5-11L8 12zM9 12l3-10.5L15 12zM16 12l2.5-9L21 13z", fill: "#b08850" }), // spikes
    svgShape("path", { d: "M5.5 2L6.6 12.3M12 1.5v10.4M18.5 3l-.6 9.4", fill: "none", stroke: "#e2c79a", "stroke-width": 0.8, "stroke-linecap": "round" }), // lit edges
  );
  return svg;
}
