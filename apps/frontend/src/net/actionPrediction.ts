import type { InputHandle } from "@colyseus/sdk";
import type { MoveInput } from "@ligma/backend/rooms/schema/MyRoomState";
import { TICK_RATE } from "@ligma/backend/shared/constants";
import { INPUT_ACTION, type InputAction } from "@ligma/backend/shared/actions";
import { SPEED_BOOST, canCast, type EffectId } from "@ligma/backend/effects/effectConfig";
import { startLeap } from "@ligma/backend/skills/leap/leapConfig";
import {
  SKYFALL_SOAR_STEPS, skyfallRisen, startSkyfall, startSkyfallDrop, type GroundPoint, type SkyfallBody,
} from "@ligma/backend/skills/skyfall/skyfallConfig";
import { BURROW_DIG_STEPS, BURROW_UNDER_STEPS, startBurrowErupt } from "@ligma/backend/skills/burrow/burrowConfig";

/** Speed Boost's length in our steps; the room wears it off by its clock, a step or so either way. */
const BOOST_STEPS = Math.round((SPEED_BOOST.durationMs / 1000) * TICK_RATE);

/** What a step reads of an input: the press, and its facing and aim. */
interface PressedInput { act: number; yaw: number; aimX: number; aimY: number; }

/** One of our status effects put on or taken off, from input `seq` on, before the room has said so. */
interface EffectChange { seq: number; add?: EffectId; remove?: EffectId; }

/** A Skyfall we took off with on input `seq`: the drop we chose, and when it leapt. */
interface Flight { seq: number; aim?: GroundPoint; aimSeq?: number; dropSeq?: number; }

/** A leap we started on input `seq`, with its slide (to tell when something else took over). */
interface Leap { seq: number; vx: number; vy: number; }

/**
 * Our own Leap, Skyfall and Burrow, predicted like walking: pressed into the
 * very next input (`MoveInput.act`), applied by the reconciler's step on that
 * same step with the room's own shared functions, and replayed from the
 * room's state like every other input until the room has applied it.
 *
 * What they do to the movement fields (a slide, a flight, a jump out of the
 * ground) is predicted state and replays by itself. What they do through
 * status effects — rooted while digging in, fast under the walls, slow while
 * soaring, Speed Boost after — is kept here as changes keyed by the input
 * that makes them, laid over the synced effects for steps the room hasn't
 * applied yet. Keyed by what causes them, so a replay that predicts the same
 * step again replaces rather than adds.
 *
 * Cooldowns and kits stay the controllers' business: they only press what
 * the room should accept. The room refusing one anyway (a lag spike past a
 * cooldown) is a misprediction like any other: the next state corrects it.
 */
export class ActionPrediction {
  private readonly pressed: { act: InputAction; aim?: GroundPoint }[] = [];
  private readonly changes = new Map<string, EffectChange>();
  private readonly leaps = new Map<number, Leap>();
  private readonly flights = new Map<number, Flight>();
  /** The body as it stood before the step being predicted: to tell the step a slide ended or a fall touched down. */
  private before = { dashTime: 0, z: 0 };

  constructor(private readonly input: InputHandle<MoveInput>) {}

  /** A controller's press: sent with our next input. One a step, in order. */
  press(act: InputAction, aim?: GroundPoint) {
    this.pressed.push({ act, aim });
  }

  /** The action fields of the next input to send: the next press, or none. */
  next(): Pick<MoveInput, "act"> & Partial<Pick<MoveInput, "aimX" | "aimY">> {
    const press = this.pressed.shift();
    if (!press) { return { act: INPUT_ACTION.none }; }
    return press.aim ? { act: press.act, aimX: press.aim.x, aimY: press.aim.y } : { act: press.act };
  }

  /** Our effects on input `tick`: the synced ones, with the changes the room hasn't applied yet laid over them. */
  effectsAt(tick: number, synced: Iterable<EffectId>): EffectId[] {
    const effects = new Set(synced);
    const acked = this.input.lastProcessed;
    const pending = [...this.changes.values()].filter((c) => c.seq > acked && c.seq <= tick).sort((a, b) => a.seq - b.seq);
    for (const change of pending) {
      if (change.remove) { effects.delete(change.remove); }
      if (change.add) { effects.add(change.add); }
    }
    return [...effects];
  }

