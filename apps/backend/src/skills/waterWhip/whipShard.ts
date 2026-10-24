import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { obstacleAt } from "../../shared/obstacles.js";
import { isUntargetable, type EffectId } from "../../effects/effectConfig.js";
import type { Player } from "../../rooms/schema/MyRoomState.js";
import { seenPlayers, type SkillRoom } from "../skillRoom.js";
import { WATER_WHIP, WHIP_COMBO } from "./waterWhipConfig.js";
import {
  WHIP_SHARD, whipShardPosition, whipShardStepFrom, whipShardStruck, whipShardSurfaceHit,
  type WhipShardCast, type WhipShardHit, type WhipShardLaunch, type WhipShardPoint,
} from "./whipShardConfig.js";

/** What the shard puts on whoever it strikes: the combo's last hit's slow. */
const SHARD_EFFECT = WHIP_COMBO[2].effect;

/**
 * Everyone a hit may land on: the untargetable (under the ground) are out of
 * reach — a lash passes them by, a shard flies over them.
 */
export function* whipTargets(players: Iterable<[string, Player]>): Iterable<[string, Player]> {
  for (const entry of players) {
    if (!isUntargetable(entry[1].effects)) { yield entry; }
  }
}

/**
 * One hit of the whip landing on `targetId`: the damage, then — only if they
 * are still standing — the hit's slow. A killing blow slows no one.
 */
export function whipHit(room: SkillRoom, targetId: string, damage: number, effect: EffectId, source: DamageSource) {
  room.damage(targetId, damage, source);
  const target = room.state.players.get(targetId);
  if (target && target.hp > 0) { room.applyEffect(targetId, effect, source); }
}

/**
 * A shard in flight. Server-only: clients fly their own copy from the
 * `whipShardCast` launch, so nothing here is synced — its position is always
 * `whipShardPosition(launch, ageMs)`.
 */
interface Flight {
  id: number;
  launch: WhipShardLaunch;
  /** Id of the thrower in `state.players`: never struck by their own shard. */
  ownerId: string;
  /** Never struck either: whoever the thrower spares. */
  ignore: ReadonlySet<string> | undefined;
  /** What it deals on a strike. */
  damage: number;
  /** How far behind the thrower saw everyone (ms): it strikes whoever it would have on their screen. */
  lag: number;
  ageMs: number;
  source: DamageSource;
}

/** Water Whip's shards in the air: their flight, the strike and its slow. */
export class WhipShards {
  private nextShardId = 1;
  /** Every shard in the air, by id. */
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Throws a shard from `launch` and tells everyone; it flies from the next
   * `step`. `lagMs` is the thrower's `lagOf` (0: where everyone is now).
   */
  throw(
    ownerId: string, launch: WhipShardLaunch, source: DamageSource, ignore?: ReadonlySet<string>,
    damage: number = WATER_WHIP.damage, lagMs = 0,
  ) {
    const id = this.nextShardId++;
    this.flights.set(id, { id, launch, ownerId, ignore, damage, lag: lagMs, ageMs: 0, source });
    this.room.broadcast(SERVER_MESSAGE.whipShardCast, { id, casterId: ownerId, ...launch } satisfies WhipShardCast);
  }

  /** A fresh round: shards in the air vanish. */
  reset() {
    this.flights.clear();
  }

  /**
   * Flies every shard one tick along its path, in sub-steps short enough
   * that one can't skip through a player between ticks. It shatters on the
   * first thing it touches — a living player it may strike, a raised wall,
   * an arena wall or the floor — or quietly melts at the end of its lifetime.
   */
  step(dt: number) {
    const finished: number[] = [];

    for (const [id, flight] of this.flights) {
      const from = flight.ageMs / 1000;
      const substeps = Math.ceil(dt / whipShardStepFrom(from, dt));
      let shattered = false;
      for (let i = 1; i <= substeps && !shattered; i++) {
        shattered = this.shatter(flight, whipShardPosition(flight.launch, from + (dt * i) / substeps));
      }
      flight.ageMs += dt * 1000;
      if (shattered || flight.ageMs >= WHIP_SHARD.lifetimeMs) { finished.push(id); }
    }

    for (const id of finished) { this.flights.delete(id); }
  }

  /**
   * Shatters the shard here if it touches anything; false if it flies on.
   * A body comes before the surface it stands against: whoever it grazed on
   * the way into a wall still takes it. Bodies stand where the thrower saw
   * them; walls, the floor and who's alive or untargetable are as they are now.
   */
  private shatter(flight: Flight, at: WhipShardPoint): boolean {
    const targets = seenPlayers(whipTargets(this.room.state.players), this.room.seenAgo(flight.lag));
    const hitId = whipShardStruck(flight.ownerId, at, targets, flight.ignore);
    const point = hitId ? at : whipShardSurfaceHit(at) ?? (obstacleAt(at, WHIP_SHARD.radius, this.room.state.walls.values()) ? at : null);
    if (!point) { return false; }

    if (hitId) { whipHit(this.room, hitId, flight.damage, SHARD_EFFECT, flight.source); }

    this.room.broadcast(SERVER_MESSAGE.whipShardHit, { id: flight.id, ...point, ...(hitId && { hitId }) } satisfies WhipShardHit);
    return true;
  }
}
