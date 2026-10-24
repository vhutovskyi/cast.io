import * as THREE from "three";
import { STONE_SKIN, type StoneSkinCast, type StoneSkinContact } from "@ligma/backend/skills/stoneSkin/stoneSkinConfig";
import { PLAYER_HALF, PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowSprite, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** The effect this draws, by its server id. */
const STONE_SKIN_EFFECT = "stone_skin";
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Plates of stone clinging to a hardened body: how many, how far out (world units). */
const PLATES = 14;
const SHELL_RADIUS = PLAYER_HALF * WORLD_SCALE * 1.15;
const SHELL_HEIGHT = PLAYER_HEIGHT * WORLD_SCALE;
/** They slam on over this, and crumble off over the next, in seconds. */
const HARDEN_S = 0.15;
const CRUMBLE_S = 0.35;
/** Our own view: stone creeping in at the corners, this far ahead of the eyes (camera space). */
const VIEW_DISTANCE = 0.3;
const VIEW_ROCKS = 10;

const STONE_COLORS = [0x8a6d4b, 0x7a6450, 0x6b5a48, 0x9a8468];
/** Someone touched a hardened body: stone shards spiking out at them, and how long they last (s). */
const SHARDS = 8;
const SHARD_S = 0.45;

/** A rough rock: a low-poly ball with its corners pushed in and out a little. */
function rockGeometry(radius: number) {
  const geometry = new THREE.DodecahedronGeometry(radius, 0);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const k = 0.75 + Math.random() * 0.45;
    positions.setXYZ(i, positions.getX(i) * k, positions.getY(i) * k * 0.7, positions.getZ(i) * k);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function stoneMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, flatShading: true, transparent: true, opacity: 1 });
}

/**
 * Where an enemy was hurt touching a stone skin, for everyone: stone shards
 * spiking out of the floor at them and crumbling, and a puff of dust.
 */
class ContactEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly dust = glowSprite(0xb59b7c, 0.6);
  private readonly shards = Array.from({ length: SHARDS }, (_, i) => {
    const height = 0.5 + Math.random() * 0.5;
    const material = stoneMaterial(STONE_COLORS[i % STONE_COLORS.length]);
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.1, height, 4), material);
    mesh.geometry.translate(0, height / 2, 0);
    const angle = (i / SHARDS) * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * 0.35, 0, Math.sin(angle) * 0.35);
    mesh.rotation.set(Math.sin(angle) * 0.6, 0, -Math.cos(angle) * 0.6);
    this.group.add(mesh);
    return { mesh, material };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number) {
    toWorld(x, y, this.group.position);
    this.dust.position.y = 0.4;
    this.group.add(this.dust);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / SHARD_S, 1);
    // Stab up fast, then crumble away.
    const up = Math.min(t / 0.06, 1);
    for (const { mesh, material } of this.shards) {
      mesh.scale.set(1, Math.max(0.01, up * (1 - 0.5 * k)), 1);
      material.opacity = 1 - k * k;
    }
    this.dust.scale.setScalar(0.6 + 1.2 * k);
    this.dust.material.opacity = 0.6 * (1 - k);
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** What this reads off a synced `Player`. */
export interface StoneSkinPlayer {
  hp: number;
  effects: Iterable<string>;
}

function isHardened(player: StoneSkinPlayer) {
  if (player.hp <= 0) { return false; }
  for (const id of player.effects) {
    if (id === STONE_SKIN_EFFECT) { return true; }
  }
  return false;
}

/**
 * Plates of stone over a remote player's body, hung on their avatar so they
 * go wherever it is drawn: they slam on from all around, and crumble off and
 * fall away once the skin wears off.
 */
