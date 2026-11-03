import { MgbaWorkerAdapter } from "../src/mashup/GbaMashupCore.js";
import { decodeMinishCapPlayer } from "../src/mashup/adapters/MinishCapDecoder.js";
import { decodeLegacyOfGoku2Player } from "../src/mashup/adapters/LegacyOfGoku2Decoder.js";

const $=s=>document.querySelector(s);
const ui={
 romA:$("#romA"),romB:$("#romB"),load:$("#load"),stop:$("#stop"),status:$("#status"),
 screenA:$("#screenA"),screenB:$("#screenB"),overlayA:$("#overlayA"),log:$("#log"),
 linkX:$("#gokuX"),linkY:$("#gokuY"),frames:$("#frames"),probe:$("#providerStatus"),projection:$("#projection"),
 originX:$("#originX"),originY:$("#originY"),scaleX:$("#scaleX"),scaleY:$("#scaleY"),
 offsetX:$("#offsetX"),offsetY:$("#offsetY"),apply:$("#apply")
};
const ctxA=ui.screenA.getContext("2d",{alpha:false});
const ctxB=ui.screenB.getContext("2d",{alpha:false});
const ov=ui.overlayA.getContext("2d");
const KEY={a:1,b:2,select:4,start:8,right:16,left:32,up:64,down:128,r:256,l:512};
const maps={
 A:{ArrowRight:"right",ArrowLeft:"left",ArrowUp:"up",ArrowDown:"down",KeyX:"a",KeyZ:"b",KeyC:"l",KeyV:"r",Enter:"start",ShiftRight:"select"},
 B:{KeyD:"right",KeyA:"left",KeyW:"up",KeyS:"down",KeyJ:"a",KeyK:"b",KeyU:"l",KeyI:"r",Space:"start",KeyQ:"select"}
};
let workers={A:null,B:null},adapters={A:null,B:null},held={A:new Set(),B:new Set()},masks={A:0,B:0};
let running=false,raf=0,busy=false,frame=0,goku=null;
let transform={originX:0,originY:0,scaleX:.05,scaleY:.05,offsetX:120,offsetY:80};

