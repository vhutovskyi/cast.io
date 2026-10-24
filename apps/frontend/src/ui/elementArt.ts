import type { MagicElement } from "@ligma/backend/shared/elements";
import { svgShape } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The fire icon's outer flame and core, on the same 24×24 grid as `ui/elements.ts`. */
const FLAME = "M12 2c1 3.6-1.6 5.6-3.1 7.6C7.6 11.5 7 13 7 14.6 7 17.6 9.2 20 12 20s5-2.3 5-5.4c0-2-1-3.6-2.1-4.6.2 1.5-.3 2.6-1.2 3.1.4-3.1-.9-6.6-1.7-11.1z";
const FLAME_CORE = "M12 12.2c.6 1.5-1.1 2.4-1.1 3.8a1.6 1.6 0 0 0 3.2 0c0-1.3-.8-2.5-2.1-3.8z";
const DROP = "M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z";
/** A sine of period 6 running well past both sides of the drop, so sliding it by 6 loops seamlessly. */
const WAVE = (y: number) => `M-12 ${y}q1.5-1.4 3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0t3 0V24H-12z`;
const GUSTS = ["M3 8h11a3 3 0 1 0-3-3", "M3 12h15a3 3 0 1 1-3 3", "M3 16h7"];
const MOUNTAIN = "M2 20 9 9l4 6 3-4 6 9z";

/** A group with a class, to animate on its own. */
function part(className: string, children: SVGElement[], delay?: number): SVGGElement {
  const g = svgShape("g", { class: className });
  if (delay !== undefined) { g.style.animationDelay = `${delay}s`; }
  g.append(...children);
  return g;
}

const ART: Record<MagicElement, () => SVGElement[]> = {
  // Three flame layers flickering out of step, embers rising off the top.
  fire: () => [
    part("art-flame", [svgShape("path", { d: FLAME, fill: "#e8461f" })]),
    // Scaled about the flame's base, so all three layers stand on the same point.
    (() => {
      const mid = svgShape("g", { transform: "translate(2.64 4.4) scale(.78)" });
      mid.append(part("art-flame mid", [svgShape("path", { d: FLAME, fill: "#ff8a2b" })]));
      return mid;
    })(),
    part("art-flame core", [svgShape("path", { d: FLAME_CORE, fill: "#ffd24e", transform: "translate(-6 -8.6) scale(1.5)" })]),
    ...[[11, -1.4, 0], [13.2, 1.6, -.9], [9.6, -2.4, -1.7]].map(([cx, dx, delay]) => {
      const ember = svgShape("circle", { class: "art-ember", cx, cy: 9, r: .45, fill: "#ffd24e" });
      ember.style.setProperty("--dx", `${dx}px`);
      ember.style.animationDelay = `${delay}s`;
      return ember;
    }),
  ],
  // A bobbing drop with water sloshing inside it, rippling the surface below.
  water: () => {
    const clip = svgShape("clipPath", { id: "art-water-clip" });
    clip.append(svgShape("path", { d: DROP }));
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.append(clip);
    const inside = svgShape("g", { "clip-path": "url(#art-water-clip)" });
    inside.append(
      part("art-wave back", [svgShape("path", { d: WAVE(11.5), fill: "#3b8cff", opacity: .55 })]),
      part("art-wave", [svgShape("path", { d: WAVE(13), fill: "#5aa2ff" })]),
    );
    return [
      defs,
      ...[0, -1.3].map((delay) => part("art-ripple", [svgShape("ellipse", { cx: 12, cy: 22, rx: 6, ry: 1.3, fill: "none", stroke: "#5aa2ff", "stroke-width": .6 })], delay)),
      part("art-bob", [
        svgShape("path", { d: DROP, fill: "#1d4fc4" }),
        inside,
        svgShape("ellipse", { cx: 9.4, cy: 12.4, rx: .9, ry: 1.7, fill: "#fff", opacity: .55, transform: "rotate(20 9.4 12.4)" }),
      ]),
    ];
  },
  // Each gust's faint trace, with a streak of air running along it.
  wind: () => [
    ...GUSTS.map((d) => svgShape("path", { d, fill: "none", stroke: "#9be7d8", "stroke-width": 2, "stroke-linecap": "round", opacity: .22 })),
    ...GUSTS.map((d, i) => {
      const gust = svgShape("path", { d, class: "art-gust", pathLength: 100, fill: "none", stroke: "#9be7d8", "stroke-width": 2, "stroke-linecap": "round" });
      gust.style.animationDuration = `${[2.2, 1.7, 2.6][i]}s`;
      gust.style.animationDelay = `${[0, -.6, -1.1][i]}s`;
      return gust;
    }),
    ...[[6, 20, 0], [14, 19.5, -1.4]].map(([cx, cy, delay]) => part("art-mote", [svgShape("circle", { cx, cy, r: .5, fill: "#c9f5ec" })], delay)),
  ],
  // A peak with its lit face, and shards of rock levitating around it.
  earth: () => [
    svgShape("rect", { x: 1, y: 19.6, width: 22, height: 1.2, rx: .6, fill: "#7d5f36" }),
    svgShape("path", { d: MOUNTAIN, fill: "#b08850" }),
    svgShape("path", { d: "M9 9 6.6 12.8 9 11.7l1.9 1.1z", fill: "#d9b479" }),
    part("art-rock", [svgShape("path", { d: "M3.6 6.2l2-1.1 1.7.8-.4 1.9-2 .6-1.5-1z", fill: "#c49a5e" })], 0),
    part("art-rock", [svgShape("path", { d: "M16.6 3.8l1.7-.7 1.3 1-.6 1.6-1.7.2-.9-1.1z", fill: "#a87f4a" })], -1.1),
    part("art-rock", [svgShape("path", { d: "M20.2 9.4l1-.4.8.7-.5 1-1.1.1z", fill: "#d9b479" })], -2),
  ],
};

/**
 * A big, animated emblem of an element for the lobby's tiles. Decorative:
 * the tile's own label names it. Motion is all CSS (index.html), so reduced
 * motion stills it.
 */
export function createElementArt(element: MagicElement): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("element-art", `art-${element}`);
  svg.append(...ART[element]());
  return svg;
}
