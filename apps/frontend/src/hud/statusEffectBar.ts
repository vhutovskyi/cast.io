/** How an effect's square looks. Keyed by the server's effect id. */
export interface StatusEffectLook {
  /** Shown on hover. */
  name: string;
  /** Square background, any CSS colour. */
  color: string;
}

/** Unknown ids get a plain square. */
export const STATUS_EFFECT_LOOKS: Readonly<Record<string, StatusEffectLook>> = {
  burn: { name: "Burning", color: "#d9480f" },
  slow: { name: "Slowed", color: "#1c7ed6" },
  frozen: { name: "Frozen", color: "#4aa8ff" },
  stunned: { name: "Stunned", color: "#e0a526" },
  stone_skin: { name: "Stone Skin", color: "#8a6d4b" },
  speed_boost: { name: "Speed Boost", color: "#2fb39a" },
  soaring: { name: "Soaring", color: "#7fb8e6" },
};

/**
 * The squares beside our own health bar, one per status effect on us, in the
 * order they landed. Fed by the server-owned `Player.effects` list.
 */
export class StatusEffectBar {
  private squares = new Map<string, HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  /** Matches the squares to `ids`: new ones go at the end, gone ones go. */
  show(ids: Iterable<string>) {
    const current = new Set(ids);
    for (const id of this.squares.keys()) {
      if (!current.has(id)) { this.remove(id); }
    }
    current.forEach((id) => this.add(id));
  }

  private add(id: string) {
    if (this.squares.has(id)) { return; }
    const look = STATUS_EFFECT_LOOKS[id];
    const square = document.createElement("div");
    square.className = "status-effect";
    square.title = look?.name ?? id;
    square.textContent = (look?.name ?? id).charAt(0).toUpperCase();
    if (look) { square.style.background = look.color; }
    this.root.append(square);
    this.squares.set(id, square);
  }

  private remove(id: string) {
    this.squares.get(id)?.remove();
    this.squares.delete(id);
  }

  clear() {
    this.squares.forEach((square) => square.remove());
    this.squares.clear();
  }
}
