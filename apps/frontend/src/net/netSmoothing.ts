import { Callbacks } from "@colyseus/sdk";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import { TICK_RATE } from "@ligma/backend/shared/constants";
import type { ArenaRoom } from "../net/arenaRoom";

/** Bounds of the interpolation delay, in ms. */
const MIN_DELAY_MS = 80;
const MAX_DELAY_MS = 250;
/** Before there is anything to measure: the SDK's own lerp default. */
const START_DELAY_MS = 100;
/** Patches the arrival statistics look back over: ~3 s at 30 Hz. */
const WINDOW = 90;
/** Patches needed before the measurement replaces the starting delay. */
const MIN_SAMPLES = 15;
/**
 * How fast the delay may move toward its target, in ms per ms. Rising, remote
 * players play at half speed until the buffer has grown; falling, at 5% over
 * speed — so a change is never a jump, and a calm spell doesn't undo a spike.
 */
const RISE_PER_MS = 0.5;
const FALL_PER_MS = 0.05;
/** Output spring on the interpolated position: keeps uneven server motion smooth. */
const SMOOTH_MS = 65;
/** Snapshots kept per player — far more than the longest delay needs. */
const MAX_SAMPLES = 64;

interface Sample { t: number; x: number; y: number; z: number; }

/** One remote player's snapshots and what was last drawn for them. */
interface Track {
  samples: Sample[];
  shown: { x: number; y: number; z: number };
  /** The interpolated (pre-spring) position of the previous frame. */
  raw: { x: number; y: number; z: number };
  shownAt: number;
  detach: () => void;
}

/**
 * Remote players, drawn a little in the past — interpolated between the
 * server's snapshots — with a delay that follows the connection.
 *
 * Snapshots are stamped with the server's own send time (the room clock's
 * `lastServerTime()`), so they are evenly spaced however unevenly they arrive;
 * the picture is drawn at `renderNow() − delay − rtt/2`. A patch that arrives
 * later than the delay covers leaves nothing to interpolate toward: the player
 * freezes, then snaps when it lands. The fixed 100 ms default is fine on a LAN
 * and far too short through a jittery tunnel.
 *
 * Delay policy: for every patch we measure how late it arrived against the
 * smoothed round trip (`renderNow() − sent − rtt/2`) and keep the last ~3 s.
 * The delay aims at one patch interval + the typical lateness + twice the
 * spread up to the 95th percentile — covering nearly every late patch —
 * clamped to 80–250 ms. It rises quickly and falls slowly toward that target
 * (see `RISE_PER_MS`), so one spike doesn't make it oscillate.
 *
 * Why not the SDK's `predict.attachAll(..., { mode: "lerp", delay })`: in
 * @colyseus/sdk 0.18 an attach group keeps its own frozen profile, and
 * `setDefaults({ delay })` only reaches the default profile, which attach
 * groups never use — so a lerp delay can't change at runtime. This is the same
 * interpolation (server-stamped snapshots, the same output spring), with a
 * delay we own.
 */
export class NetSmoothing {
  private readonly callbacks: ReturnType<typeof Callbacks.get>;
  private readonly tracks = new Map<Player, Track>();
  /** How late recent patches arrived, in ms, oldest first. */
  private readonly lateness: number[] = [];
  private lastSent = 0;
  private target = START_DELAY_MS;
  private now = 0;
  /** The interpolation delay in use, in ms. */
  delay = START_DELAY_MS;

  constructor(private readonly room: ArenaRoom) {
    this.callbacks = Callbacks.get(room);
    room.onStateChange(this.onPatch);
  }

  /**
   * How far behind the server's clock remote players are drawn, in ms, beyond
   * half the round trip: the interpolation delay plus the output spring's
   * trail (a steady mover lags its target by `SMOOTH_MS`). Every input is
   * stamped with it, so the server judges our hits on what we see.
   */
  get shownBehind() {
    return this.delay + SMOOTH_MS;
  }

