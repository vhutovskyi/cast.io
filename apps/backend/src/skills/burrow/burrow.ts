import type { Client } from "colyseus";
import { PLAYER_HEIGHT } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { isUntargetable } from "../../effects/effectConfig.js";
import type { ServerSkill, SkillRoom } from "../skillRoom.js";
import { INPUT_COOLDOWN_SLACK_MS } from "../../shared/actions.js";
import type { Player } from "../../rooms/schema/MyRoomState.js";
import { BURROW, BURROW_DIG_STEPS, BURROW_UNDER_STEPS, startBurrowErupt, type BurrowCast, type BurrowSurface } from "./burrowConfig.js";

/**
 * Past a phase's steps, how long the room waits for a caster's steps before
 * ending it by the clock, in ms: only for one whose inputs stopped arriving.
 */
export const STALLED_PHASE_MS = 1000;

/** One caster's Burrow, from digging in to coming out. */
interface Dig {
  source: DamageSource;
  /** Digging in (`burrowing`, rooted), then under the ground (`burrowed`). */
  under: boolean;
  /** The caster's movement steps left in the current phase: it ends right after the last. */
  stepsLeft: number;
  /** Room-clock time (ms) the current phase ends anyway, if their steps stopped coming. */
  until: number;
}

/**
 * Server side of Burrow: cast validation, cooldowns, the swap from digging in
 * to travelling under the ground, and coming out — with a burst on a click,
 * quietly when the time runs out. Moving under the ground is the shared
 * movement step's, from the two effects' limits (fast, under walls), and the
 * phases run on the caster's own steps, so the caster's client predicts it
 * all; this only puts the effects on and takes them off.
 */
export class BurrowSkill implements ServerSkill {
  /** Per caster: room-clock time (ms) when Burrow is ready again. */
  private readyAt = new Map<string, number>();
  /** Per caster digging in or under the ground right now. */
  private digs = new Map<string, Dig>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Starts digging in where the caster stands, if they may. Only from the
   * ground: mid-jump or up in the air there is nothing to dig into. Early,
   * airborne and repeated casts are dropped silently; there is no payload to check.
   */
  cast(client: Client) {
    this.dig(client.sessionId, false);
  }

  /**
   * Burrow pressed in `sessionId`'s input (`INPUT_ACTION.burrow`), before the
   * step it was pressed on — the step their client predicted it on. A press a
   * hair before the cooldown still counts (`INPUT_COOLDOWN_SLACK_MS`).
   */
  castFromInput(sessionId: string) {
    this.dig(sessionId, true);
  }

