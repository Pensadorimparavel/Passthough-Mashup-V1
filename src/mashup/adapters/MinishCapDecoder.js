/**
 * The Minish Cap player decoder.
 *
 * The Entity coordinates are Q16.16 at +0x2C/+0x30. The known player
 * entity base is 0x03001160, so the full words begin at 0x0300118C/0x03001190.
 * This decoder publishes game-world units, not screen pixels.
 */
import { createEntityState } from "../GbaMashupCore.js";

export async function decodeMinishCapPlayer({ readMemory, frame }) {
  const position = await readMemory(0x0300118C, 8);
  const state = await readMemory(0x03001174, 2);

  const x = position.getInt32(0, true) / 65536;
  const y = position.getInt32(4, true) / 65536;

  return createEntityState({
    entityId: "minish-cap:link",
    kind: "player",
    position: { x, y },
    facing: state.getUint8(1),
    animation: state.getUint8(0),
    frame,
    confidence: "verified",
    coordinateSpace: "minish-cap-world-q16.16"
  });
}