  /** The server's patch cadence, as it advertised it. */
  private get interval() {
    return this.room.clock.patchInterval?.() || 1000 / TICK_RATE;
  }

  private readonly onPatch = () => {
    const clock = this.room.clock;
    const sent = clock.lastServerTime();
    if (sent <= 0 || sent === this.lastSent) { return; }
    this.lastSent = sent;

    this.lateness.push(clock.renderNow() - sent - clock.smoothedRtt() / 2);
    if (this.lateness.length > WINDOW) { this.lateness.shift(); }
    if (this.lateness.length < MIN_SAMPLES) { return; }

    const sorted = [...this.lateness].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const target = this.interval + p50 + 2 * (p95 - p50);
    this.target = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, target));
  };

  /** Start buffering a remote player's snapshots. */
  add(player: Player) {
    const t = this.room.clock.lastServerTime();
    const at = { x: player.x, y: player.y, z: player.z };
    const track: Track = {
      samples: [{ t, ...at }],
      shown: { ...at },
      raw: { ...at },
      shownAt: 0,
      detach: this.callbacks.onChange(player, () => this.record(track, player)),
    };
    this.tracks.set(player, track);
  }

  remove(player: Player) {
    this.tracks.get(player)?.detach();
    this.tracks.delete(player);
  }

  private record(track: Track, player: Player) {
    const t = this.room.clock.lastServerTime();
    const { samples } = track;
    const last = samples[samples.length - 1];
    const sample = { t, x: player.x, y: player.y, z: player.z };
    if (t <= last.t) {
      samples[samples.length - 1] = sample;
      return;
    }
    // Nothing is sent while a player stands still. Hold them where they stood
    // until one interval before they moved again, or the first step would be
    // stretched across the whole idle gap.
    if (t - last.t > 3 * this.interval) {
      samples.push({ ...last, t: t - this.interval });
    }
    samples.push(sample);
    if (samples.length > MAX_SAMPLES) { samples.shift(); }
  }

  /** Once per frame, before reading positions: moves the delay toward its target. */
  update(now: number) {
    const dt = this.now ? Math.min(now - this.now, 100) : 0;
    this.now = now;
    const gap = this.target - this.delay;
    const step = (gap > 0 ? RISE_PER_MS : FALL_PER_MS) * dt;
    this.delay += Math.max(-step, Math.min(step, gap));
  }

  /** Where to draw a remote player this frame, in simulation units. */
  position(player: Player) {
    const track = this.tracks.get(player);
    if (!track) { return { x: player.x, y: player.y, z: player.z }; }

    const clock = this.room.clock;
    const at = clock.renderNow() - this.delay - clock.smoothedRtt() / 2;
    const raw = interpolate(track.samples, at);

    // First-order hold toward the moving target, as the SDK's lerp `smoothMs`:
    // trails a steady mover by speed × SMOOTH_MS, without per-frame stutter.
    const dt = this.now - track.shownAt;
    if (track.shownAt === 0 || dt > 1000) {
      Object.assign(track.shown, raw);
    } else if (dt > 0) {
      const k = dt / SMOOTH_MS;
      const decay = Math.exp(-k);
      for (const axis of ["x", "y", "z"] as const) {
        const trail = (raw[axis] - track.raw[axis]) / k;
        track.shown[axis] = raw[axis] - trail + (track.shown[axis] - track.raw[axis] + trail) * decay;
      }
    }
    Object.assign(track.raw, raw);
    track.shownAt = this.now;
    return track.shown;
  }

  dispose() {
    this.room.onStateChange.remove(this.onPatch);
    this.tracks.forEach((track) => track.detach());
    this.tracks.clear();
  }
}

/** The snapshots' position at server time `at`, held at either end. */
function interpolate(samples: Sample[], at: number) {
  let i = samples.length - 1;
  while (i > 0 && samples[i].t > at) { i--; }
  const a = samples[i];
  const b = samples[i + 1];
  if (!b || at <= a.t) { return { x: a.x, y: a.y, z: a.z }; }
  const u = (at - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
}
