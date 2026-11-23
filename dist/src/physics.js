import{PHYS,FIXED_DT,MAX_SHOT_TIME}from'./constants.js';const SLIP_EPS=1e-4;const RAIL_EVENT_SPEED=0.015;const MIN_CAPTURE_R=0.063;const SIDE_SPIN_EFFECT=0.15;const MU_SLIDE_G=PHYS.muSlide*PHYS.g;const SLIDE_DECEL=3.5*PHYS.muSlide*PHYS.g;const MU_ROLL_G=PHYS.muRoll*PHYS.g;const SPIN_RATE_NUM=5*PHYS.muSpin*PHYS.g;const STOP_SPEED=PHYS.stopSpeed;const SLIP_EPS2=SLIP_EPS*SLIP_EPS;export function createBall(id,x,y,extra={}){return{id,
x,
y,
vx:0,
vy:0,
wx:0,
wy:0,
wz:0,
pocketed:false,
color:'#ffffff',
...extra,};}
export function isCueBall(ball){if(!ball)return false;return ball.number===0||ball.id==='cue';}
export function createRollTracker(balls,radius){const previous=balls.map(({x,y})=>({x,y}));const angles=balls.map((ball)=>ball.rollAngle??0);const directions=balls.map((ball)=>({x:ball.rollDirX??0,
y:ball.rollDirY??0,}));return()=>balls.map((ball,index)=>{const dx=ball.x-previous[index].x;const dy=ball.y-previous[index].y;const distance=Math.hypot(dx,dy);if(distance>1e-9){angles[index]+=distance/radius;directions[index]={x:dx/distance,y:dy/distance};}
previous[index]={x:ball.x,y:ball.y};return{rollAngle:angles[index],
rollDirX:directions[index].x,
rollDirY:directions[index].y,};});}
export function createWorld(table,balls){for(const b of balls)b.__R=table.ballRadius;return{table,balls,t:0};}
export function cloneWorld(world){return{table:world.table,
t:world.t,
balls:world.balls.map((b)=>({...b})),};}
export function ballSpeed(b){return Math.sqrt(b.vx*b.vx+b.vy*b.vy);}
export function allStopped(world){const balls=world.balls;for(let i=0;i<balls.length;i++){const b=balls[i];if(!b.pocketed&&(b.vx!==0||b.vy!==0))return false;}
return true;}
export function slipOf(b){const R=b.__R;return{x:b.vx-R*b.wy,y:b.vy+R*b.wx};}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}
export function strike(ball,{angle,speed,tip={a:0,b:0}}){const R=ball.__R;const a=clamp(tip.a??0,-0.5,0.5);const b=clamp(tip.b??0,-0.5,0.5);const cos=Math.cos(angle);const sin=Math.sin(angle);const k=(5*speed)/(2*R);ball.vx=speed*cos;ball.vy=speed*sin;ball.wx=k*b*-sin;ball.wy=k*b*cos;ball.wz=-k*a;return ball;}
export function advanceBall(b,tau){const R=b.__R;let x=b.x;let y=b.y;let vx=b.vx;let vy=b.vy;let wx=b.wx;let wy=b.wy;let wz=b.wz;let remaining=tau;let guard=0;while(remaining>1e-12&&guard++<8){const ux=vx-R*wy;const uy=vy+R*wx;const u2=ux*ux+uy*uy;if(u2>SLIP_EPS2){const uLen=Math.sqrt(u2);const k5=5/(2*R);const muSlide=PHYS.muSlide;const grav=PHYS.g;const tRoll=uLen/SLIDE_DECEL;const dt=Math.min(remaining,tRoll);const nx=ux/uLen;const ny=uy/uLen;const ax=-MU_SLIDE_G*nx;const ay=-MU_SLIDE_G*ny;x+=vx*dt+0.5*ax*dt*dt;y+=vy*dt+0.5*ay*dt*dt;vx+=ax*dt;vy+=ay*dt;const alpha=k5*muSlide*grav;wx+=-alpha*ny*dt;wy+=alpha*nx*dt;if(wz!==0){const drop=(SPIN_RATE_NUM/(2*R))*dt;if(Math.abs(wz)<=drop)wz=0;else wz-=Math.sign(wz)*drop;}
remaining-=dt;if(dt>=tRoll){wy=vx/R;wx=-vy/R;}
continue;}
const v=Math.sqrt(vx*vx+vy*vy);if(v<STOP_SPEED){vx=0;vy=0;wx=0;wy=0;if(wz!==0){const drop=(SPIN_RATE_NUM/(2*R))*remaining;if(Math.abs(wz)<=drop)wz=0;else wz-=Math.sign(wz)*drop;}
break;}
const tStop=v/MU_ROLL_G;const dt=Math.min(remaining,tStop);const nx=vx/v;const ny=vy/v;const ax=-MU_ROLL_G*nx;const ay=-MU_ROLL_G*ny;x+=vx*dt+0.5*ax*dt*dt;y+=vy*dt+0.5*ay*dt*dt;vx+=ax*dt;vy+=ay*dt;if(dt>=tStop){vx=0;vy=0;wx=0;wy=0;}else{wy=vx/R;wx=-vy/R;}
if(wz!==0){const drop=(SPIN_RATE_NUM/(2*R))*dt;if(Math.abs(wz)<=drop)wz=0;else wz-=Math.sign(wz)*drop;}
remaining-=dt;}
b.x=x;b.y=y;b.vx=vx;b.vy=vy;b.wx=wx;b.wy=wy;b.wz=wz;}
export function cushionTOI(ball,cushion,horizon){const R=ball.__R;const{axis,pos,normal}=cushion;const p=axis==='x'?ball.x:ball.y;const v=axis==='x'?ball.vx:ball.vy;const n=axis==='x'?normal.x:normal.y;const gap=(p-pos)*n-R;const closing=-(v*n);if(closing<=1e-9)return-1;if(gap<=0)return 0;const t=gap/closing;return t<=horizon?t:-1;}
export function ballTOI(a,b,horizon){const R=a.__R;const dx=b.x-a.x;const dy=b.y-a.y;const dvx=b.vx-a.vx;const dvy=b.vy-a.vy;const A=dvx*dvx+dvy*dvy;if(A<1e-12)return-1;const B=2*(dx*dvx+dy*dvy);if(B>=0)return-1;const C=dx*dx+dy*dy-4*R*R;if(C<=0)return 0;const disc=B*B-4*A*C;if(disc<0)return-1;const t=(-B-Math.sqrt(disc))/(2*A);if(t<0||t>horizon)return-1;return t;}
const EVENT_SCRATCH={t:0,kind:'',ball:null,cushion:null,a:null,b:null};let pruneHits=0;export function pruneHitCount(){return pruneHits;}
export function resetPruneHitCount(){pruneHits=0;}
export function findFirstEvent(world,horizon,buffer=EVENT_SCRATCH){const table=world.table;const balls=world.balls;const n=balls.length;const cushions=table.cushions;const cushionCount=cushions.length;const tableLength=table.length;const tableWidth=table.width;const accelBound=PHYS.muSlide*PHYS.g;const slack=0.5*accelBound*horizon*horizon+1e-9;const slack2=slack+slack;let hasBest=false;let bestIsCushion=false;let bestT=0;for(let i=0;i<n;i++){const a=balls[i];if(a.pocketed)continue;const avx=a.vx;const avy=a.vy;if(avx===0&&avy===0)continue;const R=a.__R;const ax=a.x;const ay=a.y;const dxMax=Math.abs(avx)*horizon+slack;const dyMax=Math.abs(avy)*horizon+slack;const nearX=!(ax-R>dxMax&&tableLength-R-ax>dxMax);const nearY=!(ay-R>dyMax&&tableWidth-R-ay>dyMax);if(nearX||nearY){for(let ci=0;ci<cushionCount;ci++){const c=cushions[ci];const axisX=c.axis==='x';if(axisX?!nearX:!nearY)continue;const p=axisX?ax:ay;const v=axisX?avx:avy;const nrm=axisX?c.normal.x:c.normal.y;const closing=-(v*nrm);if(closing<=1e-9)continue;const gap=(p-c.pos)*nrm-R;let t=0;if(gap>0){t=gap/closing;if(t>horizon)continue;}
if(hasBest&&(t>bestT||(t===bestT&&bestIsCushion)))continue;const along=axisX?ay+avy*t:ax+avx*t;if(along<c.from-1e-9||along>c.to+1e-9)continue;hasBest=true;bestIsCushion=true;bestT=t;buffer.t=t;buffer.kind='cushion';buffer.ball=a;buffer.cushion=c;}}else{pruneHits++;}
const twoR=R+R;const fourRSq=4*R*R;const reachX=twoR+Math.abs(avx)*horizon+slack2;const reachY=twoR+Math.abs(avy)*horizon+slack2;for(let j=0;j<n;j++){const b=balls[j];if(b===a||b.pocketed)continue;const bvx=b.vx;const bvy=b.vy;const dx=b.x-ax;const limX=bvx===0?reachX:reachX+Math.abs(bvx)*horizon;if(dx>limX||dx<-limX)continue;const dy=b.y-ay;const limY=bvy===0?reachY:reachY+Math.abs(bvy)*horizon;if(dy>limY||dy<-limY)continue;const dvx=bvx-avx;const dvy=bvy-avy;const A=dvx*dvx+dvy*dvy;if(A<1e-12)continue;const B=2*(dx*dvx+dy*dvy);if(B>=0)continue;const C=dx*dx+dy*dy-fourRSq;let t=0;if(C>0){const disc=B*B-4*A*C;if(disc<0)continue;t=(-B-Math.sqrt(disc))/(2*A);if(t<0||t>horizon)continue;}
if(!hasBest||t<bestT){hasBest=true;bestIsCushion=false;bestT=t;buffer.t=t;buffer.kind='ball';buffer.a=a;buffer.b=b;}}}
return hasBest?buffer:null;}
function resolveCushion(b,cushion,events,opts={}){const R=b.__R;const{axis,pos,normal}=cushion;if(axis==='x')b.x=pos+normal.x*R;else b.y=pos+normal.y*R;const{x:nx,y:ny}=normal;const vn=b.vx*nx+b.vy*ny;if(vn>=0)return null;const tx=-ny;const ty=nx;const vt=b.vx*tx+b.vy*ty;const baseE=opts.restitution??PHYS.cushionRestitution;const maxE=opts.maxRestitution??PHYS.cushionRestitutionMax;const speedFactor=Math.min(1,Math.abs(vn)/PHYS.cushionSpeedRef);const e=baseE+(maxE-baseE)*speedFactor;const vnAfter=-e*vn;const jn=vnAfter-vn;const ut=vt*PHYS.cushionRollSlip-R*b.wz;const jtCap=Math.abs(vt-R*b.wz)*(2/7);const jt=-Math.sign(ut)*
Math.min(PHYS.cushionFriction*jn,Math.abs(ut)*(2/7),jtCap);const vtAfter=vt+jt;b.wz=b.wz*0.7-(5*jt)/(2*R);const spinKick=opts.spinKick===false
?0
:SIDE_SPIN_EFFECT*b.wz*R*Math.min(1,Math.abs(vn)/3);const vtBudget=Math.sqrt(vt*vt+(1-e*e)*vn*vn);const vtOut=clamp(vtAfter+spinKick,-vtBudget,vtBudget);b.vx=vnAfter*nx+vtOut*tx;b.vy=vnAfter*ny+vtOut*ty;if(events&&Math.abs(vn)>RAIL_EVENT_SPEED){events.push({type:'cushion',ball:b.id,rail:cushion.id,speed:Math.abs(vn)});}
return Math.abs(vn);}
function resolveBallBall(a,b,events){const R=a.__R;let nx=b.x-a.x;let ny=b.y-a.y;let d=Math.sqrt(nx*nx+ny*ny);if(d<1e-9){nx=1;ny=0;d=1e-9;}else{nx/=d;ny/=d;}
const overlap=2*R-d;if(overlap>0){a.x-=(nx*overlap)/2;a.y-=(ny*overlap)/2;b.x+=(nx*overlap)/2;b.y+=(ny*overlap)/2;}
const rvn=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rvn>=0)return null;const tx=-ny;const ty=nx;const ut=(a.vx-b.vx)*tx+(a.vy-b.vy)*ty+R*(a.wz+b.wz);const jn=(-(1+PHYS.ballRestitution)*rvn)/2;const jt=Math.sign(ut)*Math.min(PHYS.ballFriction*jn,Math.abs(ut)/7);a.vx-=jn*nx+jt*tx;a.vy-=jn*ny+jt*ty;b.vx+=jn*nx+jt*tx;b.vy+=jn*ny+jt*ty;if(Math.abs(rvn)<PHYS.contactDamping){const rvnAfter=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rvnAfter<0){a.vx-=(rvnAfter*nx)/2;a.vy-=(rvnAfter*ny)/2;b.vx+=(rvnAfter*nx)/2;b.vy+=(rvnAfter*ny)/2;}}
const dwz=-(5*jt)/(2*R);a.wz+=dwz;b.wz+=dwz;if(events)events.push({type:'ball',a:a.id,b:b.id,speed:Math.abs(rvn)});return Math.abs(rvn);}
function settlePockets(world,events){const{table,balls}=world;const{minX,maxX,minY,maxY}=table.bounds;for(let i=0;i<balls.length;i++){const b=balls[i];if(b.pocketed)continue;if(b.vx===0&&b.vy===0&&b.x>=minX&&b.x<=maxX&&b.y>=minY&&b.y<=maxY){continue;}
const p=table.pocketAt(b.x,b.y);if(p){b.pocketed=true;b.pocket=p.id;b.vx=b.vy=b.wx=b.wy=b.wz=0;if(events)events.push({type:'pocket',ball:b.id,pocket:p.id});continue;}
const rails=[];if(b.x<minX)rails.push({axis:'x',pos:0,normal:{x:1,y:0}});else if(b.x>maxX)rails.push({axis:'x',pos:table.length,normal:{x:-1,y:0}});if(b.y<minY)rails.push({axis:'y',pos:0,normal:{x:0,y:1}});else if(b.y>maxY)rails.push({axis:'y',pos:table.width,normal:{x:0,y:-1}});for(let r=0;r<rails.length;r++){const rail=rails[r];const vn=b.vx*rail.normal.x+b.vy*rail.normal.y;const speedBefore=Math.sqrt(b.vx*b.vx+b.vy*b.vy);resolveCushion(
b,
{id:'jaw',...rail},
null,
{restitution:PHYS.jawRestitution,
maxRestitution:PHYS.cushionRestitutionMax,
spinKick:false,});if(events&&vn<0&&speedBefore>RAIL_EVENT_SPEED){events.push({type:'jaw',ball:b.id,speed:speedBefore});}}}}
export function stepWorld(world,dt,events){let guard=0;let maxV=0;const balls=world.balls;for(let i=0;i<balls.length;i++){const b=balls[i];if(b.pocketed)continue;const s=b.vx*b.vx+b.vy*b.vy;if(s>maxV)maxV=s;}
if(maxV>0){const maxStep=(MIN_CAPTURE_R*0.9)/Math.sqrt(maxV);if(dt>maxStep)dt=maxStep;}
let remaining=dt;while(remaining>1e-9&&guard++<128){const hit=findFirstEvent(world,remaining,EVENT_SCRATCH);const tau=hit?Math.max(0,Math.min(hit.t,remaining)):remaining;if(tau>0){for(let i=0;i<balls.length;i++){const b=balls[i];if(b.pocketed)continue;if(b.vx!==0||b.vy!==0||b.wz!==0)advanceBall(b,tau);}
world.t+=tau;remaining-=tau;}
settlePockets(world,events);if(!hit)break;if(hit.kind==='cushion'){if(hit.ball.pocketed)continue;resolveCushion(hit.ball,hit.cushion,events);}else{if(hit.a.pocketed||hit.b.pocketed)continue;resolveBallBall(hit.a,hit.b,events);}}
return world;}
export function speedAfterDistance(v0,dist,R){const probe={x:0,y:0,vx:v0,vy:0,wx:0,wy:0,wz:0,__R:R};const dt=1/240;let travelled=0;for(let i=0;i<6000&&travelled<dist;i++){const x0=probe.x;advanceBall(probe,dt);travelled+=probe.x-x0;if(probe.vx<=0)return 0;}
return Math.hypot(probe.vx,probe.vy);}
export function speedToReach(dist,residual,R){const maxV=6.0;if(speedAfterDistance(maxV,dist,R)<residual)return Infinity;let lo=0;let hi=maxV;for(let i=0;i<32;i++){const mid=(lo+hi)/2;if(speedAfterDistance(mid,dist,R)<residual)lo=mid;else hi=mid;}
return hi;}
export function cueBallSpeedAfterTravel(v0,tipB,dist,_R){const b=clamp(tipB??0,-0.5,0.5);const muS=PHYS.muSlide*PHYS.g;const muR=PHYS.muRoll*PHYS.g;const u0=v0*(1-2.5*b);const sgn=Math.sign(u0);const tRoll=Math.abs(u0)/(3.5*muS);const vRoll=v0-sgn*muS*tRoll;const dSlide=v0*tRoll-0.5*sgn*muS*tRoll*tRoll;if(vRoll<=0)return 0;if(dist<=dSlide){const A=0.5*sgn*muS;const B=-v0;const C=dist;const disc=B*B-4*A*C;if(disc<0)return 0;const sq=Math.sqrt(disc);const roots=[(-B-sq)/(2*A),(-B+sq)/(2*A)].filter((t)=>t>0).sort((x,y)=>x-y);if(!roots.length)return 0;const v=v0-sgn*muS*roots[0];return v>0?v:0;}
const rem=dist-dSlide;const v2=vRoll*vRoll-2*muR*rem;return v2>0?Math.sqrt(v2):0;}
export function cueSpeedForImpact(dist,impactSpeed,tipB,R){if(dist<=1e-9)return impactSpeed;if(cueBallSpeedAfterTravel(12,tipB,dist,R)<impactSpeed)return Infinity;let lo=impactSpeed;let hi=12;for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(cueBallSpeedAfterTravel(mid,tipB,dist,R)<impactSpeed)lo=mid;else hi=mid;}
return hi;}
export function runShot(world,opts={}){const dt=opts.dt??FIXED_DT;const maxTime=opts.maxTime??MAX_SHOT_TIME;const events=[];let elapsed=0;while(elapsed<maxTime){const before=events.length;stepWorld(world,dt,events);if(opts.onEvent)for(let i=before;i<events.length;i++)opts.onEvent(events[i]);elapsed+=dt;if(opts.onStep)opts.onStep(world,elapsed);if(allStopped(world))break;}
return{events,time:elapsed,settled:allStopped(world)};}
