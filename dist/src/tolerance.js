import{MAX_CUT_DEG}from'./constants.js';import{V}from'./geometry.js';import{cutAngleDeg,firstBlocker,aimToleranceDeg}from'./aim.js';export function bestNextShot(table,balls,cueId,allow){const R=table.ballRadius;const cue=balls.find((b)=>b.id===cueId);if(!cue||cue.pocketed)return null;const allowSet=allow?new Set(allow):null;const targets=balls.filter(
(b)=>b.id!==cueId&&!b.pocketed&&b.number!==0&&(!allowSet||allowSet.has(b.number))
);let best=null;for(const target of targets){for(const pocket of table.pockets){const d2=V.dist(target,pocket);if(d2<R*2.2)continue;const outDir=V.norm(V.sub(pocket,target));const ghost={x:target.x-outDir.x*2*R,y:target.y-outDir.y*2*R};if(
ghost.x<R*0.5||ghost.x>table.length-R*0.5||
ghost.y<R*0.5||ghost.y>table.width-R*0.5
)continue;if(firstBlocker(cue,ghost,balls,[cueId,target.id],R))continue;if(firstBlocker(target,pocket,balls,[cueId,target.id],R))continue;if(cutAngleDeg(cue,ghost,target,pocket)>MAX_CUT_DEG)continue;const tol=aimToleranceDeg(cue,ghost,target,pocket,pocket.captureR,R);if(!best||tol>best.toleranceDeg){best={targetId:target.id,
targetNumber:target.number,
target:{x:target.x,y:target.y},
pocketId:pocket.id,
pocket:{x:pocket.x,y:pocket.y},
ghost,
toleranceDeg:tol,};}}}
return best;}
export function bestNextTolerance(table,balls,cueId,allow){return bestNextShot(table,balls,cueId,allow)?.toleranceDeg??0;}
export function positionTolerance(table,balls,opts={}){return bestNextTolerance(table,balls,opts.cueId??'cue',opts.allow??null);}
