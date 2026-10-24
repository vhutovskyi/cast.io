import * as THREE from "three";
import {
  TWIN_DRAGONS, TWIN_DRAGONS_SIDES, clampTwinDragonsTarget, twinDragonsPoint,
  type GroundPoint, type TwinDragonsBlast, type TwinDragonsHeads, type TwinDragonsLaunch,
} from "@ligma/backend/skills/twinDragons/twinDragonsConfig";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { TICK_RATE } from "@ligma/backend/shared/constants";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

const BLAST_RADIUS = TWIN_DRAGONS.blastRadius * WORLD_SCALE;
const RANGE = TWIN_DRAGONS.range * WORLD_SCALE;
/** Flames are drawn at about half the height a jump has to clear. */
const FLAME_HEIGHT = (TWIN_DRAGONS.streamHeight / 2) * WORLD_SCALE;
const FLAME_SIZE = TWIN_DRAGONS.streamRadius * 2 * WORLD_SCALE * 1.6;
/** Points per preview curve. */
const PREVIEW_POINTS = 40;
/** Fire on the ground: one flame every stream-width, burning as long as the server's (seconds). */
const PUFF_SPACING = TWIN_DRAGONS.streamRadius;
const TRAIL_LIFE = TWIN_DRAGONS.trailMs / 1000;
/** A flame flares up over this when the head passes, and dies down over the last of its life. */
const PUFF_FLARE = 0.2;
const PUFF_FADE = 0.5;
/** How far behind the latest head report the heads are drawn: two server steps, room for uneven arrival. */
const PLAYBACK_DELAY_MS = 2000 / TICK_RATE;
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/**
 * While Twin Dragons is selected, local only: the range around us, both
 * streams' paths to the crosshair's ground point (pulled into range), and the
 * blast ring where they will meet.
 */
class AimPreview {
  readonly group = new THREE.Group();
  private readonly range = onFloor(new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.08, RANGE, 96), glowMaterial(0xff8c2b, 0.18)));
  private readonly blast = onFloor(new THREE.Mesh(new THREE.RingGeometry(BLAST_RADIUS * 0.9, BLAST_RADIUS, 48), glowMaterial(0xffd27a, 0.6)), 0.04);
  private readonly paths = TWIN_DRAGONS_SIDES.map(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PREVIEW_POINTS * 3), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xff8c2b, transparent: true, opacity: 0.8, depthWrite: false });
    return new THREE.Line(geometry, material);
  });
  private readonly point = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    this.group.add(this.range, this.blast, ...this.paths);
    this.group.visible = false;
    parent.add(this.group);
  }

  show(origin: GroundPoint, target: GroundPoint | null) {
    this.group.visible = target !== null;
    if (!target) { return; }
    const end = clampTwinDragonsTarget(origin, target);

    toWorld(origin.x, origin.y, this.range.position).setY(0.03);
    toWorld(end.x, end.y, this.blast.position).setY(0.04);
    TWIN_DRAGONS_SIDES.forEach((side, s) => {
      const positions = this.paths[s].geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < PREVIEW_POINTS; i++) {
        const at = twinDragonsPoint(origin, end, side, i / (PREVIEW_POINTS - 1));
        toWorld(at.x, at.y, this.point);
        positions.setXYZ(i, this.point.x, 0.06, this.point.z);
      }
      positions.needsUpdate = true;
      this.paths[s].geometry.computeBoundingSphere();
    });
  }

  dispose() {
    disposeGroup(this.group);
    this.paths.forEach((path) => { path.geometry.dispose(); path.material.dispose(); });
  }
}

/**
 * The caster's private view of where the streams will meet: a ring pulsing
 * faster as they close in. Nobody else is told the spot.
 */
class MeetingMarker implements Effect {
  private readonly group = new THREE.Group();
  private readonly warning = glowMaterial(0xff4a1a);
  private elapsed = 0;
  private done = false;

  constructor(parent: THREE.Object3D, target: GroundPoint, private readonly travel: number) {
    this.group.add(onFloor(new THREE.Mesh(new THREE.RingGeometry(BLAST_RADIUS * 0.88, BLAST_RADIUS, 48), this.warning), 0.04));
    toWorld(target.x, target.y, this.group.position);
    parent.add(this.group);
  }

  /** The blast arrived: hand over to its effect. */
  finish() {
    this.done = true;
  }

  update(dt: number) {
    const now = (this.elapsed += dt);
    const t = Math.min(now / this.travel, 1);
    this.warning.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now * (10 + 20 * t)));
    // Safety net if the blast message never comes (e.g. we left the room).
    return !this.done && now < this.travel + 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** One flame of the fire a head leaves on the ground. */
interface Puff { sprite: THREE.Sprite; age: number; phase: number; }

/**
 * Both streams on their way, for everyone, drawn only from where the server
 * says the heads are: a bright head racing along each, and the fire it leaves
 * burning on the ground for as long as the server's does. Where they are
 * going is never known here, so neither is drawn ahead of the heads.
 *
 * Reports arrive unevenly (bunched, late), so the heads aren't moved on
 * arrival: they're played back on the flight's own clock, a little behind the
 * latest report, interpolating between the two around it.
 */