  private dig(sessionId: string, fromInput: boolean) {
    const caster = this.room.state.players.get(sessionId);
    if (!caster || !this.room.canAct(sessionId) || !hasSkill(caster.element, "burrow")) { return; }
    if (this.digs.has(sessionId)) { return; }
    // On the ground the movement step leaves exactly 0 here; in the air it never is.
    if (caster.vz !== 0 || caster.flightZ > 0) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(sessionId) ?? 0) - (fromInput ? INPUT_COOLDOWN_SLACK_MS : 0)) { return; }
    this.readyAt.set(sessionId, now + BURROW.cooldownMs);

    const source: DamageSource = { id: sessionId, name: caster.name, ability: "burrow" };
    // Into the ground clean: every effect on them goes, and none lands until they surface.
    for (const id of [...caster.effects]) { this.room.removeEffect(sessionId, id); }
    // Their own effect: the room lets it land even though `burrowed` will make them untargetable.
    // Its duration is only a backstop: the dig's steps end it.
    this.room.applyEffect(sessionId, "burrowing", source, BURROW.digMs + STALLED_PHASE_MS);
    this.digs.set(sessionId, { source, under: false, stepsLeft: BURROW_DIG_STEPS, until: now + BURROW.digMs + STALLED_PHASE_MS });
    this.room.broadcast(SERVER_MESSAGE.burrowCast, {
      casterId: sessionId, cooldownMs: BURROW.cooldownMs, x: caster.x, y: caster.y, z: caster.z,
      digMs: BURROW.digMs, underMs: BURROW.underMs,
    } satisfies BurrowCast);
  }

  /**
   * While under the ground: bursts out with a jump, hurting every living
   * enemy within `eruptRadius` once. Not while still digging in — there is
   * nothing to burst out of yet. Early or repeated clicks are dropped silently.
   */
  erupt(client: Client) {
    this.burst(client.sessionId, false);
  }

  /** Bursting out pressed in `sessionId`'s input (`INPUT_ACTION.burrowErupt`), before the step it was pressed on. */
  eruptFromInput(sessionId: string) {
    this.burst(sessionId, true);
  }

  private burst(sessionId: string, fromInput: boolean) {
    const dig = this.digs.get(sessionId);
    const caster = this.room.state.players.get(sessionId);
    if (!dig || !dig.under || !caster || !this.room.canAct(sessionId)) { return; }

    this.digs.delete(sessionId);
    this.room.removeEffect(sessionId, "burrowed");
    // Out of the ground with a jump: the next movement step takes off from
    // the floor at this speed, and the caster's client reconciles to it.
    startBurrowErupt(caster);

    // Enemies where the caster saw them when they clicked; the caster stands where they are now.
    const seen = this.room.seenBy(sessionId, fromInput);
    const hits: string[] = [];
    for (const [id, player] of this.room.state.players) {
      if (id === sessionId || player.hp <= 0 || isUntargetable(player.effects)) { continue; }
      const at = seen(player);
      if (Math.hypot(at.x - caster.x, at.y - caster.y) > BURROW.eruptRadius) { continue; }
      // The burst comes out of the ground here: a body more than its own height above or below is out of it.
      if (Math.abs(at.z - caster.z) >= PLAYER_HEIGHT) { continue; }
      this.room.damage(id, BURROW.eruptDamage, dig.source);
      hits.push(id);
    }

    this.room.broadcast(SERVER_MESSAGE.burrowSurface, {
      casterId: sessionId, x: caster.x, y: caster.y, z: caster.z, erupted: true, hits,
    } satisfies BurrowSurface);
  }

  /** After each of the caster's steps: counts down the phase, and ends it after its last step. */
  afterInput(sessionId: string, player: Player) {
    const dig = this.digs.get(sessionId);
    if (!dig || !this.room.canAct(sessionId)) { return; }
    if (--dig.stepsLeft <= 0) { this.nextPhase(sessionId, dig, player); }
  }

  /**
   * Once per room step: ends the phase of anyone whose steps stopped coming
   * long past it. A caster who died or left just goes: the room already
   * cleared their effects.
   */
  step() {
    const now = this.room.clock.currentTime;
    for (const [casterId, dig] of this.digs) {
      const caster = this.room.state.players.get(casterId);
      if (!caster || !this.room.canAct(casterId)) {
        this.digs.delete(casterId);
        continue;
      }
      if (now >= dig.until) { this.nextPhase(casterId, dig, caster); }
    }
  }

  /**
   * A finished dig becomes travelling under the ground; a finished time
   * under brings them up quietly — hurting no one, so no hit test, and
   * nothing to compensate.
   */
  private nextPhase(casterId: string, dig: Dig, caster: Player) {
    const now = this.room.clock.currentTime;
    if (!dig.under) {
      this.room.removeEffect(casterId, "burrowing");
      this.room.applyEffect(casterId, "burrowed", dig.source, BURROW.underMs + STALLED_PHASE_MS);
      dig.under = true;
      dig.stepsLeft = BURROW_UNDER_STEPS;
      dig.until = now + BURROW.underMs + STALLED_PHASE_MS;
      return;
    }

    this.digs.delete(casterId);
    this.room.removeEffect(casterId, "burrowed");
    this.room.broadcast(SERVER_MESSAGE.burrowSurface, {
      casterId, x: caster.x, y: caster.y, z: caster.z, erupted: false, hits: [],
    } satisfies BurrowSurface);
  }

  /** The player left: their cooldown and their dig go (the effects go with their state). */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
    this.digs.delete(sessionId);
  }

  /** A fresh round: every cooldown and dig goes (the room clears the effects itself). */
  reset() {
    this.readyAt.clear();
    this.digs.clear();
  }
}
