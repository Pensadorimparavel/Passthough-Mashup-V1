import {
  createEntityState, createMashupMessage, validateMashupMessage,
  MgbaWorkerAdapter, GbaMashupRuntime
} from "../src/mashup/GbaMashupCore.js";
import { decodeMinishCapPlayer } from "../src/mashup/adapters/MinishCapDecoder.js";
import { decodeBuuFuryCandidates } from "../src/mashup/adapters/BuuFuryProbeDecoder.js";

const $ = selector => document.querySelector(selector);
const output = $("#output");
const status = $("#status");

function assert(condition, message) {
  if (!condition) throw new Error("FALHOU: " + message);
}

function mockWorker(game) {
  let frame = 0;
  return {
    async request(type, payload = {}) {
      if (type === "runFrame") return { frameCounter: ++frame };
      if (type === "framebuffer") return { pixels: new ArrayBuffer(240 * 160 * 4) };
      if (type === "setKeys") return { keys: payload.keys };
      if (type === "readMemoryRange") {
        const bytes = new ArrayBuffer(payload.length);
        const view = new DataView(bytes);
        if (game === "minish-cap" && payload.address === 0x0300118C) {
          view.setInt32(0, 12 * 65536, true);
          view.setInt32(4, -4 * 65536, true);
        }
        if (game === "minish-cap" && payload.address === 0x03001174) {
          view.setUint8(0, 7);
          view.setUint8(1, 2);
        }
        if (game === "buu-fury") {
          view.setInt32(0, 0x123400, true);
          view.setInt32(4, 0x20, true);
        }
        return { bytes, length: payload.length };
      }
      throw new Error("Comando mock desconhecido: " + type);
    },
    terminate() {}
  };
}

async function runTests() {
  const lines = [];
  const pass = name => lines.push("PASS  " + name);

  const entity = createEntityState({
    entityId: "test:player", position: { x: 1, y: 2 },
    coordinateSpace: "test-world", confidence: "verified"
  });
  assert(entity.position.x === 1 && entity.position.y === 2, "estado canônico de entidade");
  pass("Estado canônico de entidade");

  let rejected = false;
  try {
    createEntityState({ entityId: "bad", position: { x: NaN, y: 0 }, coordinateSpace: "test" });
  } catch { rejected = true; }
  assert(rejected, "rejeita coordenadas não numéricas");
  pass("Validação de coordenadas");

  const msg = createMashupMessage({
    source: "buu-fury", destination: "minish-cap",
    type: "entity-state", sequence: 0, frame: 1, payload: entity
  });
  assert(validateMashupMessage(msg, "minish-cap").valid, "mensagem válida");
  assert(!validateMashupMessage(msg, "other-game").valid, "destino incorreto rejeitado");
  pass("Protocolo e validação de destino");

  const host = new MgbaWorkerAdapter({
    id: "minish-cap", game: "minish-cap", worker: mockWorker("minish-cap"),
    decodeSnapshot: decodeMinishCapPlayer
  });
  const provider = new MgbaWorkerAdapter({
    id: "buu-fury", game: "buu-fury", worker: mockWorker("buu-fury"),
    decodeSnapshot: decodeBuuFuryCandidates
  });

  let frameData = null;
  const runtime = new GbaMashupRuntime({
    host, provider,
    onHostFrame: data => { frameData = data; }
  });
  const envelope = await runtime.step();
  assert(envelope.type === "entity-state", "runtime encaminha estado do provider");
  assert(frameData?.hostState?.position?.x === 12, "decoder Minish Cap");
  assert(frameData?.providerState?.kind === "memory-probe", "decoder Buu's Fury mantém probe separado");
  assert(frameData.providerState.coordinateStatus === "unconfirmed", "candidatos não promovidos a coordenadas");
  pass("Runtime avança os dois adaptadores e entrega os dois estados");
  pass("Minish Cap publica posição Q16.16 decodificada");
  pass("Buu's Fury mantém candidatos como telemetria experimental");

  let rangeRejected = false;
  try { await provider.readMemory(0x01000000, 4); }
  catch { rangeRejected = true; }
  assert(rangeRejected, "leitura fora das regiões permitidas");
  pass("Limites de leitura EWRAM/IWRAM");

  await runtime.dispose();
  output.textContent = lines.join("\n");
  status.textContent = lines.length + " verificações concluídas.";
}

$("#run").addEventListener("click", () => {
  status.textContent = "Executando…";
  output.textContent = "";
  runTests().catch(error => {
    status.textContent = "Falha no teste.";
    output.textContent += "\n" + (error.stack || error.message);
  });
});