class StreamsEffect implements Effect {
  private readonly group = new THREE.Group();
  /** Per stream: its head sprite, where it was last drawn, and how far it has come since its last flame. */
  private readonly heads = TWIN_DRAGONS_SIDES.map(() => {
    const sprite = glowSprite(0xffd27a, 1);
    sprite.scale.setScalar(FLAME_SIZE * 1.6);
    sprite.visible = false;
    this.group.add(sprite);
    return { sprite, drawn: null as GroundPoint | null, sinceFlame: 0 };
  });
  private readonly puffs: Puff[] = [];
  /** Reports not yet played past, oldest first. */
  private readonly reports: TwinDragonsHeads[] = [];
  /** The flight time being drawn, in ms; NaN until the first report. */
  private clock = NaN;
  /** Seconds since the latest head report. */
  private sinceReport = 0;
  /** Set once the server's heads have met: what to do when ours do. */
  private onMet: (() => void) | null = null;
  private met = false;

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  report(msg: TwinDragonsHeads) {
    const latest = this.reports.at(-1);
    if (latest && msg.elapsedMs <= latest.elapsedMs) { return; }
    this.reports.push(msg);
    this.sinceReport = 0;
    if (Number.isNaN(this.clock)) { this.clock = msg.elapsedMs - PLAYBACK_DELAY_MS; }
  }

  /** The heads met on the server: once they meet here too, they're gone (their fire burns on) and `then` runs. */
  finish(then: () => void) {
    this.onMet = then;
  }

  private addPuff(x: number, y: number) {
    const sprite = glowSprite(0xff6a2b);
    toWorld(x, y, sprite.position).setY(FLAME_HEIGHT);
    this.group.add(sprite);
    this.puffs.push({ sprite, age: 0, phase: Math.random() * Math.PI * 2 });
  }

  /** Advances the playback clock and moves each head to where it was at that time. */
  private play(dt: number) {
    const latest = this.reports.at(-1);
    if (!latest || this.met) { return; }

    // Ease toward PLAYBACK_DELAY_MS behind the latest report: a little faster
    // when reports pile up, slower when they run late — never past the latest.
    // Once the server is done there's nothing left to wait for.
    const lag = latest.elapsedMs - this.clock;
    const rate = this.onMet ? 1.5 : Math.min(2, Math.max(0.5, 1 + (lag - PLAYBACK_DELAY_MS) / 250));
    this.clock = Math.min(this.clock + dt * 1000 * rate, latest.elapsedMs);

    while (this.reports.length > 2 && this.reports[1].elapsedMs <= this.clock) { this.reports.shift(); }
    const [a, b = a] = this.reports;
    const k = b.elapsedMs > a.elapsedMs ? Math.min(1, Math.max(0, (this.clock - a.elapsedMs) / (b.elapsedMs - a.elapsedMs))) : 1;

    this.heads.forEach((head, s) => {
      const from = a.heads[s];
      const to = b.heads[s];
      if (!from || !to) { return; }
      const at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      this.layFire(head, at);
      toWorld(at.x, at.y, head.sprite.position).setY(FLAME_HEIGHT);
      head.sprite.visible = true;
    });

    if (this.onMet && this.clock >= latest.elapsedMs) {
      this.met = true;
      this.heads.forEach((head) => { head.sprite.visible = false; });
      this.onMet();
    }
  }

  /** A flame every PUFF_SPACING along the stretch the head was just drawn moving. */
  private layFire(head: (typeof this.heads)[number], at: GroundPoint) {
    const from = head.drawn;
    head.drawn = at;
    if (!from) { this.addPuff(at.x, at.y); return; }
    const length = Math.hypot(at.x - from.x, at.y - from.y);
    let next = PUFF_SPACING - head.sinceFlame;
    for (; next <= length; next += PUFF_SPACING) {
      this.addPuff(from.x + ((at.x - from.x) * next) / length, from.y + ((at.y - from.y) * next) / length);
    }
    head.sinceFlame = length - (next - PUFF_SPACING);
  }

