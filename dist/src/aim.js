import{V,DEG}from'./geometry.js';export function rotate(v,a){const c=Math.cos(a);const s=Math.sin(a);return{x:v.x*c-v.y*s,y:v.x*s+v.y*c};}
export function signedAngle(a,b){return Math.atan2(V.cross(a,b),V.dot(a,b));}
export function ghostBallPosition(target,pocket,R){const dir=V.norm(V.sub(pocket,target));return{x:target.x-dir.x*2*R,y:target.y-dir.y*2*R};}
export function cutAngleDeg(cue,ghost,target,pocket){const inDir=V.norm(V.sub(ghost,cue));const outDir=V.norm(V.sub(pocket,target));return Math.acos(Math.max(-1,Math.min(1,V.dot(inDir,outDir))))*DEG;}
export function objectBallAfterImpact(vDir,speed,n,params){const t={x:-n.y,y:n.x};const vn=speed*V.dot(vDir,n);if(vn<=1e-9)return null;const jn=((1+params.ballRestitution)/2)*vn;const ut=speed*V.dot(vDir,t);const jt=Math.sign(ut)*Math.min(params.ballFriction*jn,(2/7)*Math.abs(ut));const vx=jn*n.x+jt*t.x;const vy=jn*n.y+jt*t.y;const len=Math.hypot(vx,vy);if(len<1e-12)return null;const dir={x:vx/len,y:vy/len};return{dir,speed:len,throwDeg:signedAngle(n,dir)*DEG};}
export function solveContactNormal(cue,target,outDir,speed,R,params,iterations=6){let n={x:outDir.x,y:outDir.y};let ghost={x:target.x-2*R*n.x,y:target.y-2*R*n.y};let throwDeg=0;for(let i=0;i<iterations;i++){ghost={x:target.x-2*R*n.x,y:target.y-2*R*n.y};const vDir=V.norm(V.sub(ghost,cue));const res=objectBallAfterImpact(vDir,speed,n,params);if(!res)break;throwDeg=res.throwDeg;const err=signedAngle(outDir,res.dir);if(Math.abs(err)<1e-7)break;n=rotate(n,-err);const l=Math.hypot(n.x,n.y)||1;n={x:n.x/l,y:n.y/l};}
ghost={x:target.x-2*R*n.x,y:target.y-2*R*n.y};return{normal:n,ghost,throwDeg};}
export function firstBlocker(from,to,balls,ignoreIds,R){let best=null;let bestD=Infinity;for(const b of balls){if(b.pocketed||ignoreIds.includes(b.id))continue;if(pointSegmentDistance(b,from,to)-2*R<-1e-9){const d=V.dist(from,b);if(d<bestD){bestD=d;best=b;}}}
return best;}
export function pointSegmentDistance(p,a,b){const abx=b.x-a.x;const aby=b.y-a.y;const apx=p.x-a.x;const apy=p.y-a.y;const denom=abx*abx+aby*aby;if(denom<1e-12)return Math.hypot(apx,apy);let t=(apx*abx+apy*aby)/denom;t=t<0?0:t>1?1:t;return Math.hypot(apx-abx*t,apy-aby*t);}
export function aimToleranceDeg(cue,ghost,target,pocket,pocketCaptureR,R){const d1=V.dist(cue,ghost);const d2=V.dist(target,pocket);if(d1<1e-6||d2<1e-6)return 0;const lateralTol=Math.max(R*0.2,pocketCaptureR-R);const dPhi=Math.atan2(lateralTol,d2);const ghostOffset=2*R*dPhi;return Math.atan2(ghostOffset,Math.max(d1,2*R))*DEG;}
export function cueBallTangentDirection(inDir,outDir){const proj=V.dot(inDir,outDir);return V.norm(V.sub(inDir,V.mul(outDir,proj)));}
export function cueBallTravelAfter(approachSpeed,muRoll,g){const decel=muRoll*g;if(decel<=0)return Infinity;return(approachSpeed*approachSpeed)/(2*decel);}
export function comboAimPoints(cue,mid,target,pocket,R,params,speed){const outDir=V.norm(V.sub(pocket,target));const probe2=solveContactNormal(mid,target,outDir,speed,R,params);if(!probe2)return null;const gB=probe2.ghost;const midOutDir=V.norm(V.sub(gB,mid));if(!Number.isFinite(midOutDir.x)||!Number.isFinite(midOutDir.y))return null;const probe1=solveContactNormal(cue,mid,midOutDir,speed,R,params);if(!probe1)return null;const gA=probe1.ghost;return{gA,
gB,
midOutDir,
cut1:Math.acos(
Math.max(-1,Math.min(1,V.dot(V.norm(V.sub(gA,cue)),midOutDir)))
)*DEG,
cut2:Math.acos(Math.max(-1,Math.min(1,V.dot(midOutDir,outDir))))*DEG,
throw1:probe1.throwDeg,
throw2:probe2.throwDeg,};}
export function pocketMirror(pocket,rail,table){const b=table.bounds;if(rail==='xmin')return{x:2*b.minX-pocket.x,y:pocket.y};if(rail==='xmax')return{x:2*b.maxX-pocket.x,y:pocket.y};if(rail==='ymin')return{x:pocket.x,y:2*b.minY-pocket.y};if(rail==='ymax')return{x:pocket.x,y:2*b.maxY-pocket.y};return null;}
export function bankSeedDirection(target,pocket,rail,table){const m=pocketMirror(pocket,rail,table);if(!m)return null;const d=V.sub(m,target);const len=Math.hypot(d.x,d.y);if(len<1e-9)return null;return{dir:{x:d.x/len,y:d.y/len},mirror:m};}
export function traceRay(from,dir,travel,table){const R=table.ballRadius;const steps=200;const stepLen=travel/steps;for(let i=1;i<=steps;i++){const p={x:from.x+dir.x*stepLen*i,y:from.y+dir.y*stepLen*i};const pk=table.pocketAt(p.x,p.y);if(pk)return{point:p,kind:'pocket',pocketId:pk.id};if(p.x<R||p.x>table.length-R||p.y<R||p.y>table.width-R){return{point:p,kind:'cushion'};}}
return{point:{x:from.x+dir.x*travel,y:from.y+dir.y*travel},
kind:'open',};}
