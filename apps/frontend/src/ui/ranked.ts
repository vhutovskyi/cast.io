import { isProvisional } from "@ligma/backend/shared/ranked";

/** "1532", or "1532?" while the rating is still a guess. */
export function formatRating(rating: number, deviation: number): string {
  return `${Math.round(rating)}${isProvisional(deviation) ? "?" : ""}`;
}
