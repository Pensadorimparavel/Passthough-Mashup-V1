import { MgbaWorkerAdapter } from "../src/mashup/GbaMashupCore.js";
import { decodeMinishCapPlayer } from "../src/mashup/adapters/MinishCapDecoder.js";
import { decodeBuuFuryCandidates } from "../src/mashup/adapters/BuuFuryProbeDecoder.js";

const $=s=>document.querySelector(s);
const ui={
 romA:$("#romA"),romB:$("#romB"),load:$("#load"),stop:$("#stop"),status:$("#status"),
 screenA:$("#screenA"),screenB:$("#screenB"),overlayB:$("#overlayB"),log:$("#log"),
 linkX:$("#linkX"),linkY:$("#linkY"),frames:$("#frames"),probe:$("#probe"),projection:$("#projection"),
 originX:$("#originX"),originY:$("#originY"),scaleX:$("#scaleX"),scaleY:$("#scaleY"),
 offsetX:$("#offsetX"),offsetY:$("#offsetY"),apply:$("#apply")
};
const ctxA=ui.screenA.getContext("2d",{alpha:false});
const ctxB=ui.screenB.getContext("2d",{alpha:false});
const ov=ui.overlayB.getContext("2d");
const KEY={a:1,b:2,select:4,start:8,right:16,left:32,up:64,down:128,r:256,l:512};
const maps={
 A:{ArrowRight:"right",ArrowLeft:"left",ArrowUp:"up",ArrowDown:"down",KeyX:"a",KeyZ:"b",KeyC:"l",KeyV:"r",Enter:"start",ShiftRight:"select"},
 B:{KeyD:"right",KeyA:"left",KeyW:"up",KeyS:"down",KeyJ:"a",KeyK:"b",KeyU:"l",KeyI:"r",Space:"start",KeyQ:"select"}
};
let workers={A:null,B:null},adapters={A:null,B:null},held={A:new Set(),B:new Set()},masks={A:0,B:0};
let running=false,raf=0,busy=false,frame=0,link=null,probe=null;
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
function bindControls(){
 window.addEventListener("keydown",e=>{for(const t of ["A","B"]){const k=maps[t][e.code];if(k){e.preventDefault();if(!e.repeat)setKey(t,k,true);}}});
 window.addEventListener("keyup",e=>{for(const t of ["A","B"]){const k=maps[t][e.code];if(k){e.preventDefault();setKey(t,k,false);}}});
 window.addEventListener("blur",()=>{release("A");release("B");});
}
function drawTransferredEntity(){
 ov.clearRect(0,0,240,160);
 if(!link)return;
 const x=(link.position.x-transform.originX)*transform.scaleX+transform.offsetX;
 const y=(link.position.y-transform.originY)*transform.scaleY+transform.offsetY;
 ui.projection.textContent="Projeção: x="+x.toFixed(1)+" · y="+y.toFixed(1);
 if(x < -12 || x > 252 || y < -12 || y > 172)return;
 ov.fillStyle="rgba(0,0,0,.72)";ov.fillRect(4,4,142,20);
 ov.fillStyle="#7df9ff";ov.font="10px monospace";ov.fillText("LINK / MINISH CAP",9,18);
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
   link=await adapters.A.readState();
   ui.linkX.textContent=link.position.x.toFixed(3);ui.linkY.textContent=link.position.y.toFixed(3);
   ui.frames.textContent=fa+" / "+fb;
   drawTransferredEntity();
  }
  if(frame%12===0){
   probe=await adapters.B.readState();
   ui.probe.textContent="Buu candidates (não são coordenadas confirmadas): "+probe.candidates.map(c=>c.id+"="+c.signalA.toFixed(2)).join(" · ");
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
 stop();ui.load.disabled=true;ui.log.textContent="";link=null;probe=null;ov.clearRect(0,0,240,160);
 try{
  for(const [t,file] of [["A",fa],["B",fb]]){
   workers[t]=makeWorker();await workers[t].request("init");
   const rom=await file.arrayBuffer();await workers[t].request("loadRom",{rom},[rom]);
  }
  adapters.A=new MgbaWorkerAdapter({id:"minish-cap",game:"minish-cap",worker:workers.A,decodeSnapshot:decodeMinishCapPlayer});
  adapters.B=new MgbaWorkerAdapter({id:"buu-fury",game:"buu-fury",worker:workers.B,decodeSnapshot:decodeBuuFuryCandidates});
  await Promise.all([adapters.A.stepFrame(),adapters.B.stepFrame()]);
  draw(ctxA,await adapters.A.framebuffer());draw(ctxB,await adapters.B.framebuffer());
  running=true;raf=requestAnimationFrame(tick);ui.load.disabled=false;ui.stop.disabled=false;
  ui.status.textContent="Dois jogos ativos. Link é decodificado no Worker A e renderizado sobre a tela do Worker B.";
  log("Adaptadores mGBA conectados ao núcleo GBA.");
  log("A posição de Link usa Entity +0x2C/+0x30 em Q16.16.");
  log("Os candidatos de Buu's Fury continuam experimentais; nenhuma RAM é escrita.");
 }catch(e){log("Falha: "+e.message);ui.status.textContent="Falha ao iniciar: "+e.message;stop();}
});
ui.stop.addEventListener("click",stop);
bindControls();
