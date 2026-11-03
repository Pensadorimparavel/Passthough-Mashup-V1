/**
 * Passthough Mashup V1 — Fase 0.5
 * Visualização da telemetria recebida pelo Worker B.
 * Somente leitura: nenhuma escrita na RAM dos jogos.
 */
import { Bridge } from "../src/bridge/Bridge.js";
import { createEnvelope } from "../src/bridge/MessageProtocol.js";
import { MemoryReader } from "../src/state/memory/MemoryReader.js";
import { ZeldaStateAdapter } from "../src/state/adapters/ZeldaStateAdapter.js";

const $ = (s) => document.querySelector(s);
const ui = {
  romA: $("#romA"), romB: $("#romB"), load: $("#load"), stop: $("#stop"),
  status: $("#sessionStatus"), screenA: $("#screenA"), screenB: $("#screenB"),
  statusA: $("#statusA"), statusB: $("#statusB"), arm: $("#arm"), disarm: $("#disarm"),
  detect: $("#detectStatus"), position: $("#position"), count: $("#count"),
  lastId: $("#lastId"), received: $("#received"), radar: $("#radar"), log: $("#log")
};
const KEY_MASK = Object.freeze({
  a: 1, b: 2, select: 4, start: 8, right: 16, left: 32,
  up: 64, down: 128, r: 256, l: 512
});
const KEY_CODES = new Map([
  ["ArrowUp", "up"], ["ArrowDown", "down"], ["ArrowLeft", "left"], ["ArrowRight", "right"],
  ["KeyX", "a"], ["KeyZ", "b"], ["KeyA", "l"], ["KeyS", "r"],
  ["Enter", "start"], ["ShiftRight", "select"]
]);
const canvases = [ui.screenA, ui.screenB];
const contexts = canvases.map(c => c.getContext("2d", { alpha: false }));
const frames = contexts.map(c => c.createImageData(240, 160));
let workers = [];
let bridge = null;
let readerA = null;
let readerB = null;
let adapterA = null;
let running = false;
let raf = 0;
let busyFrame = false;
let pressed = new Set();
let keyMask = 0;
let armed = false;
let baseline = null;
let radarOrigin = null;
let reading = false;
let lastRead = 0;
let sending = false;
let eventCount = 0;
let history = [];

