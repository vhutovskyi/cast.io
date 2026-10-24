import { wrapAngle } from "@ligma/backend/shared/movement";
import { PITCH_LIMIT } from "@ligma/backend/shared/constants";

/** Radians of turn per pixel of mouse movement. */
const SENSITIVITY = 0.0025;

/**
 * More than this many pixels in one event is a browser glitch, not a hand:
 * under pointer lock some browsers (notably Chrome on Windows) now and then
 * report a single huge jump, which would spin the view at random. A real
 * flick spreads over many events, each far below this.
 */
const MAX_EVENT_MOVEMENT = 400;

/**
 * First-person mouse look via the Pointer Lock API. Yaw is sent to the server
 * with every input (it steers movement); pitch only aims (e.g. the fireball).
 */
export class MouseLook {
  yaw = 0;
  pitch = 0;

  constructor(private readonly target: HTMLElement, onLockChange: (locked: boolean) => void) {
    target.addEventListener("click", () => this.lock());

    document.addEventListener("pointerlockchange", () => onLockChange(this.locked));

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) { return; }
      if (Math.abs(e.movementX) > MAX_EVENT_MOVEMENT || Math.abs(e.movementY) > MAX_EVENT_MOVEMENT) { return; }
      this.yaw = wrapAngle(this.yaw - e.movementX * SENSITIVITY);
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY));
    });
  }

  /** Captures the mouse. Browsers only allow this from a click or key press. */
  lock() {
    if (this.locked) { return; }
    // Raw mouse input where the browser offers it: it doesn't have the stray
    // jumps above. Where it doesn't (or refuses), a plain lock.
    this.target.requestPointerLock({ unadjustedMovement: true })
      ?.catch(() => this.target.requestPointerLock()?.catch(() => {}));
  }

  get locked() {
    return document.pointerLockElement === this.target;
  }
}
