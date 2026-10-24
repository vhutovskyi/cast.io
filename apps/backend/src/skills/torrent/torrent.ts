import type { Client, Delayed } from "colyseus";
import { PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import type { ServerSkill, SkillRoom } from "../skillRoom.js";
import { TORRENT, clampTorrentTarget, type GroundPoint, type TorrentCast, type TorrentCharging, type TorrentHit } from "./torrentConfig.js";

/** Server side of Torrent: cast validation, cooldowns and the eruption. */
export class TorrentSkill implements ServerSkill {
  /** Per caster: room-clock time (ms) when Torrent is ready again. */
  private readyAt = new Map<string, number>();
  private nextTorrentId = 1;
  /** Torrents still bubbling, by id: their eruption timers. */
  private pending = new Map<number, Delayed>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates and schedules a Torrent at the target, pulled into range. The
   * pending torrent lives only in this closure — never in the synced state —
   * so no client but the caster can know it is coming. Invalid or early casts
   * are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "torrent")) { return; }

    const { x, y } = (message ?? {}) as Partial<TorrentCast>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
    this.readyAt.set(client.sessionId, now + TORRENT.cooldownMs);

    const id = this.nextTorrentId++;
    const target = clampTorrentTarget(caster, { x, y });

    client.send(SERVER_MESSAGE.torrentCharging, {
      id, ...target, delayMs: TORRENT.delayMs, cooldownMs: TORRENT.cooldownMs,
    } satisfies TorrentCharging);

    const source: DamageSource = { id: client.sessionId, name: caster.name, ability: "torrent" };
    this.pending.set(id, this.room.clock.setTimeout(() => this.erupt(id, source, target), TORRENT.delayMs));
  }

  /** A torrent already bubbling still erupts; only the cooldown goes. */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
  }

  /** A fresh round: every cooldown goes, and torrents still bubbling never erupt. */
  reset() {
    this.readyAt.clear();
    this.pending.forEach((eruption) => eruption.clear());
    this.pending.clear();
  }

  /**
   * Damages every living player but the caster whose body overlaps the
   * torrent — the slow comes with the hit — hurls the survivors upward
   * (already rising faster? they keep that), then tells all clients.
   */
  private erupt(id: number, source: DamageSource, target: GroundPoint) {
    this.pending.delete(id);
    const reach = TORRENT.radius + PLAYER_HALF;
    const hits: string[] = [];

    for (const [sessionId, player] of this.room.state.players) {
      if (sessionId === source.id || player.hp <= 0) { continue; }
      if (Math.hypot(player.x - target.x, player.y - target.y) > reach) { continue; }
      this.room.damage(sessionId, TORRENT.damage, source);
      if (player.hp > 0) { player.vz = Math.max(player.vz, TORRENT.launchSpeed); }
      hits.push(sessionId);
    }

    this.room.broadcast(SERVER_MESSAGE.torrentHit, { id, ...target, hits } satisfies TorrentHit);
  }
}
