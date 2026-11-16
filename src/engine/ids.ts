const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lowercase RFC 9562 version 4 UUID. Never all zeros (on-chain `ZeroMatchId`). */
export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

/** The 16 bytes of a UUID, as `settle` takes `match_id: [u8; 16]` / `bytes16 matchId`. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new TypeError(`not a lowercase UUID: ${uuid}`);
  }
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
