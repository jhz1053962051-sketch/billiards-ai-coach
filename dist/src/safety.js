import{SPEED,SEARCH_DT,SHOOT_MAX_TIME,MAX_CUT_DEG}from'./constants.js';import{V,DEG}from'./geometry.js';import{isCueBall}from'./physics.js';import{positionTolerance}from'./tolerance.js';import{simulateShot}from'./sim.js';const SWING_FRACTIONS=[0,0.35,-0.35,0.62,-0.62,0.82,-0.82,0.94,-0.94];export function swingOffsetsDeg(distToCue,R){const bound=(Math.asin(Math.min(1,(2*R)/Math.max(distToCue,2*R)))*180)/Math.PI;return SWING_FRACTIONS.map((f)=>f*bound);}
const SPEEDS=[SPEED.min,SPEED.soft,SPEED.medium,SPEED.firm];const SCORE_WEIGHTS={gain:0.72,foul:0.18,leave:0.1};function scoreSafety({oppTol,baseTol,fouled,cueNearPocket,cueNearestBall,R}){const gain=baseTol-oppTol;const ratio=baseTol>0.02?gain/baseTol:gain>0?1:-1;const gainScore=100*Math.max(-1,Math.min(1,ratio));const foulScore=fouled?0:100;let leaveScore=100;if(cueNearPocket)leaveScore-=45;leaveScore-=Math.max(0,1-Math.min(1,cueNearestBall/(R*6)))*55;leaveScore=Math.max(0,leaveScore);const total=
SCORE_WEIGHTS.gain*gainScore+SCORE_WEIGHTS.foul*foulScore+SCORE_WEIGHTS.leave*leaveScore;return{total:Math.round(total*10)/10,gainScore,foulScore,leaveScore};}
function shoot(table,balls,cueId,_target,aimAngle,speed){const sim=simulateShot(
table,
balls,
{cueId,angle:aimAngle,speed,tip:{a:0,b:0}},
{maxTime:SHOOT_MAX_TIME,
dt:SEARCH_DT,
rejectPocketedCue:true,});if(!sim.ok){const failed=(sim);if(failed.reason==='no_cue'||failed.reason==='cue_pocketed')return{ok:false};return{ok:false,reason:failed.reason};}
const events=sim.events;if(!sim.hitBall)return{ok:false,reason:'no_contact'};const copy=sim.balls;const cueAfter=sim.cue;if(!cueAfter||cueAfter.pocketed)return{ok:false,reason:'scratch'};const rails=events.filter((e)=>e.type==='cushion').length;const pocketedAny=copy.some((b)=>!isCueBall(b)&&b.pocketed);const fouled=rails===0&&!pocketedAny;return{ok:true,
fouled,
cueSpot:{x:cueAfter.x,y:cueAfter.y},
balls:copy,
oppTol:positionTolerance(table,copy,{cueId}),
hitNumber:sim.hitBall.number,
pocketedAny,};}
export function solveSafety(table,balls,opts={}){const cueId=opts.cueId??'cue';const cue=balls.find((b)=>b.id===cueId);if(!cue)throw new Error(`找不到母球: ${cueId}`);const allow=opts.allow?new Set(opts.allow):null;const targets=balls.filter(
(b)=>b.id!==cueId&&!b.pocketed&&!isCueBall(b)&&(!allow||allow.has(b.number))
);if(!targets.length)return null;const R=table.ballRadius;const maxTries=opts.maxTries??80;let baseTarget=targets[0];let baseD=Infinity;for(const b of targets){const d=V.dist(cue,b);if(d<baseD){baseD=d;baseTarget=b;}}
const baseAim=Math.atan2(baseTarget.y-cue.y,baseTarget.x-cue.x);const baseline=shoot(table,balls,cueId,baseTarget,baseAim,SPEED.medium);if(!baseline.ok)return null;const baseTol=baseline.oppTol;let best=null;let tries=0;for(const target of targets){if(tries>=maxTries)break;const distToCue=V.dist(cue,target);const headOn=Math.atan2(target.y-cue.y,target.x-cue.x);const swings=swingOffsetsDeg(distToCue,R);for(const swingDeg of swings){if(tries>=maxTries)break;const aimAngle=headOn+(swingDeg*Math.PI)/180;for(const speed of SPEEDS){if(tries>=maxTries)break;tries+=1;const r=shoot(table,balls,cueId,target,aimAngle,speed);if(!r.ok)continue;if(allow&&r.hitNumber!==null&&!allow.has(r.hitNumber))continue;let nearest=Infinity;for(const o of r.balls){if(o.id===cueId||o.pocketed)continue;nearest=Math.min(nearest,V.dist(r.cueSpot,o));}
const cueNearPocket=table.pockets.some((p)=>V.dist(r.cueSpot,p)<R*4);const scored=scoreSafety({oppTol:r.oppTol,
baseTol,
fouled:r.fouled,
cueNearPocket,
cueNearestBall:nearest,
R,});const candidate={kind:'safety',
targetId:target.id,
targetNumber:target.number,
pocketId:null,
pocketKind:null,
ghost:{x:target.x,y:target.y},
contactNormal:{x:0,y:0},
throwDeg:0,
aimAngle,
aimAngleDeg:aimAngle*DEG,
aimOffsetDeg:swingDeg,
cutDeg:Math.abs(swingDeg),
toleranceDeg:0,
distanceCue:distToCue,
distancePocket:0,
speed,
power:{name:speed<=SPEED.soft?'轻':speed<=SPEED.medium?'中':'重',speed},
tip:{name:'中杆（防守不加塞）',a:0,b:0},
scratchRisk:false,
cuePath:null,
nextToleranceDeg:r.oppTol,
leaveScore:null,
verified:true,
difficulty:50,
safetyScore:scored.total,
safetyOppToleranceDeg:r.oppTol,
safetyBaseToleranceDeg:baseTol,
safetyGainDeg:Math.round((baseTol-r.oppTol)*100)/100,
foulRisk:r.fouled,
cueSpot:r.cueSpot,};candidate.value=100-scored.total;if(!best||scored.total>best.safetyScore)best=candidate;}}}
if(!best||best.safetyGainDeg<=0)return null;return best;}