function log(s){ui.log.textContent+=s+"\n";ui.log.scrollTop=ui.log.scrollHeight;}
function makeWorker(){
 const raw=new Worker(new URL("../src/workers/emulator.worker.js",import.meta.url),{type:"module"});
 let id=1;const pending=new Map();
 raw.addEventListener("message",e=>{const m=e.data||{},p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m):p.reject(new Error(m.error||"Worker error"));});
 raw.addEventListener("error",e=>log("Worker: "+(e.message||"erro")));
 return {raw,request(type,payload={},transfer=[]){const n=id++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(n);reject(new Error("Timeout: "+type));},15000);pending.set(n,{resolve,reject,timer});raw.postMessage({id:n,type,...payload},transfer);});},terminate(){raw.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("Worker encerrado"));}pending.clear();}};
}
function draw(ctx,framebuffer){
 if(!(framebuffer.pixels instanceof ArrayBuffer))throw Error("Framebuffer inválido");
 const src=new Uint8Array(framebuffer.pixels),img=ctx.createImageData(240,160);
 for(let i=0,j=0;j<img.data.length;i+=4,j+=4){img.data[j]=src[i];img.data[j+1]=src[i+1];img.data[j+2]=src[i+2];img.data[j+3]=255;}
 ctx.putImageData(img,0,0);
}
function setKey(target,key,down){
 const w=workers[target];if(!w||!KEY[key])return;
 if(down)held[target].add(key);else held[target].delete(key);
 let next=0;for(const k of held[target])next|=KEY[k];
 if(next===masks[target])return;masks[target]=next;
 w.request("setKeys",{keys:next}).catch(e=>log(target+": "+e.message));
}
function release(target){
 held[target].clear();masks[target]=0;
 if(workers[target])workers[target].request("setKeys",{keys:0}).catch(()=>{});
}
function bindTouchControls(selector,target){
 document.querySelectorAll(selector).forEach(button=>{
  const key=button.dataset[target==="A"?"keyA":"keyB"];
  button.addEventListener("pointerdown",event=>{
   event.preventDefault();
   button.setPointerCapture?.(event.pointerId);
   setKey(target,key,true);
  });
  const up=event=>{event.preventDefault();setKey(target,key,false);};
  button.addEventListener("pointerup",up);
  button.addEventListener("pointercancel",up);
  button.addEventListener("lostpointercapture",()=>setKey(target,key,false));
  button.addEventListener("contextmenu",event=>event.preventDefault());
 });
}
function bindControls(){
 bindTouchControls("[data-key-a]","A");
 bindTouchControls("[data-key-b]","B");
 window.addEventListener("keydown",e=>{for(const t of ["A","B"]){const k=maps[t][e.code];if(k){e.preventDefault();if(!e.repeat)setKey(t,k,true);}}});
 window.addEventListener("keyup",e=>{for(const t of ["A","B"]){const k=maps[t][e.code];if(k){e.preventDefault();setKey(t,k,false);}}});
 window.addEventListener("blur",()=>{release("A");release("B");});
 document.addEventListener("visibilitychange",()=>{if(document.hidden){release("A");release("B");}});
}
function drawTransferredEntity(){
 ov.clearRect(0,0,240,160);
 if(!goku?.position)return;
 const x=(goku.position.x-transform.originX)*transform.scaleX+transform.offsetX;
 const y=(goku.position.y-transform.originY)*transform.scaleY+transform.offsetY;
 ui.projection.textContent="Personagem DBZ projetado em Minish Cap: x="+x.toFixed(1)+" · y="+y.toFixed(1);
 if(x < -12 || x > 252 || y < -12 || y > 172)return;
 ov.fillStyle="rgba(0,0,0,.72)";ov.fillRect(4,4,142,20);
 ov.fillStyle="#7df9ff";ov.font="10px monospace";ov.fillText("DBZ PLAYER / LEGACY OF GOKU II",9,18);
 ov.strokeStyle="#7df9ff";ov.lineWidth=2;ov.beginPath();ov.arc(x,y,6,0,Math.PI*2);ov.stroke();
 ov.beginPath();ov.moveTo(x-10,y);ov.lineTo(x+10,y);ov.moveTo(x,y-10);ov.lineTo(x,y+10);ov.stroke();
}
function applyCalibration(){
 const vals=["originX","originY","scaleX","scaleY","offsetX","offsetY"].map(k=>Number(ui[k].value));
 if(vals.some(v=>!Number.isFinite(v))||vals[2]===0||vals[3]===0){log("Calibração inválida: use números finitos e escalas diferentes de zero.");return;}
 [transform.originX,transform.originY,transform.scaleX,transform.scaleY,transform.offsetX,transform.offsetY]=vals;
 drawTransferredEntity();log("Calibração aplicada.");
}
async function tick(){
 if(!running||busy)return;busy=true;
 try{
  const [fa,fb]=await Promise.all([adapters.A.stepFrame(),adapters.B.stepFrame()]);
  const [ba,bb]=await Promise.all([adapters.A.framebuffer(),adapters.B.framebuffer()]);
  draw(ctxA,ba);draw(ctxB,bb);frame++;
  if(frame%3===0){
   goku=await adapters.B.readState();
   ui.linkX.textContent=goku?.position ? goku.position.x.toFixed(3) : "indisponível";
   ui.linkY.textContent=goku?.position ? goku.position.y.toFixed(3) : "indisponível";
   ui.probe.textContent=goku?.position
    ? "Personagem detectado · confiança: "+goku.confidence+" · coordenadas Q24.8 convertidas."
    : (goku?.reason || "Aguardando o personagem ser criado no jogo.");
   ui.frames.textContent=fa+" / "+fb;
   drawTransferredEntity();
  }

 }catch(e){log("ERRO: "+e.message);stop();}
 finally{busy=false;}
 if(running)raf=requestAnimationFrame(tick);
}
function stop(){
 running=false;cancelAnimationFrame(raf);release("A");release("B");
 for(const t of ["A","B"]){if(adapters[t]){adapters[t].dispose().catch(()=>{});adapters[t]=null;}if(workers[t]){workers[t].terminate();workers[t]=null;}}
 ui.load.disabled=false;ui.stop.disabled=true;ui.status.textContent="Sessão encerrada.";
}
ui.apply.addEventListener("click",applyCalibration);
ui.load.addEventListener("click",async()=>{
 const fa=ui.romA.files?.[0],fb=ui.romB.files?.[0];
 if(!fa||!fb){ui.status.textContent="Selecione as duas ROMs.";return;}
 stop();ui.load.disabled=true;ui.log.textContent="";goku=null;ov.clearRect(0,0,240,160);
 try{
  for(const [t,file] of [["A",fa],["B",fb]]){
   workers[t]=makeWorker();await workers[t].request("init");
   const rom=await file.arrayBuffer();await workers[t].request("loadRom",{rom},[rom]);
  }
  adapters.A=new MgbaWorkerAdapter({id:"minish-cap",game:"minish-cap",worker:workers.A,decodeSnapshot:decodeMinishCapPlayer});
  adapters.B=new MgbaWorkerAdapter({id:"legacy-of-goku-2",game:"legacy-of-goku-2",worker:workers.B,decodeSnapshot:decodeLegacyOfGoku2Player});
  await Promise.all([adapters.A.stepFrame(),adapters.B.stepFrame()]);
  draw(ctxA,await adapters.A.framebuffer());draw(ctxB,await adapters.B.framebuffer());
  running=true;raf=requestAnimationFrame(tick);ui.load.disabled=false;ui.stop.disabled=false;
  ui.status.textContent="Dois jogos ativos. Goku é decodificado no Worker B e projetado sobre Minish Cap (Worker A).";
  log("Adaptadores mGBA conectados ao núcleo GBA.");
  log("Personagem ativo: g_PlayerObject em 0x03001FA8; X/Y em +0x158/+0x15C (Q24.8, confiança provável).");
  log("Provider → Host: Legacy of Goku II → Minish Cap. Leitura de RAM somente; nenhuma escrita.");
 }catch(e){log("Falha: "+e.message);ui.status.textContent="Falha ao iniciar: "+e.message;stop();}
});
ui.stop.addEventListener("click",stop);
bindControls();
