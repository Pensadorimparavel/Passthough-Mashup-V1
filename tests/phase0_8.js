import { MemoryReader } from "../src/state/memory/MemoryReader.js";
import { BuuFuryStateAdapter } from "../src/state/adapters/BuuFuryStateAdapter.js";

const $ = s => document.querySelector(s);
const ui = {
  rom: $("#romB"), load: $("#load"), stop: $("#stop"), status: $("#status"),
  screen: $("#screen"), character: $("#character"), hp: $("#hp"), policy: $("#policy"),
  watch: $("#watch"), log: $("#log"), clear: $("#clear")
};
const ctx = ui.screen.getContext("2d", { alpha: false });
const KEY = { a:1, b:2, select:4, start:8, right:16, left:32, up:64, down:128, r:256, l:512 };
const held = new Set();
const WATCH = [
  { name:"Candidato A", base:0x03000DF4, field:0x03000F94 },
  { name:"Candidato B", base:0x03001844, field:0x030019E4 },
  { name:"Candidato C", base:0x03002988, field:0x03002B28 }
];
let worker = null, reader = null, adapter = null, running = false, raf = 0, busy = false;
let mask = 0, frameNo = 0, previous = new Map(), history = [];

function log(message, cls="") {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
  ui.log.appendChild(d);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function makeWorker() {
  const raw = new Worker(new URL("../src/workers/emulator.worker.js", import.meta.url), { type:"module" });
  let id = 1;
  const pending = new Map();
  raw.addEventListener("message", e => {
    const m = e.data || {}, p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error || "Worker error"));
  });
  raw.addEventListener("error", e => log(e.message || "Falha no Worker", "error"));
  return {
    raw,
    request(type, payload={}, transfer=[]) {
      const n = id++;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(n); reject(new Error("Timeout: " + type)); }, 15000);
        pending.set(n,{resolve,reject,timer});
        raw.postMessage({id:n,type,...payload},transfer);
      });
    },
    terminate() {
      raw.terminate();
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Worker encerrado")); }
      pending.clear();
    }
  };
}
function draw(frame) {
  if (!(frame.pixels instanceof ArrayBuffer)) throw new Error("Framebuffer inválido");
  const src = new Uint8Array(frame.pixels), img = ctx.createImageData(240,160);
  for (let i=0,j=0; j<img.data.length; i+=4,j+=4) {
    img.data[j]=src[i]; img.data[j+1]=src[i+1]; img.data[j+2]=src[i+2]; img.data[j+3]=255;
  }
  ctx.putImageData(img,0,0);
}
function setKey(k,down) {
  if (!worker || !KEY[k]) return;
  if (down) held.add(k); else held.delete(k);
  let next=0; for (const v of held) next |= KEY[v];
  if (next===mask) return;
  mask=next; worker.request("setKeys",{keys:mask}).catch(e=>log(e.message,"error"));
}
function bindControls() {
  const map = {KeyW:"up",KeyS:"down",KeyA:"left",KeyD:"right",KeyJ:"a",KeyK:"b",KeyU:"l",KeyI:"r",Space:"start",KeyQ:"select"};
  window.addEventListener("keydown",e=>{const k=map[e.code];if(k){e.preventDefault();if(!e.repeat)setKey(k,true);}});
  window.addEventListener("keyup",e=>{const k=map[e.code];if(k){e.preventDefault();setKey(k,false);}});
  document.querySelectorAll("[data-key]").forEach(b=>{
    const k=b.dataset.key;
    b.addEventListener("pointerdown",e=>{e.preventDefault();b.setPointerCapture?.(e.pointerId);setKey(k,true);});
    const up=e=>{e.preventDefault();setKey(k,false);};
    b.addEventListener("pointerup",up);b.addEventListener("pointercancel",up);
    b.addEventListener("lostpointercapture",()=>setKey(k,false));
  });
  const release=()=>{held.clear();mask=0;if(worker)worker.request("setKeys",{keys:0}).catch(()=>{});};
  window.addEventListener("blur",release);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)release();});
}
const hex = n => "0x" + (n>>>0).toString(16).padStart(8,"0");
function fixed(v) {
  const n = v | 0;
  return (n >> 8) + "." + ((n & 255) / 256).toFixed(3).slice(2);
}
async function readPair(address) {
  const r = await worker.request("readMemoryRange",{address,length:8});
  if (r.address!==address || r.length!==8 || !(r.bytes instanceof ArrayBuffer)) throw new Error("Leitura inválida em "+hex(address));
  const dv = new DataView(r.bytes);
  return [dv.getInt32(0,true),dv.getInt32(4,true)];
}
function renderWatch(rows) {
  ui.watch.innerHTML = "";
  for (const row of rows) {
    const tr=document.createElement("tr");
    const values=[
      row.name,hex(row.base),hex(row.field),
      hex(row.a),fixed(row.a),row.da===null?"—":(row.da>=0?"+":"")+row.da,
      hex(row.b),fixed(row.b),row.db===null?"—":(row.db>=0?"+":"")+row.db
    ];
    for(const value of values){const td=document.createElement("td");td.textContent=String(value);tr.appendChild(td);}
    ui.watch.appendChild(tr);
  }
}
async function sample() {
  const rows=[];
  for(const item of WATCH) {
    const [a,b]=await readPair(item.field);
    const old=previous.get(item.field);
    rows.push({name:item.name,base:item.base,field:item.field,a,b,da:old?((a-old[0])>>8):null,db:old?((b-old[1])>>8):null});
    previous.set(item.field,[a,b]);
  }
  renderWatch(rows);
  const changed=rows.filter(r=>r.da!==null&&(r.da!==0||r.db!==0));
  if(changed.length) {
    const line=changed.map(r=>r.name+" A "+(r.da>=0?"+":"")+r.da+" / B "+(r.db>=0?"+":"")+r.db).join(" · ");
    history.push("frame "+frameNo+": "+line);
    if(history.length>35)history.shift();
    ui.log.textContent=history.join("\n");
    ui.log.scrollTop=ui.log.scrollHeight;
  }
}
async function tick() {
  if(!running||busy)return;
  busy=true;
  try {
    const f=await worker.request("runFrame");
    draw(await worker.request("framebuffer"));
    frameNo=f.frameCounter ?? frameNo+1;
    if(frameNo%6===0)await sample();
  } catch(e) { log(e.message,"error"); stop(); }
  finally { busy=false; }
  if(running)raf=requestAnimationFrame(tick);
}
function stop() {
  running=false;cancelAnimationFrame(raf);held.clear();mask=0;
  if(worker){worker.request("setKeys",{keys:0}).catch(()=>{});worker.terminate();}
  worker=null;reader=null;adapter=null;previous.clear();ui.load.disabled=false;ui.stop.disabled=true;
  ui.status.textContent="Sessão encerrada.";ui.policy.textContent="—";
}
ui.load.addEventListener("click",async()=>{
  const file=ui.rom.files?.[0];
  if(!file){ui.status.textContent="Selecione a ROM Buu's Fury.";return;}
  stop();ui.log.textContent="";history=[];ui.load.disabled=true;
  try {
    worker=makeWorker();await worker.request("init");
    const rom=await file.arrayBuffer();await worker.request("loadRom",{rom},[rom]);
    reader=new MemoryReader(worker);await reader.enableReadOnlyPolicy();
    const policy=await reader.getWritePolicyState();
    if(policy.memoryWriteEnabled||!policy.memoryWriteLocked)throw new Error("Trava read-only não confirmada.");
    adapter=new BuuFuryStateAdapter(reader);await worker.request("runFrame");
    const state=await adapter.readState();
    ui.character.textContent=state.currentCharacter??"—";
    ui.hp.textContent=state.hp==null?"—":state.hp+"/"+state.maxHp;
    ui.policy.textContent="RAM read-only travada";
    draw(await worker.request("framebuffer"));
    running=true;raf=requestAnimationFrame(tick);
    ui.load.disabled=false;ui.stop.disabled=false;
    ui.status.textContent="Buu's Fury carregado · "+file.name+" · monitor de 3 estruturas ativo.";
    log("ROM carregada: "+file.name+". Worker B em execução.","ok");
    log("Política read-only confirmada. Monitor lê somente 6 words por amostra; nenhuma escrita na RAM.","ok");
    log("Campos observados: +0x1A0 e +0x1A4 em três estruturas candidatas.");
  } catch(e){log(e.message,"error");ui.status.textContent="Falha: "+e.message;stop();}
});
ui.stop.addEventListener("click",stop);
ui.clear.addEventListener("click",()=>{history=[];previous.clear();ui.log.textContent="Histórico limpo. As leituras continuam.";});
bindControls();
