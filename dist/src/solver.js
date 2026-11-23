import{PHYS,SPEED,SEARCH_DT,SOLVE_MAX_TIME,TUNE_MAX_TIME,MAX_CUT_DEG,SOLVE_PRUNE_K,SOLVE_PRUNE_FALLBACK,SOLVE_TUNE_GRID,SOLVE_TUNE_GRID_LEGACY}from'./constants.js';import{V,DEG}from'./geometry.js';import{createWorld,
strike,
runShot,
speedToReach,
cueSpeedForImpact,
isCueBall,}from'./physics.js';import{solveContactNormal,
cutAngleDeg,
firstBlocker,
aimToleranceDeg,
cueBallTangentDirection,
cueBallTravelAfter,
traceRay,
comboAimPoints,
bankSeedDirection,}from'./aim.js';import{bestNextShot,positionTolerance}from'./tolerance.js';export{positionTolerance};import{solveSafety}from'./safety.js';import{ballName as snookerBallName}from'./snooker.js';import{simulateShot}from'./sim.js';export function ballLabel(number){return number>=16?snookerBallName(number):`${number} 号球`;}
export const CUE_TIGHT=0.09;export const CUE_BACK=0.35;export function cueComfort(table,balls,cue,aimAngle,cueId){const R=table.ballRadius;const clearance=Math.min(
cue.x-table.bounds.minX,
table.bounds.maxX-cue.x,
cue.y-table.bounds.minY,
table.bounds.maxY-cue.y
);const notes=[];let penalty=0;if(clearance<CUE_TIGHT){notes.push('母球贴库，杆尾要翘起来打');penalty+=8;}
const back=aimAngle+Math.PI;const ux=Math.cos(back);const uy=Math.sin(back);let blocked=null;for(const b of balls){if(b.id===cueId||b.pocketed)continue;const dx=b.x-cue.x;const dy=b.y-cue.y;const along=dx*ux+dy*uy;if(along<=0||along>CUE_BACK+2*R)continue;const perp=Math.abs(dx*uy-dy*ux);if(perp>2*R)continue;blocked=b;break;}
if(blocked){const who=blocked.number>=16?snookerBallName(blocked.number):`${blocked.number}号球`;notes.push(`母球后面有${who}挡着，后手拉不开`);penalty+=6;}
return{clearance,blocked,notes,penalty};}
const POWER_LEVELS=[
{name:'轻',speed:SPEED.soft},
{name:'中',speed:SPEED.medium},
{name:'重',speed:SPEED.firm},
{name:'爆',speed:SPEED.break},
];function pickPower(speed){for(const p of POWER_LEVELS)if(speed<=p.speed)return{...p};return{...POWER_LEVELS[POWER_LEVELS.length-1],over:true};}
function suggestTip(cutDeg,d1){if(cutDeg>55)return{name:'中杆（薄球，别加塞）',a:0,b:0};if(d1>1.2)return{name:'中低杆（远台稳）',a:0,b:-0.2};if(d1<0.45)return{name:'中高杆（自然跟进）',a:0,b:0.3};return{name:'中杆',a:0,b:0};}
function trialShot(table,balls,cueId,targetId,pocketId,aimAngle,speed,tip,recordCueRoute=false){const cueIdx=balls.findIndex((b)=>b.id===cueId);const cueRoute=recordCueRoute?[]:null;let nextRouteTime=0.06;const sim=simulateShot(
table,
balls,
{cueId,angle:aimAngle,speed,tip:{a:tip.a,b:tip.b}},
{maxTime:SOLVE_MAX_TIME,
dt:SEARCH_DT,
targetId,
onStart:(world)=>{if(cueRoute&&world.balls[cueIdx])cueRoute.push({x:world.balls[cueIdx].x,y:world.balls[cueIdx].y});},
onStep:recordCueRoute
?(currentWorld,elapsed)=>{if(elapsed<nextRouteTime)return;const currentCue=currentWorld.balls[cueIdx];if(currentCue&&!currentCue.pocketed&&cueRoute.length<180){cueRoute.push({x:currentCue.x,y:currentCue.y});}
nextRouteTime+=0.06;}
:undefined,});if(!sim.ok)return{ok:false,balls:sim.balls,firstContact:null};const target=sim.balls[sim.balls.findIndex((b)=>b.id===targetId)];const cue=cueIdx>=0?sim.balls[cueIdx]:null;if(cueRoute&&cue&&!cue.pocketed){const last=cueRoute[cueRoute.length-1];if(Math.hypot(last.x-cue.x,last.y-cue.y)>1e-6){cueRoute.push({x:cue.x,y:cue.y});}}
return{ok:target.pocketed&&target.pocket===pocketId,
balls:sim.balls,
firstContact:sim.firstContact,
cueRoute,};}
function assessPosition(table,balls,cueId,shotTargetId,allow){const cue=balls.find((b)=>b.id===cueId);const remaining=balls.some(
(b)=>b.id!==cueId&&b.id!==shotTargetId&&!b.pocketed&&b.number!==0&&
(!allow||allow.includes(b.number))
);if(!remaining)return{cueRest:null,nextShot:null,hasNextTargets:false};if(!cue||cue.pocketed)return{cueRest:null,nextShot:null,hasNextTargets:true};return{cueRest:{x:cue.x,y:cue.y},
nextShot:bestNextShot(table,balls,cueId,allow),
hasNextTargets:true,};}
function positionQuality(positioning){if(!positioning?.hasNextTargets)return null;if(!positioning.cueRest)return-1;return positioning.nextShot?leaveScoreOf(positioning.nextShot.toleranceDeg):0;}
function verifyAndTune(table,balls,cueId,targetId,pocketId,baseAim,tip,seedSpeed,allow,grid,allowSpin=true){const tryOnce=(speed,offsetDeg,shotTip=tip)=>
trialShot(
table,
balls,
cueId,
targetId,
pocketId,
baseAim+(offsetDeg*Math.PI)/180,
speed,
shotTip
);const speeds=grid.speedFactors
.map((factor)=>seedSpeed*factor)
.filter((speed)=>speed>=SPEED.min&&speed<=SPEED.break);if(!speeds.length)speeds.push(Math.min(SPEED.break,Math.max(SPEED.min,seedSpeed)));const remaining=balls.some(
(b)=>b.id!==cueId&&b.id!==targetId&&!b.pocketed&&b.number!==0&&
(!allow||allow.includes(b.number))
);const tipNameOf=(b,a)=>{const vertical=b<=-0.4?'低杆':b>=0.4?'高杆':'中杆';const side=a>0.05?'右塞':a<-0.05?'左塞':'';return side?`${vertical}${side}（管母球出库角）`:vertical;};const centerTipName=(b)=>
(b<=-0.4?'低杆（控制母球回缩）':b>=0.4?'高杆（控制母球跟进）':'中杆');const dedupeTips=(list)=>{const seen=new Map();for(const t of list)seen.set(`${t.a ?? 0}|${t.b}`,t);return[...seen.values()];};const centerTips=dedupeTips([
tip,
...grid.centerTipBs.map((b)=>({...tip,b,name:centerTipName(b)})),
]);const spinTips=dedupeTips(
grid.spinTipAs.map((a)=>({...tip,a,name:tipNameOf(tip.b,a)}))
);const tips=remaining?centerTips:[tip];let best=null;const scanTips=(list,speedList=speeds)=>{for(const candidateTip of list){const candidateSpeeds=speedList.map((speed)=>{if(candidateTip.b===tip.b)return speed;const impact=speed*Math.max(0.55,1-Math.abs(candidateTip.b-tip.b)*0.14);return Math.min(SPEED.break,Math.max(SPEED.min,impact));});const tipCost=Math.abs(candidateTip.b)*0.2+Math.abs(candidateTip.a??0)*0.5;for(const speed of candidateSpeeds){if(best!==null&&best.quality===100&&speed+tipCost>=best.effort)break;const result=tryOnce(speed,0,candidateTip);if(!result.ok)continue;const positioning=assessPosition(table,result.balls,cueId,targetId,allow);const quality=positionQuality(positioning);const effort=speed+tipCost;if(
!best||
quality>best.quality+1e-8||
(Math.abs(quality-best.quality)<=1e-8&&effort<best.effort)
){best={speed,tip:candidateTip,result,positioning,quality,effort};}}}};if(!remaining){for(const candidateTip of[tip]){for(const speed of speeds){const result=tryOnce(speed,0,candidateTip);if(!result.ok)continue;return{speed,
aimAngle:baseAim,
aimOffsetDeg:0,
tip:candidateTip,
afterBalls:result.balls,};}}}
scanTips(tips);if(
allowSpin&&
remaining&&best&&best.quality!==null&&best.quality<grid.spinRetryQuality&&
spinTips.length>0
){scanTips(spinTips,grid.spinOverAllSpeeds?speeds:[best.speed]);}
if(best){const route=trialShot(
table,balls,cueId,targetId,pocketId,baseAim,best.speed,best.tip,true
);return{speed:best.speed,
aimAngle:baseAim,
aimOffsetDeg:0,
tip:best.tip,
afterBalls:best.result.balls,
positioning:best.positioning,
cueRoute:route.ok?route.cueRoute:null,};}
const offsets=grid.aimOffsetsDeg;const widenTips=
grid.widenTips==='base'?[tip]:dedupeTips([...centerTips,...spinTips]);let adjustedBest=null;for(const off of offsets){for(const candidateTip of widenTips){for(const s of speeds){const r=tryOnce(s,off,candidateTip);if(r.ok){const positioning=assessPosition(table,r.balls,cueId,targetId,allow);if(!remaining){return{speed:s,
aimAngle:baseAim+(off*Math.PI)/180,
aimOffsetDeg:off,
tip:candidateTip,
afterBalls:r.balls,
positioning,};}
const quality=positionQuality(positioning);const effort=s+Math.abs(candidateTip.b)*0.2+
Math.abs(candidateTip.a??0)*0.5+Math.abs(off)*0.01;if(
!adjustedBest||
quality>adjustedBest.quality+1e-8||
(Math.abs(quality-adjustedBest.quality)<=1e-8&&effort<adjustedBest.effort)
){adjustedBest={speed:s,off,tip:candidateTip,result:r,positioning,quality,effort};}}}}}
if(adjustedBest){const aimAngle=baseAim+(adjustedBest.off*Math.PI)/180;const route=trialShot(
table,balls,cueId,targetId,pocketId,aimAngle,
adjustedBest.speed,adjustedBest.tip,true
);return{speed:adjustedBest.speed,
aimAngle,
aimOffsetDeg:adjustedBest.off,
tip:adjustedBest.tip,
afterBalls:adjustedBest.result.balls,
positioning:adjustedBest.positioning,
cueRoute:route.ok?route.cueRoute:null,};}
return null;}
function leaveEstimate(table,balls,cueId,g,allowArr){let remaining=false;for(const b of balls){if(b.id===cueId||b.id===g.target.id||b.pocketed||b.number===0)continue;if(allowArr&&!allowArr.includes(b.number))continue;remaining=true;break;}
if(!remaining)return null;if(g.seedPath.kind==='pocket')return 0;const pseudo=[{id:cueId,number:0,x:g.seedPath.point.x,y:g.seedPath.point.y,pocketed:false}];for(const b of balls){if(b.id===cueId||b.id===g.target.id||b.pocketed)continue;pseudo.push({id:b.id,number:b.number,x:b.x,y:b.y,pocketed:false});}
const next=bestNextShot(table,pseudo,cueId,allowArr);return leaveScoreOf(next?next.toleranceDeg:0);}
function analyticScore(table,balls,cueId,g,allowArr){const tolScore=100*Math.min(1,Math.log10(1+g.tol/0.02)/Math.log10(1+3/0.02));const cutScore=100*Math.min(1,(g.cutDeg/80)**1.6);const distScore=100*Math.min(1,g.d1/2.6);let score=0.55*(100-tolScore)+0.25*cutScore+0.2*distScore;if(Math.abs(g.tip.a??0)>0.05)score+=6;score+=cueComfort(table,balls,g.cue,g.baseAim,cueId).penalty;if(g.seedPath.kind==='pocket')score+=18;const leave=leaveEstimate(table,balls,cueId,g,allowArr);if(leave!==null)score-=Math.max(-22.5,Math.min(22.5,(leave-50)*0.45));return score;}
function rankGeoCandidates(table,balls,cueId,geos,allowArr){const ranked=geos.map((g)=>({g,score:analyticScore(table,balls,cueId,g,allowArr)}));ranked.sort((a,b)=>
a.score-b.score||
b.g.tol-a.g.tol||
a.g.target.number-b.g.target.number||
(a.g.pocket.id<b.g.pocket.id?-1:a.g.pocket.id>b.g.pocket.id?1:0)
);return ranked;}
function directCandidate(table,g,tuned){const speed=tuned?tuned.speed:g.seedSpeed;const aimAngle=tuned?tuned.aimAngle:g.baseAim;const cueSpeedAfter=speed*Math.sin(g.cutRad);const travel=cueBallTravelAfter(cueSpeedAfter,PHYS.muRoll,PHYS.g);const cuePath=traceRay(g.target,g.tangent,Math.min(travel,3.0),table);const scratchRisk=cuePath.kind==='pocket';const positioning=tuned?.positioning??null;const nextToleranceDeg=positioning?.hasNextTargets
?positioning.nextShot?.toleranceDeg??0
:null;return{targetId:g.target.id,
targetNumber:g.target.number,
pocketId:g.pocket.id,
pocketKind:g.pocket.kind,
ghost:g.probe.ghost,
contactNormal:g.probe.normal,
throwDeg:g.probe.throwDeg,
aimAngle,
aimAngleDeg:aimAngle*DEG,
aimOffsetDeg:tuned?tuned.aimOffsetDeg:0,
cutDeg:g.cutDeg,
toleranceDeg:g.tol,
distanceCue:g.d1,
distancePocket:g.d2,
speed,
power:pickPower(speed),
tip:tuned?tuned.tip:g.tip,
scratchRisk,
cuePath,
cueRest:positioning?.cueRest??null,
cueRoute:tuned?.cueRoute??null,
nextShot:positioning?.nextShot??null,
positioningRequired:Boolean(positioning?.hasNextTargets),
nextToleranceDeg,
leaveScore:nextToleranceDeg===null?null:leaveScoreOf(nextToleranceDeg),
verified:Boolean(tuned),
difficulty:0,};}
function annotateComfort(list,table,balls,cueId){const cue=balls.find((b)=>b.id===cueId);if(!cue)return;for(const c of list){if(typeof c.aimAngle!=='number')continue;const info=cueComfort(table,balls,cue,c.aimAngle,cueId);c.cueClearance=info.clearance;c.backBlockedBy=info.blocked?info.blocked.number:null;c.awkwardNotes=info.notes;c.awkwardPenalty=info.penalty;}}
export function solveShot(table,balls,opts={}){const cueId=opts.cueId??'cue';const verify=opts.verify!==false;const exhaustive=
opts.exhaustive===true||
(typeof process!=='undefined'&&process.env?.SOLVE_EXHAUSTIVE==='1');const R=table.ballRadius;const cue=balls.find((b)=>b.id===cueId);if(!cue)throw new Error(`找不到母球: ${cueId}`);const allow=opts.allow?new Set(opts.allow):null;const allowArr=allow?[...allow]:null;const targets=balls.filter(
(b)=>b.id!==cueId&&!b.pocketed&&(!allow||allow.has(b.number))
);const candidates=[];const geos=[];for(const target of targets){for(const pocket of table.pockets){const d2=V.dist(target,pocket);if(d2<R*2.2)continue;const outDir=V.norm(V.sub(pocket,target));const probe=solveContactNormal(cue,target,outDir,SPEED.medium,R,PHYS);const ghost=probe.ghost;if(
ghost.x<R*0.5||
ghost.x>table.length-R*0.5||
ghost.y<R*0.5||
ghost.y>table.width-R*0.5
){continue;}
if(firstBlocker(cue,ghost,balls,[cueId,target.id],R))continue;if(firstBlocker(target,pocket,balls,[cueId,target.id],R))continue;const cutDeg=cutAngleDeg(cue,ghost,target,pocket);if(cutDeg>MAX_CUT_DEG)continue;const tol=aimToleranceDeg(cue,ghost,target,pocket,pocket.captureR,R);if(tol<0.03)continue;const d1=V.dist(cue,ghost);const cutRad=(cutDeg*Math.PI)/180;const tip=suggestTip(cutDeg,d1);const vObj=speedToReach(d2,Math.max(PHYS.stopSpeed*3,0.05),R);if(!Number.isFinite(vObj))continue;const transfer=((1+PHYS.ballRestitution)/2)*Math.max(0.18,Math.cos(cutRad));const seedSpeed=cueSpeedForImpact(d1,vObj/transfer,tip.b,R);if(!Number.isFinite(seedSpeed)||seedSpeed>SPEED.break)continue;const baseAim=Math.atan2(ghost.y-cue.y,ghost.x-cue.x);const inDir=V.norm(V.sub(ghost,cue));const tangent=cueBallTangentDirection(inDir,outDir);const seedPath=traceRay(
target,
tangent,
Math.min(cueBallTravelAfter(seedSpeed*Math.sin(cutRad),PHYS.muRoll,PHYS.g),3.0),
table
);geos.push({target,pocket,probe,outDir,inDir,tangent,baseAim,tip,seedSpeed,
cutDeg,cutRad,tol,d1,d2,cue,seedPath,});}}
const prune=verify&&!exhaustive;const tuneGrid=exhaustive?SOLVE_TUNE_GRID_LEGACY:SOLVE_TUNE_GRID;const spinAllCandidates=tuneGrid.spinCandidateScope==='all';const needRank=prune&&geos.length>SOLVE_PRUNE_K;const order=needRank?rankGeoCandidates(table,balls,cueId,geos,allowArr):geos.map((g)=>({g}));let misses=0;for(let i=0;i<order.length;i++){if(prune&&i>=SOLVE_PRUNE_K){if(misses===0)break;if(i>=SOLVE_PRUNE_K+SOLVE_PRUNE_FALLBACK)break;}
const g=order[i].g;let tuned=null;if(verify){tuned=verifyAndTune(
table,balls,cueId,g.target.id,g.pocket.id,g.baseAim,g.tip,g.seedSpeed,
allowArr,tuneGrid,
exhaustive||spinAllCandidates||i===0
);if(!tuned){if(i<SOLVE_PRUNE_K)misses++;continue;}}
candidates.push(directCandidate(table,g,tuned));}
annotateComfort(candidates,table,balls,cueId);for(const c of candidates)c.difficulty=difficultyOf(c);for(const c of candidates)c.value=valueOf(c);candidates.sort((a,b)=>a.value-b.value||b.toleranceDeg-a.toleranceDeg);if(opts.extras!==false&&candidates.length===0){const startedAt=Date.now();const budget=opts.budgetMs??Infinity;const extra=[
...comboCandidates(table,balls,cueId,targets,opts,startedAt,budget),
...bankCandidates(table,balls,cueId,targets,opts,startedAt,budget),
];annotateComfort(extra,table,balls,cueId);for(const c of extra)c.difficulty=difficultyOf(c);for(const c of extra)c.value=valueOf(c);extra.sort((a,b)=>a.value-b.value||b.toleranceDeg-a.toleranceDeg);candidates.push(...extra);}
for(const c of candidates)c.table=table;return opts.maxCandidates?candidates.slice(0,opts.maxCandidates):candidates;}
function comboCandidates(table,balls,cueId,targets,opts,startedAt,budgetMs){const R=table.ballRadius;const cue=balls.find((b)=>b.id===cueId);if(!cue)return[];const out=[];const starters=[];for(const target of targets){for(const pocket of table.pockets){const d2=V.dist(target,pocket);if(d2<R*4)continue;for(const mid of balls){if(mid.id===cueId||mid.id===target.id||mid.pocketed)continue;const dMid=V.dist(mid,target);if(dMid<R*2.5||dMid>1.6)continue;starters.push({target,pocket,mid,dMid});}}}
starters.sort((a,b)=>a.dMid-b.dMid);let tried=0;for(const s of starters){if(tried>=(opts.maxCombos??8))break;if(Date.now()-startedAt>budgetMs)break;tried++;const aim=comboAimPoints(cue,s.mid,s.target,s.pocket,R,PHYS,SPEED.medium);if(!aim)continue;if(aim.cut1>78||aim.cut2>78)continue;if(firstBlocker(cue,aim.gA,balls,[cueId,s.mid.id],R))continue;if(firstBlocker(s.mid,aim.gB,balls,[s.mid.id,s.target.id],R))continue;if(firstBlocker(s.target,s.pocket,balls,[s.target.id],R))continue;if(!table.insideBounds(aim.gA.x,aim.gA.y,-R*0.5))continue;const baseAim=Math.atan2(aim.gA.y-cue.y,aim.gA.x-cue.x);const tuned=tuneNarrow(table,balls,cueId,s.target,s.pocket,baseAim,opts.allow??null);if(!tuned)continue;const cutDeg=Math.max(aim.cut1,aim.cut2);const tol=Math.min(
aimToleranceDeg(cue,aim.gA,s.mid,s.pocket,s.pocket.captureR,R),
aimToleranceDeg(s.mid,aim.gB,s.target,s.pocket,s.pocket.captureR,R)
);if(tol<0.02)continue;const positioning=tuned.positioning;const nextToleranceDeg=positioning?.hasNextTargets
?positioning.nextShot?.toleranceDeg??0
:null;out.push({kind:'combo',
viaId:s.mid.id,
viaNumber:s.mid.number,
targetId:s.target.id,
targetNumber:s.target.number,
pocketId:s.pocket.id,
pocketKind:s.pocket.kind,
ghost:aim.gA,
contactNormal:{x:0,y:0},
throwDeg:aim.throw1+aim.throw2,
aimAngle:tuned.aimAngle,
aimAngleDeg:tuned.aimAngle*DEG,
aimOffsetDeg:tuned.aimOffsetDeg,
cutDeg,
toleranceDeg:tol,
distanceCue:V.dist(cue,aim.gA),
distancePocket:V.dist(s.target,s.pocket),
speed:tuned.speed,
power:pickPower(tuned.speed),
tip:{name:'中杆（组合球稳一点）',a:0,b:0},
scratchRisk:false,
cuePath:null,
cueRest:positioning?.cueRest??null,
cueRoute:tuned.cueRoute??null,
nextShot:positioning?.nextShot??null,
positioningRequired:Boolean(positioning?.hasNextTargets),
nextToleranceDeg,
leaveScore:nextToleranceDeg===null?null:leaveScoreOf(nextToleranceDeg),
verified:true,
difficulty:0,});}
return out;}
function bankCandidates(table,balls,cueId,targets,opts,startedAt,budgetMs){const R=table.ballRadius;const cue=balls.find((b)=>b.id===cueId);if(!cue)return[];const out=[];const rails=['ymin','ymax','xmin','xmax'];const maxBanks=opts.maxBanks??10;const maxTries=opts.maxBankTries??80;let tries=0;for(const target of targets){if(Date.now()-startedAt>budgetMs)break;if(out.length>=maxBanks)break;for(const pocket of table.pockets){if(out.length>=maxBanks||tries>=maxTries)break;for(const rail of rails){if(out.length>=maxBanks)break;if(tries>=maxTries)break;if(Date.now()-startedAt>budgetMs)break;tries++;const seed=bankSeedDirection(target,pocket,rail,table);if(!seed)continue;if(table.pocketAt(seed.mirror.x,seed.mirror.y))continue;const dir=solveBankDirection(table,target,pocket,seed.dir);if(!dir)continue;const probe=solveContactNormal(cue,target,dir,SPEED.medium,R,PHYS);if(!probe)continue;const bankExit={x:target.x+dir.x,y:target.y+dir.y};if(cutAngleDeg(cue,probe.ghost,target,bankExit)>78)continue;if(firstBlocker(cue,probe.ghost,balls,[cueId,target.id],R))continue;const baseAim=Math.atan2(probe.ghost.y-cue.y,probe.ghost.x-cue.x);const tuned=tuneNarrow(table,balls,cueId,target,pocket,baseAim,opts.allow??null);if(!tuned)continue;const cutDeg=cutAngleDeg(cue,probe.ghost,target,bankExit);const unfoldedPocket={x:seed.mirror.x,y:seed.mirror.y};const tol=aimToleranceDeg(cue,probe.ghost,target,unfoldedPocket,pocket.captureR,R);if(tol<0.02)continue;const positioning=tuned.positioning;const nextToleranceDeg=positioning?.hasNextTargets
?positioning.nextShot?.toleranceDeg??0
:null;out.push({kind:'bank',
bankRail:rail,
targetId:target.id,
targetNumber:target.number,
pocketId:pocket.id,
pocketKind:pocket.kind,
ghost:probe.ghost,
contactNormal:probe.normal,
throwDeg:probe.throwDeg,
aimAngle:tuned.aimAngle,
aimAngleDeg:tuned.aimAngle*DEG,
aimOffsetDeg:tuned.aimOffsetDeg,
cutDeg,
toleranceDeg:tol,
distanceCue:V.dist(cue,probe.ghost),
distancePocket:V.dist(target,pocket),
speed:tuned.speed,
power:pickPower(tuned.speed),
tip:{name:'中杆（翻袋别加塞）',a:0,b:0},
scratchRisk:false,
cuePath:null,
cueRest:positioning?.cueRest??null,
cueRoute:tuned.cueRoute??null,
nextShot:positioning?.nextShot??null,
positioningRequired:Boolean(positioning?.hasNextTargets),
nextToleranceDeg,
leaveScore:nextToleranceDeg===null?null:leaveScoreOf(nextToleranceDeg),
verified:true,
difficulty:0,});}}}
return out;}
function solveBankDirection(table,target,pocket,seedDir){const single={id:target.id,
number:target.number,
x:target.x,
y:target.y,
vx:0,
vy:0,
wx:0,
wy:0,
wz:0,
pocketed:false,};let angle=Math.atan2(seedDir.y,seedDir.x);for(let i=0;i<8;i++){const copy={...single};const world=createWorld(table,[copy]);strike(copy,{angle,speed:1.8,tip:{a:0,b:0}});runShot(world,{maxTime:TUNE_MAX_TIME,dt:SEARCH_DT});if(copy.pocketed&&copy.pocket===pocket.id){return{x:Math.cos(angle),y:Math.sin(angle)};}
const toPocket=Math.atan2(pocket.y-copy.y,pocket.x-copy.x);const err=Math.atan2(Math.sin(toPocket-angle),Math.cos(toPocket-angle));if(!Number.isFinite(err))return null;if(Math.abs(err)<0.001)break;angle+=err*0.9;}
return null;}
function tuneNarrow(table,balls,cueId,target,pocket,baseAim,allow){const speeds=[1.8,2.4,3.0,3.6];const offsets=[0,0.3,-0.3,0.7,-0.7,1.2,-1.2,2,-2,3,-3];for(const off of offsets){for(const sp of speeds){const r=trialShot(
table,
balls,
cueId,
target.id,
pocket.id,
baseAim+(off*Math.PI)/180,
sp,
{a:0,b:0});if(r.ok){const positioning=assessPosition(table,r.balls,cueId,target.id,allow);const route=positioning.hasNextTargets
?trialShot(
table,balls,cueId,target.id,pocket.id,
baseAim+(off*Math.PI)/180,sp,{a:0,b:0},true
)
:null;return{speed:sp,
aimAngle:baseAim+(off*Math.PI)/180,
aimOffsetDeg:off,
afterBalls:r.balls,
positioning,
cueRoute:route?.ok?route.cueRoute:null,};}}}
return null;}
function leaveScoreOf(tolDeg){return 100*Math.min(1,Math.log10(1+tolDeg/0.02)/Math.log10(1+3/0.02));}
export function toleranceToEase(tolDeg){return leaveScoreOf(tolDeg);}
function valueOf(c){if(c.leaveScore===null||c.leaveScore===undefined)return c.difficulty;const bonus=Math.max(-22.5,Math.min(22.5,(c.leaveScore-50)*0.45));return Math.round((c.difficulty-bonus)*10)/10;}
export function difficultyOf(c){const tolScore=100*Math.min(1,Math.log10(1+c.toleranceDeg/0.02)/Math.log10(1+3/0.02));const cutScore=100*Math.min(1,(c.cutDeg/80)**1.6);const distScore=100*Math.min(1,c.distanceCue/2.6);let d=0.55*(100-tolScore)+0.25*cutScore+0.2*distScore;if(c.kind==='combo')d+=12;if(c.kind==='bank')d+=18;if(Math.abs(c.tip?.a??0)>0.05)d+=6;d+=c.awkwardPenalty??0;if(c.scratchRisk)d=Math.min(100,d+18);return Math.round(Math.min(100,d)*10)/10;}
export const LABEL_SIGMA_DEG=0.2;export function difficultyLabel(score){if(score<25)return'很容易';if(score<40)return'容易';if(score<55)return'中等';if(score<70)return'偏难';if(score<85)return'很难';return'极难';}
export function difficultyCaveat(){return`按瞄准误差 ±${LABEL_SIGMA_DEG}° 估算`;}
export function pocketName(id){const map={'c-bl':'左下底袋',
'c-br':'右下底袋',
'c-tl':'左上底袋',
'c-tr':'右上底袋',
'm-b':'下中袋',
'm-t':'上中袋',};return map[id]??id;}
function addComfortAdvice(parts,c){for(const note of c.awkwardNotes??[])parts.push(`⚠ ${note}`);}
function addLeaveAdvice(parts,c){if(c.leaveScore===null||c.leaveScore===undefined)return;const tag=c.leaveScore>=55?'走位好':c.leaveScore>=30?'走位一般':'走位差';parts.push(`${tag}（下一杆容错 ±${c.nextToleranceDeg.toFixed(2)}°）`);}
export function describeCandidate(c){if(c.kind==='break'){const parts=[
`开球：打顶点 ${ballLabel(c.targetNumber)}`,
`全力`,
c.tip.name,
`瞄准偏移 ${c.aimOffsetDeg.toFixed(2)}°`,
];return parts.join(' · ');}
if(c.kind==='direct'){const parts=[
`没有进球机会，直接撞 ${ballLabel(c.targetNumber)}（保证合法碰球）`,
`${c.power.name}力`,
];addComfortAdvice(parts,c);return parts.join(' · ');}
if(c.kind==='combo'){const parts=[
`组合球：打 ${ballLabel(c.viaNumber)}撞 ${ballLabel(c.targetNumber)}进${pocketName(c.pocketId)}`,
`两级切角最大 ${c.cutDeg.toFixed(0)}°`,
toleranceText(c),
`${c.power.name}力`,
c.tip.name,
];addPositioningAdvice(parts,c);addLeaveAdvice(parts,c);addComfortAdvice(parts,c);return parts.join(' · ');}
if(c.kind==='bank'){const railName={ymin:'下库',
ymax:'上库',
xmin:'左库',
xmax:'右库',}[c.bankRail]??c.bankRail;const parts=[
`翻袋：${ballLabel(c.targetNumber)}翻${railName}进${pocketName(c.pocketId)}`,
`切角 ${c.cutDeg.toFixed(0)}°`,
toleranceText(c),
`${c.power.name}力`,
c.tip.name,
];addPositioningAdvice(parts,c);addLeaveAdvice(parts,c);addComfortAdvice(parts,c);return parts.join(' · ');}
if(c.kind==='safety'){const parts=[
`防守：打 ${ballLabel(c.targetNumber)}${
        Math.abs(c.aimOffsetDeg) < 1 ? '（正对）' : `偏 ${c.aimOffsetDeg.toFixed(0)}°`
      }`,
`${c.power.name}力`,
c.tip.name,
];if(typeof c.safetyGainDeg==='number'){parts.push(
`对手容错从 ±${c.safetyBaseToleranceDeg.toFixed(2)}° 压到 ±${c.safetyOppToleranceDeg.toFixed(2)}°`
);}else{parts.push(`对手接手后容错 ±${c.safetyOppToleranceDeg.toFixed(2)}°`);}
if(c.foulRisk)parts.push('⚠ 这一杆可能不够库');return parts.join(' · ');}
const parts=[
`打 ${ballLabel(c.targetNumber)}进${pocketName(c.pocketId)}`,
`切角 ${c.cutDeg.toFixed(0)}°`,
toleranceText(c),
`${c.power.name}力`,
c.tip.name,
];if(c.scratchRisk)parts.push('⚠ 母球有摔袋风险');addPositioningAdvice(parts,c);addLeaveAdvice(parts,c);addComfortAdvice(parts,c);return parts.join(' · ');}
export function toleranceText(c){const base=`容错 ±${c.toleranceDeg.toFixed(2)}°`;const dist=c.distanceCue;if(!(c.toleranceDeg>0)||!(dist>0.2))return base;const mm=Math.tan((c.toleranceDeg*Math.PI)/180)*dist*1000;const shown=
mm<1?`${mm.toFixed(1)} 毫米`:mm<10?`${Math.round(mm)} 毫米`:`${(mm / 10).toFixed(1)} 厘米`;return`${base}（母球走 ${dist.toFixed(2)} 米，方向偏 ${shown}就打不进）`;}
export function cueRestText(table,rest){if(!rest)return'母球建议停位：—';if(!table||!(table.length>0)){return`母球建议停位 (${rest.x.toFixed(2)}, ${rest.y.toFixed(2)}) 米`;}
const col=rest.x/table.length<1/3?'左':rest.x/table.length>2/3?'右':'';const row=rest.y/table.width<1/3?'下':rest.y/table.width>2/3?'上':'';const where=col&&row?`台面${row}${col}`:col||row?`台面靠${col || row}`:'台面正中';const rails=[
{name:'左库',d:rest.x},
{name:'右库',d:table.length-rest.x},
{name:'下库',d:rest.y},
{name:'上库',d:table.width-rest.y},
].sort((a,b)=>a.d-b.d);const near=rails[0];return`母球建议停位：${where}（距${near.name} ${Math.round(near.d * 100)} 厘米）`;}
function addPositioningAdvice(parts,candidate){if(!candidate.positioningRequired||!candidate.cueRest)return;parts.push(cueRestText(candidate.table,candidate.cueRest));if(candidate.nextShot){parts.push(
`下一杆打 ${ballLabel(candidate.nextShot.targetNumber)}进${pocketName(candidate.nextShot.pocketId)}`
);}else{parts.push('剩余球暂无直接进球线');}}
export function solveBreak(table,balls,opts={}){const cueId=opts.cueId??'cue';const cue=balls.find((b)=>b.id===cueId);if(!cue)throw new Error(`找不到母球: ${cueId}`);const live=balls.filter((b)=>b.id!==cueId&&!b.pocketed);if(!live.length)return null;let candidates;if(opts.kind==='snooker'){const reds=live.filter((b)=>b.number>=1&&b.number<=15);candidates=reds.length?reds:live;}else{const halfway=table.length/2;const rackSide=live.filter((b)=>b.x>halfway);candidates=rackSide.length?rackSide:live;}
if(opts.kind==='snooker')candidates=candidates.slice().sort((a,b)=>a.x-b.x).slice(0,1);let apex=candidates[0];let bestD=Infinity;for(const b of candidates){const d=Math.hypot(b.x-cue.x,b.y-cue.y);if(d<bestD-1e-9||(Math.abs(d-bestD)<=1e-9&&b.x<apex.x)){bestD=d;apex=b;}}
const aimAngle=Math.atan2(apex.y-cue.y,apex.x-cue.x);const tip={name:'中低杆（压低母球）',a:0,b:-0.15};return{kind:'break',
targetId:apex.id,
targetNumber:apex.number,
pocketId:null,
pocketKind:null,
ghost:{x:apex.x,y:apex.y},
contactNormal:{x:0,y:0},
throwDeg:0,
aimAngle,
aimAngleDeg:aimAngle*DEG,
aimOffsetDeg:0,
cutDeg:0,
toleranceDeg:0,
distanceCue:Math.hypot(apex.x-cue.x,apex.y-cue.y),
distancePocket:0,
speed:SPEED.break,
power:pickPower(SPEED.break),
tip,
scratchRisk:false,
cuePath:null,
verified:false,
difficulty:20,};}
export function solveDirectHit(table,balls,opts={}){const cueId=opts.cueId??'cue';const cue=balls.find((b)=>b.id===cueId);if(!cue)throw new Error(`找不到母球: ${cueId}`);const allow=opts.allow?new Set(opts.allow):null;const targets=balls.filter(
(b)=>b.id!==cueId&&!b.pocketed&&(!allow||allow.has(b.number))
);if(!targets.length)return null;let target=targets[0];let bestD=Infinity;for(const b of targets){const d=Math.hypot(b.x-cue.x,b.y-cue.y);if(d<bestD){bestD=d;target=b;}}
const headOn=Math.atan2(target.y-cue.y,target.x-cue.x);const tip={name:'中杆',a:0,b:0};const offsets=[0,5,-5,10,-10,16,-16,24,-24,35,-35];const speeds=[SPEED.medium,SPEED.firm];const before=new Map(balls.map((b)=>[b.id,b]));let best=null;for(const off of offsets){const aimAngle=headOn+(off*Math.PI)/180;for(const speed of speeds){const r=trialShot(table,balls,cueId,target.id,'__none__',aimAngle,speed,tip);if(r.firstContact===null)continue;const cueAfter=r.balls.find((b)=>b.id===cueId);if(!cueAfter||cueAfter.pocketed)continue;let moved=0;let targetMoved=0;let targetPocketed=false;for(const after of r.balls){if(isCueBall(after))continue;const orig=before.get(after.id);if(!orig||orig.pocketed)continue;if(after.pocketed){moved+=1;if(after.id===target.id)targetPocketed=true;continue;}
const d=Math.hypot(after.x-orig.x,after.y-orig.y);moved+=d;if(after.id===target.id)targetMoved=d;}
const score=(targetPocketed?5:targetMoved)+0.25*moved;if(!best||score>best.score){best={aimAngle,off,speed,score,targetMoved,targetPocketed};}}}
const aimAngle=best?best.aimAngle:headOn;const speed=best?best.speed:SPEED.medium;return{kind:'direct',
targetId:target.id,
targetNumber:target.number,
pocketId:null,
pocketKind:null,
ghost:{x:target.x,y:target.y},
contactNormal:{x:0,y:0},
throwDeg:0,
aimAngle,
aimAngleDeg:aimAngle*DEG,
aimOffsetDeg:best?best.off:0,
cutDeg:0,
toleranceDeg:0,
distanceCue:bestD,
distancePocket:0,
speed,
power:pickPower(speed),
tip,
scratchRisk:false,
cuePath:null,
verified:false,
difficulty:60,};}
export function coach(table,balls,opts={}){const all=opts.candidates??solveShot(table,balls,opts);if(!all.length){return{found:false,
message:'没有可以直接进攻的球——需要打防守，或先解一杆。',
candidates:[],};}
const best=all[0];const v=best.value??best.difficulty;return{found:true,
best,
alternatives:all.slice(1,4),
message:describeCandidate(best),
verdict:`${difficultyLabel(v)}（综合 ${v}/100 · 单杆难度 ${best.difficulty}/100 · ${difficultyCaveat()}）`,};}
export function planShot(table,game,opts={}){const cue=game.balls.find((b)=>isCueBall(b));if(!cue)throw new Error('球局里找不到母球');if(game.breakShot){const plan=solveBreak(table,game.balls,{cueId:cue.id,kind:game.kind});return{plan,kind:'break',alternatives:[]};}
const allow=opts.allow??null;const all=solveShot(table,game.balls,{cueId:cue.id,
allow,
extras:opts.extras,
budgetMs:opts.budgetMs,});if(all.length){const kind=all[0].kind==='combo'||all[0].kind==='bank'?all[0].kind:'attack';return{plan:all[0],kind,alternatives:all.slice(1,4)};}
if(opts.safety){const safety=solveSafety(table,game.balls,{cueId:cue.id,allow});if(safety){return{plan:safety,kind:'safety',alternatives:[]};}}
const plan=solveDirectHit(table,game.balls,{cueId:cue.id,allow});return{plan,kind:'direct',alternatives:[]};}