function log(message, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function makeWorker(label) {
  const raw = new Worker(new URL("../src/workers/emulator.worker.js", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map();
  let ended = false;
  raw.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "bridgeOut" || msg.type === "bridgeResponse") return;
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.ok) item.resolve(msg);
    else item.reject(new Error(msg.error || ("Erro no Worker " + label)));
  });
  raw.addEventListener("error", (event) => {
    const error = new Error(event.message || ("Falha no Worker " + label));
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    log(error.message, "error");
  });
  return {
    raw,
    request(type, payload, transfer) {
      if (ended) return Promise.reject(new Error("Worker " + label + " encerrado."));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timeout no Worker " + label + ": " + type));
        }, 12000);
        pending.set(id, { resolve, reject, timer });
        raw.postMessage(Object.assign({ id, type }, payload || {}), transfer || []);
      });
    },
    terminate() {
      if (ended) return;
      ended = true;
      raw.terminate();
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Worker " + label + " encerrado."));
      }
      pending.clear();
    }
  };
}
function renderFrame(index, frame) {
  if (!(frame.pixels instanceof ArrayBuffer) || frame.width !== 240 || frame.height !== 160) {
    throw new Error("Framebuffer inválido no Worker " + (index ? "B" : "A") + ".");
  }
  const source = new Uint8Array(frame.pixels);
  const target = frames[index].data;
  if (source.length < target.length) throw new Error("Framebuffer menor que 240×160.");
  for (let s = 0, d = 0; d < target.length; s += 4, d += 4) {
    target[d] = source[s];
    target[d + 1] = source[s + 1];
    target[d + 2] = source[s + 2];
    target[d + 3] = 255;
  }
  contexts[index].putImageData(frames[index], 0, 0);
}
function setKey(key, down) {
  if (!workers[0] || !KEY_MASK[key]) return;
  if (down) pressed.add(key); else pressed.delete(key);
  let next = 0;
  for (const k of pressed) next |= KEY_MASK[k];
  if (next === keyMask) return;
  keyMask = next;
  workers[0].request("setKeys", { keys: keyMask }).catch(e => log(e.message, "error"));
}
function releaseKeys() {
  pressed.clear();
  keyMask = 0;
  if (workers[0]) workers[0].request("setKeys", { keys: 0 }).catch(() => {});
}
function attachControls() {
  document.querySelectorAll("[data-key]").forEach(button => {
    const key = button.dataset.key;
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      setKey(key, true);
    });
    const release = event => { event.preventDefault(); setKey(key, false); };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", () => setKey(key, false));
    button.addEventListener("contextmenu", event => event.preventDefault());
  });
  window.addEventListener("keydown", event => {
    const key = KEY_CODES.get(event.code);
    if (!key) return;
    event.preventDefault();
    if (!event.repeat) setKey(key, true);
  });
  window.addEventListener("keyup", event => {
    const key = KEY_CODES.get(event.code);
    if (!key) return;
    event.preventDefault();
    setKey(key, false);
  });
  window.addEventListener("blur", releaseKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseKeys(); });
}
function drawRadar() {
  const canvas = ui.radar;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#090f17";
  ctx.fillRect(0, 0, w, h);
  const maxAbs = Math.max(64, ...history.map(p => Math.max(Math.abs(p.dx), Math.abs(p.dy))));
  const range = Math.ceil(maxAbs / 64) * 64;
  ctx.strokeStyle = "#263748";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const r = i * 25;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(18, cy); ctx.lineTo(w - 18, cy);
  ctx.moveTo(cx, 12); ctx.lineTo(cx, h - 12); ctx.stroke();
  ctx.fillStyle = "#9fb0c2";
  ctx.font = "12px system-ui";
  ctx.fillText("ΔX", w - 35, cy - 8);
  ctx.fillText("ΔY", cx + 8, 18);
  if (history.length) {
    ctx.strokeStyle = "#5da7e8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = cx + (p.dx / range) * (Math.min(w, h) * 0.42);
      const y = cy - (p.dy / range) * (Math.min(w, h) * 0.42);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const last = history[history.length - 1];
    const px = cx + (last.dx / range) * (Math.min(w, h) * 0.42);
    const py = cy - (last.dy / range) * (Math.min(w, h) * 0.42);
    ctx.fillStyle = "#78e0a5";
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e8edf2";
    ctx.fillText("Link recebido por B", 12, h - 12);
  } else {
    ctx.fillStyle = "#9fb0c2";
    ctx.fillText("Aguardando primeiro ACK de B", 12, h - 12);
  }
  ui.received.textContent = history.length ? "Recebido e confirmado" : "Aguardando";
}
async function readLink() {
  if (!adapterA || reading) return null;
  reading = true;
  try {
    const state = await adapterA.readState();
    if (!Number.isFinite(state.position?.x) || !Number.isFinite(state.position?.y)) {
      throw new Error("Zelda Adapter não retornou X/Y finitos.");
    }
    return state;
  } finally {
    reading = false;
  }
}
async function poll() {
  if (!armed || !running || Date.now() - lastRead < 450 || sending) return;
  lastRead = Date.now();
  try {
    const state = await readLink();
    if (!state) return;
    const current = { x: state.position.x, y: state.position.y };
    if (!baseline) { baseline = current; return; }
    const dx = current.x - baseline.x;
    const dy = current.y - baseline.y;
    if (dx === 0 && dy === 0) return;
    sending = true;
    const envelope = createEnvelope({
      origin: "A", destination: "B", type: "link_position_changed",
      payload: { x: current.x, y: current.y, deltaX: dx, deltaY: dy, source: "ZeldaStateAdapter" }
    });
    try {
      const responsePromise = bridge.expectResponse(envelope.messageId, 8000);
      await workers[0].request("bridgeEmit", { envelope });
      const response = await responsePromise;
      const p = response.payload;
      if (response.type !== "ack" || !p || p.received !== true ||
          p.originalType !== "link_position_changed" ||
          !Number.isFinite(p.position?.x) || !Number.isFinite(p.position?.y)) {
        throw new Error("ACK de B inválido: " + JSON.stringify(p));
      }
      eventCount += 1;
      ui.position.textContent = "X " + p.position.x + " · Y " + p.position.y;
      const offset = { dx: p.position.x - radarOrigin.x, dy: p.position.y - radarOrigin.y };
      history.push({ dx: offset.dx, dy: offset.dy, x: p.position.x, y: p.position.y });
      if (history.length > 120) history.shift();
      drawRadar();
      ui.count.textContent = String(eventCount);
      ui.lastId.textContent = envelope.messageId;
      ui.detect.textContent = "Evento " + eventCount + " confirmado pelo Worker B.";
      log("B confirmou " + envelope.messageId + " · posição (" + p.position.x + ", " + p.position.y +
          ") · delta (" + dx + ", " + dy + ").", "ok");
      baseline = current;
    } finally {
      sending = false;
    }
  } catch (error) {
    ui.detect.textContent = "Falha: " + error.message;
    log("Falha na telemetria A → B: " + error.message, "error");
  }
}
async function animationStep() {
  if (!running || busyFrame || workers.length !== 2) return;
  busyFrame = true;
  try {
    const run = await Promise.all(workers.map(w => w.request("runFrame")));
    const fb = await Promise.all(workers.map(w => w.request("framebuffer")));
    renderFrame(0, fb[0]); renderFrame(1, fb[1]);
    ui.statusA.textContent = "Em execução · frame " + run[0].frameCounter;
    ui.statusB.textContent = "Em execução · frame " + run[1].frameCounter;
  } catch (error) {
    log("Loop interrompido: " + error.message, "error");
    stopLoop();
    ui.status.textContent = "Emulação interrompida.";
  } finally {
    busyFrame = false;
  }
  if (running) raf = requestAnimationFrame(animationStep);
}
function startLoop() {
  if (running) return;
  running = true;
  raf = requestAnimationFrame(animationStep);
}
function stopLoop() {
  running = false;
  cancelAnimationFrame(raf);
  releaseKeys();
}
function stopSession() {
  armed = false; baseline = null; radarOrigin = null; history = [];
  stopLoop();
  if (bridge) { bridge.destroy(); bridge = null; }
  workers.forEach(w => w.terminate());
  workers = []; readerA = null; readerB = null; adapterA = null;
  ui.load.disabled = false; ui.stop.disabled = true; ui.arm.disabled = true; ui.disarm.disabled = true;
  ui.status.textContent = "Sessão encerrada.";
  ui.statusA.textContent = "Aguardando ROM A.";
  ui.statusB.textContent = "Aguardando ROM B.";
  ui.detect.textContent = "Carregue os dois jogos primeiro.";
  ui.count.textContent = "0"; ui.lastId.textContent = "—";
  drawRadar();
}
ui.load.addEventListener("click", async () => {
  const fileA = ui.romA.files?.[0], fileB = ui.romB.files?.[0];
  if (!fileA || !fileB) { ui.status.textContent = "Selecione as duas ROMs."; return; }
  stopSession(); ui.log.textContent = ""; ui.load.disabled = true;
  ui.status.textContent = "Inicializando Workers A e B…";
  try {
    const buffers = await Promise.all([fileA.arrayBuffer(), fileB.arrayBuffer()]);
    if (buffers.some(b => b.byteLength < 0xc0)) throw new Error("ROM GBA inválida ou pequena demais.");
    const a = makeWorker("A"), b = makeWorker("B"); workers = [a, b];
    const ready = await Promise.all([a.request("init"), b.request("init")]);
    log("Dois Dedicated Workers inicializados · WASM A " + ready[0].memoryBytes + " · B " + ready[1].memoryBytes + " bytes.", "ok");
    await Promise.all([
      a.request("loadRom", { rom: buffers[0] }, [buffers[0]]),
      b.request("loadRom", { rom: buffers[1] }, [buffers[1]])
    ]);
    log("ROM A carregada: " + fileA.name + " · ROM B carregada: " + fileB.name + ".", "ok");
    readerA = new MemoryReader(a); readerB = new MemoryReader(b);
    await Promise.all([readerA.enableReadOnlyPolicy(), readerB.enableReadOnlyPolicy()]);
    const policies = await Promise.all([readerA.getWritePolicyState(), readerB.getWritePolicyState()]);
    if (policies.some(p => p.memoryWriteEnabled || !p.memoryWriteLocked)) {
      throw new Error("A trava read-only não foi confirmada nos dois Workers.");
    }
    adapterA = new ZeldaStateAdapter(readerA);
    bridge = new Bridge(a, b, {
      onLog: event => {
        if (event.direction === "in") {
          log("Worker " + event.from + " → Bridge → " + event.to + " · " + event.type + " · " + event.messageId);
        } else if (event.direction === "response") {
          log("Worker " + event.from + " → Bridge · " + event.type + " · resposta a " + event.inReplyTo, "ok");
        }
      },
      onReject: event => log("Bridge rejeitou mensagem: " + event.reason, "error")
    });
    const first = await Promise.all([a.request("runFrame"), b.request("runFrame")]);
    const fb = await Promise.all([a.request("framebuffer"), b.request("framebuffer")]);
    renderFrame(0, fb[0]); renderFrame(1, fb[1]);
    ui.statusA.textContent = "Carregado · frame " + first[0].frameCounter;
    ui.statusB.textContent = "Carregado · frame " + first[1].frameCounter;
    ui.status.textContent = "A e B ativos · Bridge conectada · RAM dos dois em read-only.";
    ui.load.disabled = false; ui.stop.disabled = false; ui.arm.disabled = false;
    log("Bridge conectada. Escrita na RAM bloqueada em A e B.", "ok");
    startLoop();
  } catch (error) {
    log("Falha ao inicializar Fase 0.5: " + error.message, "error");
    ui.status.textContent = "Falha: " + error.message;
    stopSession();
  } finally {
    ui.load.disabled = false;
  }
});
ui.arm.addEventListener("click", async () => {
  try {
    const state = await readLink();
    if (!state) return;
    baseline = { x: state.position.x, y: state.position.y };
    radarOrigin = { x: baseline.x, y: baseline.y };
    history = []; eventCount = 0;
    ui.count.textContent = "0"; ui.lastId.textContent = "—";
    drawRadar();
    armed = true; ui.arm.disabled = true; ui.disarm.disabled = false;
    ui.detect.textContent = "Detecção armada. Mova Link para enviar telemetria.";
    log("Detecção armada · posição-base (" + baseline.x + ", " + baseline.y + ").");
  } catch (error) {
    ui.detect.textContent = error.message;
    log(error.message, "error");
  }
});
ui.disarm.addEventListener("click", () => {
  armed = false; baseline = null;
  ui.arm.disabled = false; ui.disarm.disabled = true;
  ui.detect.textContent = "Detecção desarmada.";
  log("Detecção desarmada pelo usuário.");
});
ui.stop.addEventListener("click", stopSession);
setInterval(() => { void poll(); }, 120);
attachControls();
drawRadar();