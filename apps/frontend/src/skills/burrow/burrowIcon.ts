import { createSvgIcon, svgShape } from "../../ui/dom";

/** Burrow's icon: a claw digging down into a mound of churned earth, clods flung off it. Used by the ability slot and the kill feed. */
export function createBurrowIcon(size = 16): SVGSVGElement {
  const svg = createSvgIcon("Burrow", size);
  svg.append(
    svgShape("path", { d: "M1 22c1.5-6 5.5-9 11-9s9.5 3 11 9z", fill: "#7a6249" }), // the mound
    svgShape("path", { d: "M4 18c2-2.6 4.6-3.8 8-3.8", fill: "none", stroke: "#b08850", "stroke-width": 1.2, "stroke-linecap": "round" }), // its lit crest
    svgShape("path", { d: "M8.5 22l3.5-5 3.5 5z", fill: "#2a1f15" }), // the hole dug into it
    svgShape("path", { // the claw, three talons raking down into the hole
      d: "M9 3l1.5 9M12 2v10.5M15 3l-1.5 9",
      fill: "none", stroke: "#e2c79a", "stroke-width": 1.8, "stroke-linecap": "round",
    }),
    svgShape("path", { d: "M10 14.5l2 3 2-3z", fill: "#e2c79a" }), // the arrowhead going down
    svgShape("circle", { cx: 4, cy: 10, r: 1.2, fill: "#8f7a63" }), // clods flung off
    svgShape("circle", { cx: 20, cy: 9, r: 1, fill: "#8f7a63" }),
    svgShape("circle", { cx: 18.5, cy: 5, r: 0.7, fill: "#5e4c3a" }),
  );
  return svg;
}
