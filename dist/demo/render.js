import{ballStyle}from'../src/rack.js';export function interpolateBallStates(from,to,amount){const t=Math.max(0,Math.min(1,amount));if(!Array.isArray(from)||!Array.isArray(to))return[];return from.map((ball,index)=>{const next=to[index]??ball;if(ball.pocketed||next.pocketed)return ball;const rollDirX=(ball.rollDirX??0)+((next.rollDirX??ball.rollDirX??0)-(ball.rollDirX??0))*t;const rollDirY=(ball.rollDirY??0)+((next.rollDirY??ball.rollDirY??0)-(ball.rollDirY??0))*t;const rollDirLength=Math.hypot(rollDirX,rollDirY);return{...ball,
x:ball.x+(next.x-ball.x)*t,
y:ball.y+(next.y-ball.y)*t,
rollAngle:(ball.rollAngle??0)+((next.rollAngle??ball.rollAngle??0)-(ball.rollAngle??0))*t,
rollDirX:rollDirLength>1e-9?rollDirX/rollDirLength:0,
rollDirY:rollDirLength>1e-9?rollDirY/rollDirLength:0,};});}
export function sampleDampedCamera(from,to,velocity,elapsed,frequency=13.5){const t=Math.max(0,elapsed);const offset=from-to;const impulse=velocity+frequency*offset;const decay=Math.exp(-frequency*t);const value=to+(offset+impulse*t)*decay;const speed=(impulse-frequency*(offset+impulse*t))*decay;return{value,velocity:speed};}
export const FRAME_MARGIN=0.13;function makeRand(seed){let s=seed>>>0||1;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
const FELT_FIBERS=(()=>{const rand=makeRand(0x51f15e);return Array.from({length:720},()=>({x:0.01+rand()*0.98,
y:0.01+rand()*0.98,
length:0.002+rand()*0.005,
angle:rand()<0.84?0:Math.PI/2,
alpha:0.025+rand()*0.045,}));})();function roundRectPath(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
export function createRenderer({canvas,table:initialTable}){let ctx=canvas.getContext('2d');let table=initialTable;let scale=1;let offset={x:0,y:0};let dpr=1;let tableCache=null;let tableCacheKey=null;const gradCache={ctx:null,
ballBody:null,
ballShadow:null,
pocket3d:null,
stripes:new Map(),
cue:null,
screenKey:'',
screen:null,
feltKey:'',
felt:null,
geomTable:null,
geom:null,};function ensureGradientContext(){if(gradCache.ctx===ctx)return;gradCache.ctx=ctx;gradCache.ballBody=null;gradCache.ballShadow=null;gradCache.pocket3d=null;gradCache.stripes.clear();gradCache.cue=null;gradCache.screenKey='';gradCache.screen=null;gradCache.feltKey='';gradCache.felt=null;}
function resetGradients(){gradCache.ctx=null;ensureGradientContext();}
function fillUnitGradient(g,x,y,r){ctx.save();ctx.translate(x,y);ctx.scale(r,r);ctx.fillStyle=g;ctx.fill();ctx.restore();}
function ballBodyGradient(){ensureGradientContext();if(!gradCache.ballBody){const g=ctx.createRadialGradient(-0.38,-0.42,0.05,-0.1,-0.1,1.35);g.addColorStop(0,'rgba(255,255,255,0.55)');g.addColorStop(0.32,'rgba(255,255,255,0.10)');g.addColorStop(0.62,'rgba(0,0,0,0.02)');g.addColorStop(1,'rgba(0,0,0,0.55)');gradCache.ballBody=g;}
return gradCache.ballBody;}
function ballShadowGradient(){ensureGradientContext();if(!gradCache.ballShadow){const g=ctx.createRadialGradient(0,0,0.08,0,0,1);g.addColorStop(0,'rgba(0,0,0,0.38)');g.addColorStop(0.62,'rgba(0,0,0,0.20)');g.addColorStop(1,'rgba(0,0,0,0)');gradCache.ballShadow=g;}
return gradCache.ballShadow;}
function stripeGradient(color){ensureGradientContext();let g=gradCache.stripes.get(color);if(!g){g=ctx.createLinearGradient(0,-0.67,0,0.67);g.addColorStop(0,shade(color,-0.12));g.addColorStop(0.5,color);g.addColorStop(1,shade(color,-0.22));gradCache.stripes.set(color,g);}
return g;}
function pocket3DGradient(){ensureGradientContext();if(!gradCache.pocket3d){const g=ctx.createRadialGradient(0,0,0.1,0,0,1.05);g.addColorStop(0,'#000000');g.addColorStop(0.75,'#04070a');g.addColorStop(1,'#111922');gradCache.pocket3d=g;}
return gradCache.pocket3d;}
function screenGradients(w,h){const key=`${w}x${h}`;if(gradCache.screenKey===key&&gradCache.screen)return gradCache.screen;ensureGradientContext();const bg=ctx.createRadialGradient(w*0.5,h*0.4,h*0.1,w*0.5,h*0.5,h*1.1);bg.addColorStop(0,'#16222f');bg.addColorStop(0.55,'#0d1520');bg.addColorStop(1,'#070b10');const lamp=ctx.createRadialGradient(w*0.5,h*0.35,20,w*0.5,h*0.35,w*0.55);lamp.addColorStop(0,'rgba(255, 240, 215, 0.08)');lamp.addColorStop(1,'rgba(0, 0, 0, 0)');const wood=ctx.createLinearGradient(0,0,w,h);wood.addColorStop(0,'#533118');wood.addColorStop(0.5,'#3d2210');wood.addColorStop(1,'#2a160a');const cush=ctx.createLinearGradient(0,0,0,h);cush.addColorStop(0,'#1a3824');cush.addColorStop(0.5,'#122b1c');cush.addColorStop(1,'#0e2015');gradCache.screen={bg,lamp,wood,cush};gradCache.screenKey=key;return gradCache.screen;}
function feltGradient(cx,cy,r){const key=`${cx},${cy},${r}`;if(gradCache.feltKey===key&&gradCache.felt)return gradCache.felt;ensureGradientContext();const g=ctx.createRadialGradient(cx,cy*0.95,r*0.05,cx,cy,r);g.addColorStop(0,'#157a49');g.addColorStop(0.55,'#0f5c37');g.addColorStop(1,'#083620');gradCache.felt=g;gradCache.feltKey=key;return g;}
function cueGradients(){ensureGradientContext();if(gradCache.cue)return gradCache.cue;const shaft=ctx.createLinearGradient(-0.5,0,0.5,0);shaft.addColorStop(0,'#854d0e');shaft.addColorStop(0.18,'#d97706');shaft.addColorStop(0.45,'#fef3c7');shaft.addColorStop(0.72,'#fde68a');shaft.addColorStop(1,'#92400e');const wrap=ctx.createLinearGradient(-0.5,0,0.5,0);wrap.addColorStop(0,'#0f172a');wrap.addColorStop(0.25,'#1e293b');wrap.addColorStop(0.5,'#334155');wrap.addColorStop(0.75,'#1e293b');wrap.addColorStop(1,'#020617');const ferrule=ctx.createLinearGradient(-0.5,0,0.5,0);ferrule.addColorStop(0,'#94a3b8');ferrule.addColorStop(0.3,'#ffffff');ferrule.addColorStop(0.7,'#f8fafc');ferrule.addColorStop(1,'#64748b');const tip=ctx.createLinearGradient(-0.5,0,0.5,0);tip.addColorStop(0,'#0369a1');tip.addColorStop(0.35,'#38bdf8');tip.addColorStop(0.75,'#0ea5e9');tip.addColorStop(1,'#0c4a6e');gradCache.cue={shaft,wrap,ferrule,tip};return gradCache.cue;}
function fillCueGradient(g,tipX,width){ctx.save();ctx.translate(tipX,0);ctx.scale(width,1);ctx.fillStyle=g;ctx.fill();ctx.restore();}
function tableGeometry(){if(gradCache.geomTable===table&&gradCache.geom)return gradCache.geom;const L=table.length;const W=table.width;const Mc=FRAME_MARGIN*0.42;const Mw=FRAME_MARGIN;const apronFaces=[
[[-Mw,-Mw,0],[L+Mw,-Mw,0],[L+Mw,-Mw,-0.085],[-Mw,-Mw,-0.085]],
[[L+Mw,-Mw,0],[L+Mw,W+Mw,0],[L+Mw,W+Mw,-0.085],[L+Mw,-Mw,-0.085]],
[[L+Mw,W+Mw,0],[-Mw,W+Mw,0],[-Mw,W+Mw,-0.085],[L+Mw,W+Mw,-0.085]],
[[-Mw,W+Mw,0],[-Mw,-Mw,0],[-Mw,-Mw,-0.085],[-Mw,W+Mw,-0.085]],
].map((face)=>face.map(([x,y,z])=>({x,y,z})));const woodRails=[
[{x:-Mw,y:-Mw},{x:L+Mw,y:-Mw},{x:L+Mc,y:-Mc},{x:-Mc,y:-Mc}],
[{x:L+Mc,y:-Mc},{x:L+Mw,y:-Mw},{x:L+Mw,y:W+Mw},{x:L+Mc,y:W+Mc}],
[{x:-Mc,y:W+Mc},{x:L+Mc,y:W+Mc},{x:L+Mw,y:W+Mw},{x:-Mw,y:W+Mw}],
[{x:-Mw,y:-Mw},{x:-Mc,y:-Mc},{x:-Mc,y:W+Mc},{x:-Mw,y:W+Mw}],
];const cushionBands=[
[{x:-Mc,y:-Mc},{x:L+Mc,y:-Mc},{x:L,y:0},{x:0,y:0}],
[{x:L+Mc,y:-Mc},{x:L+Mc,y:W+Mc},{x:L,y:W},{x:L,y:0}],
[{x:0,y:W},{x:L,y:W},{x:L+Mc,y:W+Mc},{x:-Mc,y:W+Mc}],
[{x:-Mc,y:-Mc},{x:0,y:0},{x:0,y:W},{x:-Mc,y:W+Mc}],
];const feltPoly=[
{x:0,y:0},
{x:L,y:0},
{x:L,y:W},
{x:0,y:W},
];const spots=[];for(let i=1;i<8;i++){const x=(L*i)/8;spots.push({x,y:W+Mw*0.5});spots.push({x,y:-Mw*0.5});}
for(let i=1;i<4;i++){const y=(W*i)/4;spots.push({x:-Mw*0.5,y});spots.push({x:L+Mw*0.5,y});}
gradCache.geom={apronFaces,woodRails,cushionBands,feltPoly,spots};gradCache.geomTable=table;return gradCache.geom;}
const camera={t:0,
aimAngle:0,
cueBall:{x:0,y:0},
strokeOffset:0,};const currentCam={C:[0,0,0],
R:[1,0,0],
V:[0,-1,0],
F:[0,0,-1],
cx:0,
cy:0,
f:0,};function setCamera(opts={}){if(opts.t!==undefined)camera.t=Math.max(0,Math.min(1,opts.t));if(opts.aimAngle!==undefined)camera.aimAngle=opts.aimAngle;if(opts.cueBall)camera.cueBall={...opts.cueBall};if(opts.strokeOffset!==undefined)camera.strokeOffset=opts.strokeOffset;}
function getCamera(){return{...camera};}
function matToQuat(R,V,F){const m00=R[0],m01=R[1],m02=R[2];const m10=V[0],m11=V[1],m12=V[2];const m20=F[0],m21=F[1],m22=F[2];const tr=m00+m11+m22;let qx,qy,qz,qw;if(tr>0){const s=0.5/Math.sqrt(tr+1.0);qw=0.25/s;qx=(m21-m12)*s;qy=(m02-m20)*s;qz=(m10-m01)*s;}else if((m00>m11)&&(m00>m22)){const s=2.0*Math.sqrt(1.0+m00-m11-m22);qw=(m21-m12)/s;qx=0.25*s;qy=(m01+m10)/s;qz=(m02+m20)/s;}else if(m11>m22){const s=2.0*Math.sqrt(1.0+m11-m00-m22);qw=(m02-m20)/s;qx=(m01+m10)/s;qy=0.25*s;qz=(m12+m21)/s;}else{const s=2.0*Math.sqrt(1.0+m22-m00-m11);qw=(m10-m01)/s;qx=(m02+m20)/s;qy=(m12+m21)/s;qz=0.25*s;}
return[qx,qy,qz,qw];}
function quatToMat(q){const[x,y,z,w]=q;const x2=x+x,y2=y+y,z2=z+z;const xx=x*x2,xy=x*y2,xz=x*z2;const yy=y*y2,yz=y*z2,zz=z*z2;const wx=w*x2,wy=w*y2,wz=w*z2;return{R:[1-(yy+zz),xy-wz,xz+wy],
V:[xy+wz,1-(xx+zz),yz-wx],
F:[xz-wy,yz+wx,1-(xx+yy)],};}
function quatSlerp(qa,qb,t){let cosHalfTheta=qa[0]*qb[0]+qa[1]*qb[1]+qa[2]*qb[2]+qa[3]*qb[3];let qbTarget=[qb[0],qb[1],qb[2],qb[3]];if(cosHalfTheta<0){cosHalfTheta=-cosHalfTheta;qbTarget[0]=-qbTarget[0];qbTarget[1]=-qbTarget[1];qbTarget[2]=-qbTarget[2];qbTarget[3]=-qbTarget[3];}
if(Math.abs(cosHalfTheta)>=1.0)return[qa[0],qa[1],qa[2],qa[3]];const halfTheta=Math.acos(cosHalfTheta);const sinHalfTheta=Math.sqrt(1.0-cosHalfTheta*cosHalfTheta);if(Math.abs(sinHalfTheta)<0.001){return[
0.5*(qa[0]+qbTarget[0]),
0.5*(qa[1]+qbTarget[1]),
0.5*(qa[2]+qbTarget[2]),
0.5*(qa[3]+qbTarget[3]),
];}
const ratioA=Math.sin((1-t)*halfTheta)/sinHalfTheta;const ratioB=Math.sin(t*halfTheta)/sinHalfTheta;return[
qa[0]*ratioA+qbTarget[0]*ratioB,
qa[1]*ratioA+qbTarget[1]*ratioB,
qa[2]*ratioA+qbTarget[2]*ratioB,
qa[3]*ratioA+qbTarget[3]*ratioB,
];}
function computeCurrentCamera(){const w=canvas.width/dpr;const h=canvas.height/dpr;const u=camera.t;const cueX=camera.cueBall?.x??table.length*0.25;const cueY=camera.cueBall?.y??table.width*0.5;const theta=camera.aimAngle??0;const D_cam=0.62;const H_cam=0.24;const pitch=0.19;const R0=[1,0,0];const V0=[0,-1,0];const F0=[0,0,-1];const q0=matToQuat(R0,V0,F0);const cosP=Math.cos(pitch);const sinP=Math.sin(pitch);const cosT=Math.cos(theta);const sinT=Math.sin(theta);const R1=[sinT,-cosT,0];const V1=[cosT*sinP,sinT*sinP,-cosP];const F1=[cosT*cosP,sinT*cosP,sinP];const q1=matToQuat(R1,V1,F1);const q=quatSlerp(q0,q1,u);const m=quatToMat(q);const Ztop=(h*0.72)/scale;const C0=[table.length*0.5,table.width*0.5,Ztop];const C1=[cueX-D_cam*cosT,cueY-D_cam*sinT,H_cam];const liftArc=Math.sin(Math.PI*u)*0.14;currentCam.C=[
(1-u)*C0[0]+u*C1[0],
(1-u)*C0[1]+u*C1[1],
(1-u)*C0[2]+u*C1[2]+liftArc,
];currentCam.R=m.R;currentCam.V=m.V;currentCam.F=m.F;currentCam.cx=w*0.5;currentCam.cy=(1-u)*(h*0.5)+u*(h*0.12);currentCam.f=(1-u)*(Ztop*scale)+u*(h*0.9);}
function project(x,y,z=0){const p2d={x:offset.x+x*scale,
y:offset.y+(table.width-y)*scale,};const r2d=scale;if(camera.t<=0.0001){return{x:p2d.x,
y:p2d.y,
scale:r2d,
depth:1,
zCam:1,
behind:false,};}
const C=currentCam.C;const R=currentCam.R;const V=currentCam.V;const F=currentCam.F;const dx=x-C[0];const dy=y-C[1];const dz=z-C[2];const xCam=dx*R[0]+dy*R[1]+dz*R[2];const yScreen=dx*V[0]+dy*V[1]+dz*V[2];const zCam=dx*F[0]+dy*F[1]+dz*F[2];const behind=zCam<0.03;const safeZ=Math.max(0.04,zCam);const p3d={x:currentCam.cx+(xCam/safeZ)*currentCam.f,
y:currentCam.cy+(yScreen/safeZ)*currentCam.f,};const r3d=currentCam.f/safeZ;if(camera.t<0.08){const blend=camera.t/0.08;const bSmooth=blend*blend*(3-2*blend);return{x:(1-bSmooth)*p2d.x+bSmooth*p3d.x,
y:(1-bSmooth)*p2d.y+bSmooth*p3d.y,
scale:(1-bSmooth)*r2d+bSmooth*r3d,
depth:safeZ,
zCam,
behind:false,};}
return{x:p3d.x,
y:p3d.y,
scale:r3d,
depth:safeZ,
zCam,
behind:behind&&camera.t>0.35,};}
function clipPolygonNear(poly,nearZ=0.05){if(camera.t<=0.001)return poly;const C=currentCam.C;const F=currentCam.F;const getZCam=(pt)=>{const dx=pt.x-C[0];const dy=pt.y-C[1];const dz=(pt.z??0)-C[2];return dx*F[0]+dy*F[1]+dz*F[2];};const out=[];for(let i=0;i<poly.length;i++){const cur=poly[i];const next=poly[(i+1)%poly.length];const curZ=getZCam(cur);const nextZ=getZCam(next);const curIn=curZ>=nearZ;const nextIn=nextZ>=nearZ;if(curIn){out.push(cur);if(!nextIn){const t=(nearZ-curZ)/(nextZ-curZ);out.push({x:cur.x+(next.x-cur.x)*t,
y:cur.y+(next.y-cur.y)*t,
z:(cur.z??0)+((next.z??0)-(cur.z??0))*t,});}}else if(nextIn){const t=(nearZ-curZ)/(nextZ-curZ);out.push({x:cur.x+(next.x-cur.x)*t,
y:cur.y+(next.y-cur.y)*t,
z:(cur.z??0)+((next.z??0)-(cur.z??0))*t,});}}
return out;}
function drawProjectedPolygon(poly,fillStyle,strokeStyle=null,lineWidth=1){const clipped=camera.t>0.001?clipPolygonNear(poly,0.05):poly;if(clipped.length<3)return;ctx.beginPath();const first=project(clipped[0].x,clipped[0].y,clipped[0].z??0);ctx.moveTo(first.x,first.y);for(let i=1;i<clipped.length;i++){const p=project(clipped[i].x,clipped[i].y,clipped[i].z??0);ctx.lineTo(p.x,p.y);}
ctx.closePath();if(fillStyle){ctx.fillStyle=fillStyle;ctx.fill();}
if(strokeStyle){ctx.strokeStyle=strokeStyle;ctx.lineWidth=lineWidth;ctx.stroke();}}
const toPx=(p)=>({x:offset.x+p.x*scale,
y:offset.y+(table.width-p.y)*scale,});const toWorld=(px,py)=>({x:(px-offset.x)/scale,
y:table.width-(py-offset.y)/scale,});function fit(availW,availH){const totalW=table.length+FRAME_MARGIN*2;const totalH=table.width+FRAME_MARGIN*2;scale=Math.min(availW/totalW,availH/totalH);dpr=Math.min(window.devicePixelRatio||1,2);const w=totalW*scale;const h=totalH*scale;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);offset={x:FRAME_MARGIN*scale,y:FRAME_MARGIN*scale};tableCache=null;resetGradients();return{w,h,scale};}
function clear(){ctx.clearRect(0,0,canvas.width,canvas.height);}
function drawWood(w,h){const grad=ctx.createLinearGradient(0,0,w,h);grad.addColorStop(0,'#7b4a28');grad.addColorStop(0.45,'#5d3618');grad.addColorStop(1,'#3d2210');roundRectPath(ctx,0,0,w,h,16);ctx.fillStyle=grad;ctx.fill();ctx.save();roundRectPath(ctx,0,0,w,h,16);ctx.clip();const rand=makeRand(0x9e3779b9);const lines=Math.max(24,Math.round(h/9));for(let i=0;i<lines;i++){const y=(i/lines)*h+rand()*6;const amp=1.2+rand()*2.6;const phase=rand()*Math.PI*2;ctx.beginPath();ctx.moveTo(-4,y);for(let x=-4;x<=w+4;x+=14){ctx.lineTo(x,y+Math.sin(x/47+phase)*amp);}
ctx.strokeStyle=i%3===0?'rgba(0,0,0,0.16)':'rgba(255,214,170,0.055)';ctx.lineWidth=0.6+rand()*0.9;ctx.stroke();}
ctx.fillStyle='rgba(0,0,0,0.12)';ctx.fillRect(0,0,w,h);ctx.restore();roundRectPath(ctx,0.5,0.5,w-1,h-1,16);ctx.strokeStyle='rgba(255,222,180,0.16)';ctx.lineWidth=1;ctx.stroke();}
function drawCushionBand(){const m=FRAME_MARGIN*scale;const inset=m*0.42;const tl={x:m-inset,y:m-inset};const w=table.length*scale+inset*2;const h=table.width*scale+inset*2;roundRectPath(ctx,tl.x,tl.y,w,h,10);const grad=ctx.createLinearGradient(tl.x,tl.y,tl.x,tl.y+h);grad.addColorStop(0,'#1d3b28');grad.addColorStop(0.5,'#16301f');grad.addColorStop(1,'#122718');ctx.fillStyle=grad;ctx.fill();ctx.strokeStyle='rgba(0,0,0,0.45)';ctx.lineWidth=1;ctx.stroke();}
function drawFelt(){const tl=toPx({x:0,y:table.width});const br=toPx({x:table.length,y:0});const w=br.x-tl.x;const h=br.y-tl.y;const grad=ctx.createRadialGradient(
tl.x+w*0.34,tl.y+h*0.3,Math.min(w,h)*0.05,
tl.x+w*0.5,tl.y+h*0.55,Math.max(w,h)*0.78
);grad.addColorStop(0,'#157a49');grad.addColorStop(0.55,'#0f5c37');grad.addColorStop(1,'#0a3f26');ctx.fillStyle=grad;ctx.fillRect(tl.x,tl.y,w,h);const depth=Math.max(4,Math.min(14,Math.min(w,h)*0.045));const edges=[
[tl.x,tl.y,w,depth,0,0,0,1],
[tl.x,tl.y+h-depth,w,depth,0,0,0,-1],
[tl.x,tl.y,depth,h,0,0,1,0],
[tl.x+w-depth,tl.y,depth,h,0,0,-1,0],
];for(const[x,y,ew,eh,gx0,gy0,gx1,gy1]of edges){const g=ctx.createLinearGradient(
x+(gx0?0:gx1?ew:0),
y+(gy0?0:gy1?eh:0),
x+(gx0?0:gx1?0:0),
y+(gy0?0:gy1?0:0)
);g.addColorStop(0,'rgba(0,0,0,0.42)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect(x,y,ew,eh);}
ctx.save();ctx.beginPath();ctx.rect(tl.x,tl.y,w,h);ctx.clip();ctx.strokeStyle='rgba(255,255,255,0.018)';ctx.lineWidth=1;for(let x=-h;x<w;x+=7){ctx.beginPath();ctx.moveTo(tl.x+x,tl.y);ctx.lineTo(tl.x+x+h,tl.y+h);ctx.stroke();}
ctx.restore();}
function drawMarkings(){const hs=table.length/4;const fs=(table.length*3)/4;ctx.strokeStyle='rgba(255,255,255,0.10)';ctx.lineWidth=1;const a=toPx({x:hs,y:0});const b=toPx({x:hs,y:table.width});ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();for(const spot of[{x:fs,y:table.width/2},{x:table.length/2,y:table.width/2}]){const p=toPx(spot);ctx.beginPath();ctx.arc(p.x,p.y,Math.max(1.5,0.006*scale),0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,0.16)';ctx.fill();}}
function drawDiamonds(){const size=Math.max(2.2,Math.min(5,FRAME_MARGIN*scale*0.24));const spots=[];for(let i=1;i<8;i++){const x=(table.length*i)/8;spots.push({x,y:table.width+FRAME_MARGIN*0.5});spots.push({x,y:-FRAME_MARGIN*0.5});}
for(let i=1;i<4;i++){const y=(table.width*i)/4;spots.push({x:-FRAME_MARGIN*0.5,y});spots.push({x:table.length+FRAME_MARGIN*0.5,y});}
ctx.fillStyle='rgba(255,236,205,0.62)';for(const s of spots){const p=toPx(s);ctx.beginPath();ctx.moveTo(p.x,p.y-size);ctx.lineTo(p.x+size,p.y);ctx.lineTo(p.x,p.y+size);ctx.lineTo(p.x-size,p.y);ctx.closePath();ctx.fill();}}
function drawPockets(){for(const p of table.pockets){const c=toPx(p);const r=p.captureR*scale;ctx.beginPath();ctx.arc(c.x,c.y,r*1.24,0,Math.PI*2);ctx.fillStyle='#241309';ctx.fill();const g=ctx.createRadialGradient(c.x,c.y,r*0.1,c.x,c.y,r*1.05);g.addColorStop(0,'#000000');g.addColorStop(0.72,'#04070a');g.addColorStop(1,'#101820');ctx.beginPath();ctx.arc(c.x,c.y,r*1.02,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();ctx.beginPath();ctx.arc(c.x,c.y,r*1.12,Math.PI*1.06,Math.PI*1.94);ctx.strokeStyle='rgba(255,220,180,0.20)';ctx.lineWidth=Math.max(1,r*0.1);ctx.stroke();}}
function drawTable3D(){const w=canvas.width/dpr;const h=canvas.height/dpr;const L=table.length;const W=table.width;const Mc=FRAME_MARGIN*0.42;const Mw=FRAME_MARGIN;const geom=tableGeometry();const screen=screenGradients(w,h);const bgAlpha=Math.min(1,Math.max(0,(camera.t-0.02)/0.35));if(bgAlpha>0){ctx.save();ctx.globalAlpha=bgAlpha;ctx.fillStyle=screen.bg;ctx.fillRect(0,0,w,h);ctx.fillStyle=screen.lamp;ctx.fillRect(0,0,w,h);ctx.restore();}
for(const face of geom.apronFaces){drawProjectedPolygon(face,'#35200f','rgba(0,0,0,0.65)',1);}
const woodGrad=screen.wood;for(const r of geom.woodRails){drawProjectedPolygon(r,woodGrad,'rgba(0,0,0,0.5)',1);}
for(let i=1;i<=12;i++){const ratio=i/13;const yNear=-Mw+(Mw-Mc)*ratio;const yFar=W+Mc+Mw*ratio;for(const y of[yNear,yFar]){const a=project(-Mw*0.8,y,0.001);const b=project(L+Mw*0.8,y,0.001);if(a.behind||b.behind)continue;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=i%3===0?'rgba(0,0,0,0.12)':'rgba(255,215,165,0.055)';ctx.lineWidth=0.7;ctx.stroke();}}
ctx.fillStyle='rgba(255, 236, 205, 0.75)';for(const s of geom.spots){const p=project(s.x,s.y,0.005);if(p.behind)continue;const sz=Math.max(1.8,3.2*(p.scale/scale));ctx.beginPath();ctx.moveTo(p.x,p.y-sz);ctx.lineTo(p.x+sz,p.y);ctx.lineTo(p.x,p.y+sz);ctx.lineTo(p.x-sz,p.y);ctx.closePath();ctx.fill();}
const cushGrad=screen.cush;for(const c of geom.cushionBands){drawProjectedPolygon(c,cushGrad,'rgba(0,0,0,0.6)',1.2);}
const feltPoly=geom.feltPoly;const pCenter=project(L*0.5,W*0.5,0);const feltR=Math.max(w,h)*0.75;const feltGrad=feltGradient(pCenter.x,pCenter.y,feltR);drawProjectedPolygon(feltPoly,feltGrad,'rgba(0,0,0,0.4)',1);ctx.save();ctx.beginPath();const fc0=project(feltPoly[0].x,feltPoly[0].y,0);ctx.moveTo(fc0.x,fc0.y);for(let i=1;i<feltPoly.length;i++){const p=project(feltPoly[i].x,feltPoly[i].y,0);ctx.lineTo(p.x,p.y);}
ctx.closePath();ctx.clip();for(const fiber of FELT_FIBERS){const x=fiber.x*L;const y=fiber.y*W;const dx=Math.cos(fiber.angle)*fiber.length;const dy=Math.sin(fiber.angle)*fiber.length;const a=project(x,y,0.001);const b=project(x+dx,y+dy,0.001);if(a.behind||b.behind)continue;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=`rgba(211,255,225,${fiber.alpha})`;ctx.lineWidth=Math.max(0.35,Math.min(1,a.scale*fiber.length*0.16));ctx.stroke();}
ctx.restore();const hs=L/4;const pa=project(hs,0,0);const pb=project(hs,W,0);if(!pa.behind&&!pb.behind){ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.strokeStyle='rgba(255, 255, 255, 0.12)';ctx.lineWidth=1;ctx.stroke();}
const fs=(L*3)/4;for(const spot of[{x:fs,y:W/2},{x:L/2,y:W/2}]){const p=project(spot.x,spot.y,0);if(!p.behind){ctx.beginPath();ctx.arc(p.x,p.y,Math.max(1.5,2.5*(p.scale/scale)),0,Math.PI*2);ctx.fillStyle='rgba(255, 255, 255, 0.20)';ctx.fill();}}
for(const p of table.pockets){const proj=project(p.x,p.y,0);if(proj.behind)continue;const r=p.captureR*proj.scale;ctx.beginPath();ctx.arc(proj.x,proj.y,r*1.22,0,Math.PI*2);ctx.fillStyle='#211208';ctx.fill();const g=pocket3DGradient();ctx.beginPath();ctx.arc(proj.x,proj.y,r*1.02,0,Math.PI*2);fillUnitGradient(g,proj.x,proj.y,r);ctx.beginPath();ctx.arc(proj.x,proj.y,r*1.1,Math.PI*1.05,Math.PI*1.95);ctx.strokeStyle='rgba(255, 225, 185, 0.22)';ctx.lineWidth=Math.max(1,r*0.08);ctx.stroke();}}
function buildTableCache(){const totalW=(table.length+FRAME_MARGIN*2)*scale;const totalH=(table.width+FRAME_MARGIN*2)*scale;const cacheDpr=dpr;const offscreen=document.createElement('canvas');offscreen.width=Math.round(totalW*cacheDpr);offscreen.height=Math.round(totalH*cacheDpr);const offCtx=offscreen.getContext('2d');offCtx.setTransform(cacheDpr,0,0,cacheDpr,0,0);const savedCtx=ctx;ctx=offCtx;drawWood(totalW,totalH);drawDiamonds();drawCushionBand();drawFelt();drawMarkings();drawPockets();ctx=savedCtx;tableCache=offscreen;tableCacheKey=`${table.preset}:${scale}:${cacheDpr}`;}
function drawTable(){computeCurrentCamera();if(camera.t<=0.0001){const cacheKey=`${table.preset}:${scale}:${dpr}`;if(!tableCache||tableCacheKey!==cacheKey){buildTableCache();}
ctx.drawImage(tableCache,0,0,tableCache.width,tableCache.height,
0,0,tableCache.width/dpr,tableCache.height/dpr);}else{drawTable3D();}}
function drawStripeBand(cx,cy,r,color,angle){ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.clip();ctx.translate(cx,cy);ctx.rotate(angle);ctx.scale(r,r);ctx.fillStyle=stripeGradient(color);ctx.fillRect(-1.1,-0.67,2.2,1.34);ctx.restore();}
function drawBall(b,opts={}){const style=ballStyle(b.number??0);const proj=project(b.x,b.y,table.ballRadius);if(proj.behind)return;const c={x:proj.x,y:proj.y};const r=Math.max(2.5,table.ballRadius*proj.scale);const lift=opts.lift??0;const projShadow=project(b.x,b.y,0);if(!projShadow.behind){ctx.save();ctx.translate(projShadow.x+r*0.14,projShadow.y+r*0.24+lift);ctx.scale(r*0.96,r*0.72);ctx.beginPath();ctx.arc(0,0,1,0,Math.PI*2);ctx.fillStyle=ballShadowGradient();ctx.fill();ctx.restore();}
const cy=c.y-lift;const rollAngle=((b.rollAngle??0)%(Math.PI*2)+Math.PI*2)%(Math.PI*2);if(style.stripe){ctx.beginPath();ctx.arc(c.x,cy,r,0,Math.PI*2);ctx.fillStyle='#f4f1e8';ctx.fill();drawStripeBand(c.x,cy,r,style.color,stripeAngle(b)+rollAngle);}else{ctx.beginPath();ctx.arc(c.x,cy,r,0,Math.PI*2);ctx.fillStyle=style.color;ctx.fill();}
ctx.beginPath();ctx.arc(c.x,cy,r,0,Math.PI*2);fillUnitGradient(ballBodyGradient(),c.x,cy,r);if(b.number>0&&r>6&&Math.cos(rollAngle)>-0.02){const facing=Math.max(0.08,Math.cos(rollAngle));const rollDistance=-Math.sin(rollAngle)*table.ballRadius;const badge=rollAngle>1e-6
?project(
b.x+(b.rollDirX??0)*rollDistance,
b.y+(b.rollDirY??0)*rollDistance,
table.ballRadius*(1+facing)
)
:{x:c.x,y:cy,scale:proj.scale};if(!badge.behind){ctx.beginPath();ctx.ellipse(badge.x,badge.y-lift,r*0.46*facing,r*0.46*facing,0,0,Math.PI*2);ctx.fillStyle='#fbfaf6';ctx.fill();ctx.strokeStyle='rgba(0,0,0,0.10)';ctx.lineWidth=Math.max(0.6,r*0.045);ctx.stroke();ctx.fillStyle='#12161c';ctx.font=`700 ${Math.max(4, r * 0.56 * facing)}px ui-sans-serif, system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(b.number),badge.x,badge.y-lift+r*0.04*facing);}}
ctx.beginPath();ctx.ellipse(c.x-r*0.34,cy-r*0.38,r*0.22,r*0.15,-0.6,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,0.82)';ctx.fill();ctx.beginPath();ctx.arc(c.x,cy,r,0,Math.PI*2);ctx.strokeStyle='rgba(0,0,0,0.30)';ctx.lineWidth=Math.max(0.5,r*0.05);ctx.stroke();if(opts.ghost){ctx.beginPath();ctx.arc(c.x,cy,r,0,Math.PI*2);ctx.strokeStyle='rgba(250,204,21,0.9)';ctx.lineWidth=1.6;ctx.stroke();}}
function drawCueStick(strokeOffset=0){if(camera.t<=0.12)return;const alpha=Math.min(1,(camera.t-0.12)/0.58);ctx.save();ctx.globalAlpha=alpha;const w=canvas.width/dpr;const h=canvas.height/dpr;const cueProj=project(camera.cueBall.x,camera.cueBall.y,table.ballRadius);const cueR=Math.max(12,table.ballRadius*cueProj.scale);const dockShift=(1-alpha)*40;const gap=Math.max(2,strokeOffset*350+6+dockShift);const tipY=cueProj.y+cueR+gap;const tipX=cueProj.x;const buttY=h+25+dockShift*0.5;const buttX=cueProj.x;const tipW=Math.max(8,cueR*0.32);const buttW=Math.max(26,cueR*0.95);ctx.beginPath();ctx.moveTo(tipX-tipW*0.4,tipY+4);ctx.lineTo(tipX+tipW*0.4,tipY+4);ctx.lineTo(buttX+buttW*0.4,buttY);ctx.lineTo(buttX-buttW*0.4,buttY);ctx.closePath();ctx.fillStyle='rgba(0, 0, 0, 0.40)';ctx.fill();const cue=cueGradients();ctx.beginPath();ctx.moveTo(tipX-tipW*0.5,tipY);ctx.lineTo(tipX+tipW*0.5,tipY);ctx.lineTo(buttX+buttW*0.5,buttY);ctx.lineTo(buttX-buttW*0.5,buttY);ctx.closePath();fillCueGradient(cue.shaft,tipX,buttW);ctx.strokeStyle='rgba(255, 255, 255, 0.32)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tipX-tipW*0.1,tipY);ctx.lineTo(buttX-buttW*0.1,buttY);ctx.stroke();const wrapStartY=tipY+(buttY-tipY)*0.55;const wrapW=tipW+(buttW-tipW)*0.55;ctx.beginPath();ctx.moveTo(tipX-wrapW*0.5,wrapStartY);ctx.lineTo(tipX+wrapW*0.5,wrapStartY);ctx.lineTo(buttX+buttW*0.5,buttY);ctx.lineTo(buttX-buttW*0.5,buttY);ctx.closePath();fillCueGradient(cue.wrap,tipX,buttW);ctx.strokeStyle='rgba(255, 255, 255, 0.10)';ctx.lineWidth=1;for(let y=wrapStartY;y<buttY;y+=6){const curW=tipW+((buttW-tipW)*(y-tipY))/(buttY-tipY);ctx.beginPath();ctx.moveTo(tipX-curW*0.48,y);ctx.lineTo(tipX+curW*0.48,y);ctx.stroke();}
const ferruleH=Math.max(12,cueR*0.36);ctx.beginPath();ctx.moveTo(tipX-tipW*0.5,tipY);ctx.lineTo(tipX+tipW*0.5,tipY);ctx.lineTo(tipX+tipW*0.54,tipY+ferruleH);ctx.lineTo(tipX-tipW*0.54,tipY+ferruleH);ctx.closePath();fillCueGradient(cue.ferrule,tipX,tipW);const tipH=Math.max(6,cueR*0.18);ctx.beginPath();ctx.moveTo(tipX-tipW*0.48,tipY);ctx.bezierCurveTo(tipX-tipW*0.48,tipY-tipH,tipX+tipW*0.48,tipY-tipH,tipX+tipW*0.48,tipY);ctx.closePath();fillCueGradient(cue.tip,tipX,tipW);ctx.restore();}
function draw1stPersonHUD(aimInfo){if(camera.t<=0.22)return;const alpha=Math.min(1,(camera.t-0.22)/0.58);ctx.save();ctx.globalAlpha=alpha;const w=canvas.width/dpr;if(aimInfo){const text=aimInfo.title||'第一人称瞄准模式';const sub=aimInfo.detail||'';ctx.font='600 13px ui-sans-serif, system-ui, sans-serif';const fullText='🎯 '+text+(sub?'  ·  '+sub:'');const tw=ctx.measureText(fullText).width;const bw=Math.max(260,tw+36);const bh=34;const bx=(w-bw)/2;const by=22;roundRectPath(ctx,bx,by,bw,bh,17);ctx.fillStyle='rgba(15, 23, 42, 0.88)';ctx.fill();ctx.strokeStyle='rgba(56, 189, 248, 0.55)';ctx.lineWidth=1;ctx.stroke();ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#38bdf8';ctx.fillText(fullText,w/2,by+bh/2);}
if(aimInfo?.ghost){const gProj=project(aimInfo.ghost.x,aimInfo.ghost.y,table.ballRadius);if(!gProj.behind){const gx=gProj.x;const gy=gProj.y;const gr=Math.max(9,table.ballRadius*gProj.scale);ctx.beginPath();ctx.arc(gx,gy,gr,0,Math.PI*2);ctx.strokeStyle='rgba(250, 204, 21, 0.85)';ctx.lineWidth=1.6;ctx.setLineDash([4,4]);ctx.stroke();ctx.setLineDash([]);const tick=gr*0.42;ctx.strokeStyle='rgba(56, 189, 248, 0.95)';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(gx-gr-tick,gy);ctx.lineTo(gx-gr+2,gy);ctx.moveTo(gx+gr-2,gy);ctx.lineTo(gx+gr+tick,gy);ctx.moveTo(gx,gy-gr-tick);ctx.lineTo(gx,gy-gr+2);ctx.moveTo(gx,gy+gr-2);ctx.lineTo(gx,gy+gr+tick);ctx.stroke();ctx.beginPath();ctx.arc(gx,gy,2.5,0,Math.PI*2);ctx.fillStyle='#f59e0b';ctx.fill();}}
ctx.restore();}
return{ctx,
toPx,
toWorld,
project,
setCamera,
getCamera,
drawCueStick,
draw1stPersonHUD,
fit,
clear,
drawTable,
drawBall,
setTable(next){table=next;tableCache=null;resetGradients();},
get table(){return table;},
get scale(){return scale;},
get offset(){return offset;},};}
function stripeAngle(b){const id=String(b.id??b.number??'');let h=0;for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return((h%628)/100)-Math.PI;}
function shade(hex,k){const h=String(hex).replace('#','');const r=parseInt(h.slice(0,2),16);const g=parseInt(h.slice(2,4),16);const b=parseInt(h.slice(4,6),16);const f=(v)=>Math.max(0,Math.min(255,Math.round(k<0?v*(1+k):v+(255-v)*k)));return`rgb(${f(r)}, ${f(g)}, ${f(b)})`;}
const SHARE_TARGET_LINE='rgba(250, 204, 21, 0.95)';const SHARE_CUE_LINE='rgba(16, 185, 129, 0.95)';const SHARE_REST_FILL='rgba(56, 189, 248, 0.22)';const SHARE_REST_STROKE='#38bdf8';const SHARE_SCRATCH_STROKE='rgba(248, 113, 113, 0.95)';const SHARE_MARK_STROKE='rgba(125, 211, 252, 0.95)';const SHARE_CUE_MARK='rgba(255, 255, 255, 0.92)';const SHARE_LABEL_FONT='"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';export function createShareScene({table,balls,shot,mark,maxWidth=984}={}){if(!table)return null;const canvas=document.createElement('canvas');const view=createRenderer({canvas,table});const{w,h}=view.fit(maxWidth,maxWidth);view.setCamera({t:0});view.clear();view.drawTable();const list=Array.isArray(balls)?balls:[];const candidate=shot&&typeof shot==='object'?shot:null;const marks=mark&&typeof mark==='object'?mark:null;if(candidate)drawShareGuides(view,table,list,candidate);if(marks)drawShareMarks(view,table,list,marks,{w,h});for(const b of list){if(!b||typeof b!=='object'||b.pocketed===true)continue;view.drawBall(b);}
return{canvas,width:Math.round(w),height:Math.round(h)};}
function drawShareMarks(view,table,balls,mark,box){const ctx=view.ctx;const r=Math.max(2.5,table.ballRadius*view.scale);const numbers=Array.isArray(mark.numbers)?mark.numbers:[];if(numbers.length){ctx.save();ctx.setLineDash([8,6]);ctx.lineWidth=3;ctx.strokeStyle=SHARE_MARK_STROKE;for(const b of balls){if(!b||typeof b!=='object'||b.pocketed===true)continue;if(!numbers.includes(b.number))continue;const p=view.project(b.x,b.y);ctx.beginPath();ctx.arc(p.x,p.y,r*1.55,0,Math.PI*2);ctx.stroke();}
ctx.restore();}
const cue=cueBallOf(balls);if(!cue)return;const p=view.project(cue.x,cue.y);ctx.save();ctx.setLineDash([4,5]);ctx.lineWidth=2.5;ctx.strokeStyle=SHARE_CUE_MARK;ctx.beginPath();ctx.arc(p.x,p.y,r*1.95,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);const fontSize=Math.max(15,Math.round(r*1.6));ctx.font=`600 ${fontSize}px ${SHARE_LABEL_FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';const label='母球';const boxW=Math.round(ctx.measureText(label).width)+14;const boxH=Math.round(fontSize*1.45);const cx=Math.min(Math.max(p.x,boxW/2+2),(box.w||0)-boxW/2-2);let top=p.y+r*2.4;if(Number.isFinite(box.h)&&top+boxH>box.h-2)top=p.y-r*2.4-boxH;ctx.fillStyle='rgba(11, 18, 25, 0.86)';roundRectPath(ctx,cx-boxW/2,top,boxW,boxH,6);ctx.fill();ctx.fillStyle=SHARE_CUE_MARK;ctx.fillText(label,cx,top+boxH/2);ctx.restore();}
function drawShareGuides(view,table,balls,c){const ctx=view.ctx;const target=shareBallOf(balls,c);const pocket=sharePocketOf(table,c.pocketId);if(target&&pocket){const a=view.project(target.x,target.y);const b=view.project(pocket.x,pocket.y);ctx.save();ctx.setLineDash([10,8]);ctx.lineWidth=3;ctx.strokeStyle=SHARE_TARGET_LINE;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=3;ctx.beginPath();ctx.arc(b.x,b.y,Math.max(9,table.ballRadius*view.scale*1.5),0,Math.PI*2);ctx.stroke();ctx.restore();}
const ghost=c.ghost;const hasGhost=
ghost&&typeof ghost==='object'&&Number.isFinite(ghost.x)&&Number.isFinite(ghost.y);if(!hasGhost)return;const g=view.project(ghost.x,ghost.y);const r=Math.max(2.5,table.ballRadius*view.scale);ctx.save();ctx.setLineDash([]);ctx.lineWidth=3;ctx.strokeStyle='rgba(255, 255, 255, 0.75)';ctx.beginPath();ctx.arc(g.x,g.y,r,0,Math.PI*2);ctx.stroke();const cue=cueBallOf(balls);const rest=c.cuePath&&c.cuePath.kind==='pocket'?null:c.cueRest;if(cue){const from=view.project(cue.x,cue.y);ctx.strokeStyle=
c.cuePath&&c.cuePath.kind==='pocket'?SHARE_SCRATCH_STROKE:SHARE_CUE_LINE;ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(g.x,g.y);ctx.stroke();}
if(rest&&Number.isFinite(rest.x)&&Number.isFinite(rest.y)){const p=view.project(rest.x,rest.y);ctx.setLineDash([7,6]);ctx.lineWidth=3;ctx.fillStyle=SHARE_REST_FILL;ctx.strokeStyle=SHARE_REST_STROKE;ctx.beginPath();ctx.arc(p.x,p.y,r*1.35,0,Math.PI*2);ctx.fill();ctx.stroke();}
ctx.restore();}
function shareBallOf(balls,c){if(!Array.isArray(balls))return null;for(const b of balls){if(!b||typeof b!=='object'||b.pocketed===true)continue;if(typeof c.targetId==='string'&&b.id===c.targetId)return b;}
for(const b of balls){if(!b||typeof b!=='object'||b.pocketed===true)continue;if(typeof c.targetNumber==='number'&&b.number===c.targetNumber)return b;}
return null;}
function sharePocketOf(table,pocketId){if(!pocketId||!Array.isArray(table.pockets))return null;for(const p of table.pockets){if(p&&p.id===pocketId)return p;}
return null;}
function cueBallOf(balls){if(!Array.isArray(balls))return null;for(const b of balls){if(b&&typeof b==='object'&&b.pocketed!==true&&(b.number===0||b.id==='cue')){return b;}}
return null;}