  /**
   * Before input `tick`'s movement step: starts what it pressed, as the room
   * will before that same step. Returns our effects for the step.
   */
  beforeStep(tick: number, body: SkyfallBody, command: PressedInput, synced: Iterable<EffectId>): EffectId[] {
    let effects = this.effectsAt(tick, synced);
    const mayCast = canCast(effects);

    switch (command.act) {
      case INPUT_ACTION.leap:
        if (mayCast) { this.leaps.set(tick, { seq: tick, ...startLeap(body, Math.fround(command.yaw)) }); }
        break;
      case INPUT_ACTION.skyfall:
        if (mayCast && body.flightZ <= 0 && !effects.includes("soaring")) {
          startSkyfall(body);
          this.flights.set(tick, { seq: tick });
          this.change(`soar:${tick}`, { seq: tick, add: "soaring" });
        }
        break;
      case INPUT_ACTION.skyfallDrop: {
        const flight = this.flightAt(tick);
        if (flight && body.flightZ > 0 && (!flight.aim || flight.aimSeq === tick)) {
          flight.aim = { x: Math.fround(command.aimX), y: Math.fround(command.aimY) };
          flight.aimSeq = tick;
        }
        break;
      }
      case INPUT_ACTION.burrow:
        if (mayCast && body.vz === 0 && body.flightZ <= 0 && !effects.includes("burrowing") && !effects.includes("burrowed")) {
          this.change(`dig:${tick}`, { seq: tick, add: "burrowing" });
          this.change(`under:${tick}`, { seq: tick + BURROW_DIG_STEPS, remove: "burrowing", add: "burrowed" });
          this.change(`surface:${tick}`, { seq: tick + BURROW_DIG_STEPS + BURROW_UNDER_STEPS, remove: "burrowed" });
        }
        break;
      case INPUT_ACTION.burrowErupt:
        if (effects.includes("burrowed")) {
          startBurrowErupt(body);
          this.change(`erupt:${tick}`, { seq: tick, remove: "burrowed" });
        }
        break;
    }

    if (command.act !== INPUT_ACTION.none) { effects = this.effectsAt(tick, synced); }
    this.before = { dashTime: body.dashTime, z: body.z };
    return effects;
  }

  /**
   * After input `tick`'s movement step: what comes of it on the room's side
   * right after — the drop once up there, Speed Boost once a leap ends or a
   * drop lands — from the next step on.
   */
  afterStep(tick: number, body: SkyfallBody) {
    const flight = this.flightAt(tick);
    // Still up in this body (a replay from before the drop does it again; one from after, not).
    if (flight && body.flightZ > 0) {
      const soared = tick - flight.seq + 1;
      if ((flight.aim && skyfallRisen(body)) || soared >= SKYFALL_SOAR_STEPS) {
        startSkyfallDrop(body, flight.aim ?? body);
        flight.dropSeq = tick;
      }
    } else if (flight?.dropSeq !== undefined && flight.dropSeq < tick && body.flightZ <= 0 && this.before.z > 0 && body.z <= 0) {
      // Touched down: the room lands them after this step.
      this.change(`land:${flight.seq}`, { seq: tick + 1, remove: "soaring" });
      this.boost(`land:${flight.seq}`, tick + 1);
    }

    const leap = this.leapAt(tick);
    if (leap && leap.seq <= tick) {
      const takenOver = body.dashVx !== leap.vx || body.dashVy !== leap.vy;
      if (takenOver || (this.before.dashTime > 0 && body.dashTime <= 0)) {
        this.boost(`leap:${leap.seq}`, tick + 1);
        this.leaps.delete(leap.seq);
      }
    }
  }

  /** Forgets what the room has long applied. Once a frame. */
  prune() {
    const acked = this.input.lastProcessed;
    for (const [key, change] of this.changes) { if (change.seq <= acked) { this.changes.delete(key); } }
    // Kept a while past the ack: a replay may still start before them.
    const old = acked - 10 * TICK_RATE;
    for (const seq of this.leaps.keys()) { if (seq < old) { this.leaps.delete(seq); } }
    for (const seq of this.flights.keys()) { if (seq < old) { this.flights.delete(seq); } }
  }

  /** A fresh round, or leaving: nothing pressed or predicted carries over. */
  reset() {
    this.pressed.length = 0;
    this.changes.clear();
    this.leaps.clear();
    this.flights.clear();
  }

  /** Our effects as of our latest predicted step: what a controller should go by when it decides to press. */
  effectsNow(synced: Iterable<EffectId>): EffectId[] {
    return this.effectsAt(this.input.sentCount, synced);
  }

  private change(key: string, change: EffectChange) {
    this.changes.set(key, change);
  }

  private boost(key: string, seq: number) {
    this.change(`boost:${key}`, { seq, add: "speed_boost" });
    this.change(`boost-end:${key}`, { seq: seq + BOOST_STEPS, remove: "speed_boost" });
  }

  /** Our latest Skyfall taken off on or before `tick`. */
  private flightAt(tick: number): Flight | undefined {
    let latest: Flight | undefined;
    for (const flight of this.flights.values()) { if (flight.seq <= tick && (!latest || flight.seq > latest.seq)) { latest = flight; } }
    return latest;
  }

  /** Our latest leap started on or before `tick`. */
  private leapAt(tick: number): Leap | undefined {
    let latest: Leap | undefined;
    for (const leap of this.leaps.values()) { if (leap.seq <= tick && (!latest || leap.seq > latest.seq)) { latest = leap; } }
    return latest;
  }
}
