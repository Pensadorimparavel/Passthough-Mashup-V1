/**
 * Passthough Mashup — GBA integration core
 *
 * Platform-neutral contract for GBA game adapters. This module does not
 * assume that two games share RAM layouts, coordinate systems, or entities.
 * It never writes emulator memory.
 */

export const MASHUP_PROTOCOL = "passthough-gba/1";
export const GBA_MEMORY_RANGES = Object.freeze([
  Object.freeze({ start: 0x02000000, end: 0x02040000, name: "EWRAM" }),
  Object.freeze({ start: 0x03000000, end: 0x03008000, name: "IWRAM" })
]);

const finite = value => typeof value === "number" && Number.isFinite(value);

export function createGameDescriptor({ id, title, adapterId, role = "participant" }) {
  if (!id || !title || !adapterId) throw new TypeError("id, title e adapterId são obrigatórios");
  if (!["host", "provider", "participant"].includes(role)) throw new TypeError("role inválido");
  return Object.freeze({ platform: "gba", id, title, adapterId, role });
}

/**
 * Canonical entity state. Coordinates are game-world units, not screen pixels.
 * A decoder must identify its coordinate system before publishing a position.
 */
export function createEntityState({
  entityId, kind = "unknown", position, velocity = null, facing = null,
  animation = null, frame, confidence = "experimental", coordinateSpace
}) {
  if (!entityId || !position || !finite(position.x) || !finite(position.y)) {
    throw new TypeError("Entidade exige entityId e posição 2D numérica");
  }
  if (!coordinateSpace) throw new TypeError("coordinateSpace é obrigatório");
  if (velocity && (!finite(velocity.x) || !finite(velocity.y))) {
    throw new TypeError("velocity deve conter x/y numéricos");
  }
  if (!["experimental", "probable", "verified"].includes(confidence)) {
    throw new TypeError("confidence inválida");
  }
  return Object.freeze({
    entityId, kind, position: Object.freeze({ x: position.x, y: position.y }),
    velocity: velocity ? Object.freeze({ x: velocity.x, y: velocity.y }) : null,
    facing, animation, frame: Number.isInteger(frame) ? frame : null,
    confidence, coordinateSpace
  });
}

export function createMashupMessage({ source, destination, type, sequence, frame, payload }) {
  if (!source || !destination || source === destination || !type) {
    throw new TypeError("source, destination distintos e type são obrigatórios");
  }
  if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError("sequence inválido");
  return Object.freeze({
    protocol: MASHUP_PROTOCOL, source, destination, type, sequence,
    frame: Number.isInteger(frame) ? frame : null,
    timestamp: Date.now(), payload
  });
}

export function validateMashupMessage(message, expectedDestination = null) {
  if (!message || message.protocol !== MASHUP_PROTOCOL) return { valid: false, reason: "protocol" };
  if (!message.source || !message.destination || message.source === message.destination) {
    return { valid: false, reason: "routing" };
  }
  if (expectedDestination && message.destination !== expectedDestination) {
    return { valid: false, reason: "destination" };
  }
  if (!message.type || !Number.isInteger(message.sequence)) return { valid: false, reason: "header" };
  return { valid: true, reason: null };
}

/**
 * Adapter for the existing mGBA Worker request interface.
 * A game-specific decoder is injected; no RAM address is assumed here.
 */
export class MgbaWorkerAdapter {
  constructor({ id, game, worker, decodeSnapshot }) {
    if (!id || !game || !worker || typeof worker.request !== "function") {
      throw new TypeError("Adapter requer id, game e worker.request");
    }
    if (typeof decodeSnapshot !== "function") {
      throw new TypeError("decodeSnapshot específico do jogo é obrigatório");
    }
    this.id = id;
    this.game = game;
    this.worker = worker;
    this.decodeSnapshot = decodeSnapshot;
    this.frame = 0;
  }

  async stepFrame() {
    const result = await this.worker.request("runFrame");
    this.frame = Number.isInteger(result?.frameCounter) ? result.frameCounter : this.frame + 1;
    return this.frame;
  }

  async framebuffer() {
    return this.worker.request("framebuffer");
  }

  async setKeys(mask) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 0x3ff) {
      throw new RangeError("Máscara de botões GBA inválida");
    }
    return this.worker.request("setKeys", { keys: mask });
  }

  async readMemory(address, length) {
    if (!Number.isInteger(address) || !Number.isInteger(length) || length < 1 || length > 0x40000) {
      throw new RangeError("Intervalo de leitura inválido");
    }
    const end = address + length;
    const allowed = GBA_MEMORY_RANGES.some(range => address >= range.start && end <= range.end);
    if (!allowed) throw new RangeError("Leitura fora das regiões EWRAM/IWRAM permitidas");
    const result = await this.worker.request("readMemoryRange", { address, length });
    if (!(result?.bytes instanceof ArrayBuffer) || result.bytes.byteLength !== length) {
      throw new Error("Resposta de memória inválida");
    }
    return new DataView(result.bytes);
  }

  async readState() {
    return this.decodeSnapshot({
      frame: this.frame,
      readMemory: (address, length) => this.readMemory(address, length)
    });
  }

  async dispose() {
    if (typeof this.worker.terminate === "function") this.worker.terminate();
  }
}

/**
 * Coordinates the two independent GBA adapters. Rendering and game-specific
 * interpretation remain injected so the core does not fake unknown gameplay.
 */
export class GbaMashupRuntime {
  constructor({ host, provider, onProviderState = () => {}, onHostFrame = () => {} }) {
    if (!host || !provider || host === provider) throw new TypeError("host e provider distintos são obrigatórios");
    this.host = host;
    this.provider = provider;
    this.onProviderState = onProviderState;
    this.onHostFrame = onHostFrame;
    this.sequence = 0;
    this.running = false;
  }

  async step() {
    if (this.running) throw new Error("step já está em execução");
    this.running = true;
    try {
      const [hostFrame, providerFrame] = await Promise.all([
        this.host.stepFrame(), this.provider.stepFrame()
      ]);
      const [hostFramebuffer, providerFramebuffer, hostState, providerState] = await Promise.all([
        this.host.framebuffer(), this.provider.framebuffer(),
        this.host.readState(), this.provider.readState()
      ]);
      const message = createMashupMessage({
        source: this.provider.id,
        destination: this.host.id,
        type: "entity-state",
        sequence: this.sequence++,
        frame: providerFrame,
        payload: providerState ?? null
      });
      const validation = validateMashupMessage(message, this.host.id);
      if (!validation.valid) throw new Error("Mensagem de mashup inválida: " + validation.reason);
      this.onProviderState(message);
      this.onHostFrame({
        hostFrame, providerFrame, hostFramebuffer, providerFramebuffer,
        hostState, providerState, message
      });
      return message;
    } finally {
      this.running = false;
    }
  }

  async dispose() {
    await Promise.all([this.host.dispose(), this.provider.dispose()]);
  }
}
