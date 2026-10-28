import { PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { TORRENT, clampTorrentTarget } from "./torrentConfig.js";
/** Server side of Torrent: cast validation, cooldowns and the eruption. */
export class TorrentSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Torrent is ready again. */
        this.readyAt = new Map();
        this.nextTorrentId = 1;
        /** Torrents still bubbling, by id: their eruption timers. */
        this.pending = new Map();
    }
    /**
     * Validates and schedules a Torrent at the target, pulled into range. The
     * pending torrent lives only in this closure — never in the synced state —
     * so no client but the caster can know it is coming. Invalid or early casts
     * are dropped silently.
     */
    cast(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || !this.room.canAct(client.sessionId) || !hasSkill(caster.element, "torrent")) {
            return;
        }
        const { x, y } = (message ?? {});
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        this.readyAt.set(client.sessionId, now + TORRENT.cooldownMs);
        const id = this.nextTorrentId++;
        const target = clampTorrentTarget(caster, { x, y });
        client.send(SERVER_MESSAGE.torrentCharging, {
            id, ...target, delayMs: TORRENT.delayMs, cooldownMs: TORRENT.cooldownMs,
        });
        const source = { id: client.sessionId, name: caster.name, ability: "torrent" };
        this.pending.set(id, this.room.clock.setTimeout(() => this.erupt(id, source, target), TORRENT.delayMs));
    }
    /** A torrent already bubbling still erupts; only the cooldown goes. */
    remove(sessionId) {
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
    erupt(id, source, target) {
        this.pending.delete(id);
        const reach = TORRENT.radius + PLAYER_HALF;
        const hits = [];
        for (const [sessionId, player] of this.room.state.players) {
            if (sessionId === source.id || player.hp <= 0) {
                continue;
            }
            if (Math.hypot(player.x - target.x, player.y - target.y) > reach) {
                continue;
            }
            this.room.damage(sessionId, TORRENT.damage, source);
            if (player.hp > 0) {
                player.vz = Math.max(player.vz, TORRENT.launchSpeed);
            }
            hits.push(sessionId);
        }
        this.room.broadcast(SERVER_MESSAGE.torrentHit, { id, ...target, hits });
    }
}