class Shell {
  readonly group = new THREE.Group();
  private readonly plates = Array.from({ length: PLATES }, (_, i) => {
    const material = stoneMaterial(STONE_COLORS[i % STONE_COLORS.length]);
    const mesh = new THREE.Mesh(rockGeometry(SHELL_RADIUS * (0.32 + Math.random() * 0.15)), material);
    const angle = (i / PLATES) * Math.PI * 2 * 2.3;
    const height = SHELL_HEIGHT * (0.12 + 0.8 * ((i * 0.618) % 1));
    const rest = new THREE.Vector3(Math.cos(angle) * SHELL_RADIUS, height, Math.sin(angle) * SHELL_RADIUS);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.group.add(mesh);
    return { mesh, material, rest, out: rest.clone().multiplyScalar(2.2), fall: 0 };
  });
  /** 0 → 1 while hardening, 1 → 0 while crumbling. */
  private amount = 0;
  hardened = false;

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  /** False once it has crumbled away entirely. */
  update(dt: number) {
    this.amount = this.hardened ? Math.min(1, this.amount + dt / HARDEN_S) : Math.max(0, this.amount - dt / CRUMBLE_S);
    const crumbling = !this.hardened;
    for (const plate of this.plates) {
      if (crumbling) {
        // Off they fall: down and out, fading.
        plate.fall += dt;
        plate.mesh.position.copy(plate.rest).addScaledVector(plate.rest, 0.4 * plate.fall);
        plate.mesh.position.y = Math.max(0, plate.rest.y - 9 * plate.fall * plate.fall);
      } else {
        plate.fall = 0;
        // Slammed on from further out.
        plate.mesh.position.lerpVectors(plate.out, plate.rest, 1 - (1 - this.amount) ** 3);
      }
      plate.material.opacity = crumbling ? this.amount : Math.min(1, this.amount * 2);
    }
    this.group.visible = this.amount > 0;
    return this.hardened || this.amount > 0;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Stone Skin: its slot's key hardens you at once — no aiming,
 * no click — then the cooldown display. Also draws everyone's stone skin from
 * the synced `stone_skin` effect: plates of stone on hardened avatars, stone
 * creeping in at the corners of our own view while we are, and shards
 * spiking out at whoever touches one. The server
 * decides everything that matters (cooldown, the effect). `slot` is null when
 * Stone Skin isn't in our kit: then only others' skins are drawn.
 */
export class StoneSkinController implements SlotSkill {
  private readonly shells = new Map<string, Shell>();
  private readonly view = new THREE.Group();
  private readonly viewRocks: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; corner: THREE.Vector3 }[] = [];
  private viewAmount = 0;
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    // Rocks at the edges of our view, just inside the screen's corners and sides.
    for (let i = 0; i < VIEW_ROCKS; i++) {
      const angle = (i / VIEW_ROCKS) * Math.PI * 2 + 0.3;
      const corner = new THREE.Vector3(Math.cos(angle) * 0.36, Math.sin(angle) * 0.22, -VIEW_DISTANCE);
      const material = stoneMaterial(STONE_COLORS[i % STONE_COLORS.length]);
      const mesh = new THREE.Mesh(rockGeometry(0.05 + Math.random() * 0.03), material);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.view.add(mesh);
      this.viewRocks.push({ mesh, material, corner });
    }
    this.view.visible = false;
    scene.camera.add(this.view);

    room.onMessage(SERVER_MESSAGE.stoneSkinCast, (msg: StoneSkinCast) => {
      if (msg.casterId !== room.sessionId) { return; }
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
    });

    // Drawn where the victim is now, as we see them.
    room.onMessage(SERVER_MESSAGE.stoneSkinContact, (msg: StoneSkinContact) => {
      const victim = room.state.players.get(msg.victimId);
      if (victim) { this.effects.add(new ContactEffect(scene.scene, victim.x, victim.y)); }
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: it has nothing to aim. */
  get selected() {
    return false;
  }

  /** Its key: harden right away, if it's ready. */
  toggle() {
    if (!this.slot || !this.ready) { return; }
    this.room.send(CLIENT_MESSAGE.stoneSkin);
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  cancel() {}

  press() {}

  release() {}

  /**
   * Per frame, after avatars are placed: shells on everyone hardened, the
   * stone at the edges of our own view, and the slot display. `avatars` are
   * the remote players' (we are the camera).
   */
  update(dt: number, players: Iterable<[string, StoneSkinPlayer]>, avatars: ReadonlyMap<string, Avatar>) {
    for (const [sessionId, player] of players) {
      if (sessionId === this.room.sessionId) {
        this.viewAmount = isHardened(player) ? Math.min(1, this.viewAmount + dt / HARDEN_S) : Math.max(0, this.viewAmount - dt / CRUMBLE_S);
        continue;
      }
      const avatar = avatars.get(sessionId);
      let shell = this.shells.get(sessionId);
      if (avatar && !shell && isHardened(player)) {
        shell = new Shell(avatar.group);
        this.shells.set(sessionId, shell);
      }
      if (shell) { shell.hardened = isHardened(player); }
    }
    for (const [sessionId, shell] of this.shells) {
      if (!avatars.has(sessionId) || !shell.update(dt)) {
        shell.dispose();
        this.shells.delete(sessionId);
      }
    }

    this.view.visible = this.viewAmount > 0;
    for (const rock of this.viewRocks) {
      // Creeping in from just outside the view.
      rock.mesh.position.copy(rock.corner).multiplyScalar(1.6 - 0.6 * this.viewAmount).setZ(-VIEW_DISTANCE);
      rock.material.opacity = 0.9 * this.viewAmount;
    }

    this.showSlot();
  }

  private showSlot() {
    if (!this.slot) { return; }
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / STONE_SKIN.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A fresh round (`arenaReset`): ready right away; the server cleared every effect. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
  }

  dispose() {
    this.reset();
    this.shells.forEach((shell) => shell.dispose());
    this.shells.clear();
    disposeGroup(this.view);
    this.showSlot();
  }
}