  update(dt: number) {
    this.sinceReport += dt;
    // Safety net if the blast message never comes (e.g. we left the room).
    if (this.sinceReport > 1 && !this.onMet) {
      this.met = true;
      this.heads.forEach((head) => { head.sprite.visible = false; });
    }
    this.play(dt);

    for (const puff of this.puffs) {
      const age = (puff.age += dt);
      const flare = Math.min(age / PUFF_FLARE, 1);
      const fade = Math.min(1, Math.max(0, (TRAIL_LIFE - age) / PUFF_FADE));
      const flicker = 0.8 + 0.2 * Math.sin(age * 14 + puff.phase);
      puff.sprite.material.opacity = 0.9 * flare * fade * flicker;
      puff.sprite.scale.setScalar(FLAME_SIZE * (1.5 - 0.5 * flare) * (0.9 + 0.1 * flicker));
    }

    return !this.met || this.puffs.some((puff) => puff.age < TRAIL_LIFE);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Where the streams meet: a flash, a shockwave and embers on the ground. */
class BlastEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(0xffd27a, 1);
  private readonly shock = glowMaterial(0xff8c2b);
  private readonly shockMesh: THREE.Mesh;
  private readonly embers = glowMaterial(0xff4a1a);
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number) {
    toWorld(x, y, this.group.position);
    this.flash.position.y = FLAME_HEIGHT * 2;
    this.group.add(this.flash);
    this.shockMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(BLAST_RADIUS * 0.8, BLAST_RADIUS, 48), this.shock), 0.05);
    this.group.add(this.shockMesh);
    this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(BLAST_RADIUS, 48), this.embers), 0.03));
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const burst = Math.min(t / 0.15, 1);
    this.flash.scale.setScalar(BLAST_RADIUS * (1 + 1.5 * burst));
    this.flash.material.opacity = 0.8 * Math.max(0, 1 - t / 0.4);

    const wave = Math.min(t / 0.5, 1);
    this.shockMesh.scale.setScalar(1 + 1.2 * wave);
    this.shock.opacity = 0.9 * (1 - wave);
    this.embers.opacity = 0.6 * Math.max(0, 1 - t / 1.5);
    return t < 1.5;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Twin Dragons: select with its slot's key, cast with a click, the aiming
 * preview, the streams and blast everyone sees, and the cooldown display.
 * The server decides everything that matters (cooldown, range, who burns).
 * `slot` is null when Twin Dragons isn't in our kit: then only others' casts are drawn.
 */
export class TwinDragonsController implements SlotSkill {
  private readonly preview: AimPreview;
  /** Casts in flight, by id: everyone's streams, and the meeting point of our own. */
  private readonly streams = new Map<number, StreamsEffect>();
  private readonly markers = new Map<number, MeetingMarker>();
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  private armed = false;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.preview = new AimPreview(scene.scene);

    // Ours only: nobody else is told where the streams meet.
    room.onMessage(SERVER_MESSAGE.twinDragonsLaunch, (msg: TwinDragonsLaunch) => {
      clearTimeout(this.confirmTimer);
      // Counted from arrival: a little behind the server's own cooldown, so
      // a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      this.markers.set(msg.id, this.effects.add(new MeetingMarker(scene.scene, msg.target, msg.travelMs / 1000)));
    });

    room.onMessage(SERVER_MESSAGE.twinDragonsHeads, (msg: TwinDragonsHeads) => {
      let streams = this.streams.get(msg.id);
      if (!streams) { this.streams.set(msg.id, streams = this.effects.add(new StreamsEffect(scene.scene))); }
      streams.report(msg);
    });

    // Drawn when the heads are seen to meet, a moment behind the server.
    room.onMessage(SERVER_MESSAGE.twinDragonsBlast, (msg: TwinDragonsBlast) => {
      const marker = this.markers.get(msg.id);
      this.markers.delete(msg.id);
      const blast = () => {
        marker?.finish();
        this.effects.add(new BlastEffect(scene.scene, msg.x, msg.y));
      };
      const streams = this.streams.get(msg.id);
      this.streams.delete(msg.id);
      if (streams) { streams.finish(blast); } else { blast(); }
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks cast Twin Dragons. */
  get selected() {
    return this.armed;
  }

  /** Its key: select for targeting, or cancel if already selected. */
  toggle() {
    this.armed = !this.armed && this.ready && this.slot !== null;
  }

  /** Right-click, another skill's key, death, leaving the room. */
  cancel() {
    this.armed = false;
  }

  /**
   * Click: casts at the crosshair's ground point, or at max range ahead when
   * aiming past it or at the sky (the server pulls it into range too), then
   * goes back to the main skill.
   */
  press() {
    if (!this.armed || !this.ready) { return; }
    const target = this.scene.groundTarget(TWIN_DRAGONS.range);
    if (!target) { return; }

    this.room.send(CLIENT_MESSAGE.twinDragons, target);
    this.armed = false;
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /** Per frame, after the camera moves. `origin` is where we see ourselves: our predicted position. */
  update(aiming: boolean, origin: GroundPoint) {
    if (!aiming) { this.armed = false; }
    this.preview.show(origin, this.armed ? this.scene.groundTarget(TWIN_DRAGONS.range) : null);
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);

    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(remaining / TWIN_DRAGONS.cooldownMs));
    this.slot.cooldownText.textContent = remaining > 0 ? Math.ceil(remaining / 1000).toString() : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away, no streams on their way.
   * The server dropped them; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.streams.clear();
    this.markers.clear();
    this.armed = false;
  }

  dispose() {
    clearTimeout(this.confirmTimer);
    this.preview.dispose();
    this.streams.clear();
    this.markers.clear();
    this.cooldownEndsAt = 0;
    this.armed = false;
    if (!this.slot) { return; }
    this.slot.root.classList.remove("armed", "cooling");
    this.slot.root.style.setProperty("--cooldown", "0");
    this.slot.cooldownText.textContent = "";
  }
}
