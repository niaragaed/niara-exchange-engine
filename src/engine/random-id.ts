import { randomUUID } from "node:crypto";

/**
 * Production match id generator: a random UUID v4 from the OS CSPRNG. Kept out of the
 * engine module, which takes its id generator as a parameter to stay deterministic.
 */
export function randomMatchId(): string {
  return randomUUID();
}
