/**
 * Legacy of Goku II (US ALFE) player-state decoder.
 * g_PlayerObject: IWRAM 0x03001FA8 (HIGH).
 * Entity direction: +0x10 (HIGH).
 * SetEntityPositionInstant writes X/Y at +0x158/+0x15C as Q24.8 (MEDIUM).
 * Position is "probable": the setter reveals fields/scale, but the getter
 * body is not yet reconstructed. Read-only; never writes emulator memory.
 */
import { createEntityState } from "../GbaMashupCore.js";

const PLAYER_OBJECT_PTR = 0x03001FA8;
const X_OFFSET = 0x158;
const Y_OFFSET = 0x15C;
const DIRECTION_OFFSET = 0x10;
const EWRAM_START = 0x02000000;
const EWRAM_END = 0x02040000;

export async function decodeLegacyOfGoku2Player({ readMemory, frame }) {
  const pointerView = await readMemory(PLAYER_OBJECT_PTR, 4);
  const entityAddress = pointerView.getUint32(0, true);

  if (entityAddress === 0) {
    return Object.freeze({ game: "legacy-of-goku-2", frame, kind: "player",
      available: false, reason: "g_PlayerObject nulo; personagem ainda não criado" });
  }
  if ((entityAddress & 3) !== 0 || entityAddress < EWRAM_START ||
      entityAddress + Y_OFFSET + 4 > EWRAM_END) {
    return Object.freeze({ game: "legacy-of-goku-2", frame, kind: "player",
      available: false, reason: "Ponteiro de g_PlayerObject fora da EWRAM esperada",
      entityAddress });
  }

  const [position, direction] = await Promise.all([
    readMemory(entityAddress + X_OFFSET, 8),
    readMemory(entityAddress + DIRECTION_OFFSET, 1)
  ]);

  return createEntityState({
    entityId: "legacy-of-goku-2:goku",
    kind: "player",
    position: {
      x: position.getInt32(0, true) / 256,
      y: position.getInt32(4, true) / 256
    },
    facing: direction.getUint8(0),
    frame,
    confidence: "probable",
    coordinateSpace: "legacy-of-goku-ii-world-q24.8"
  });
}
