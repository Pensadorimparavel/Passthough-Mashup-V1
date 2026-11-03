/**
 * Buu's Fury candidate-memory probe.
 *
 * These locations changed together in earlier observations, but have NOT
 * been proven to be player coordinates. Keep them as raw experimental
 * telemetry. Do not convert them into an entity position.
 */
export async function decodeBuuFuryCandidates({ readMemory, frame }) {
  const candidates = [
    { id: "A", base: 0x03000DF4, address: 0x03000F94 },
    { id: "B", base: 0x03001844, address: 0x030019E4 },
    { id: "C", base: 0x03002988, address: 0x03002B28 }
  ];

  const values = await Promise.all(candidates.map(async candidate => {
    const view = await readMemory(candidate.address, 8);
    const rawA = view.getInt32(0, true);
    const rawB = view.getInt32(4, true);
    return Object.freeze({
      id: candidate.id,
      base: candidate.base,
      address: candidate.address,
      rawA,
      rawB,
      signalA: rawA / 256,
      signalB: rawB / 256,
      confidence: "experimental"
    });
  }));

  return Object.freeze({
    game: "buu-fury",
    frame,
    kind: "memory-probe",
    coordinateStatus: "unconfirmed",
    candidates: Object.freeze(values)
  });
}
