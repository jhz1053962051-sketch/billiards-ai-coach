import{cloneGame,
headStringX,
legalTargetNumbers,
numbersOnTable,
placeCueBall,
placementAllowed,
resolveShot,
simulateShot,}from'./rules.js';import{SEARCH_DT}from'./constants.js';import{isCueBall}from'./physics.js';import{planShot,positionTolerance,toleranceToEase}from'./solver.js';const LOOKAHEAD_WEIGHT=0.45;const LOOKAHEAD_PENALTY_FOUL=45;const LOOKAHEAD_PENALTY_MISS=30;const DEEP_POOL=2;export function choosePlan(table,game,opts={}){const base=planShot(table,game,{allow:opts.allow,
safety:opts.safety===true,
extras:opts.extras,});if(!base.plan||base.kind==='break')return{...base,scores:[]};const limit=opts.lookahead??3;const pool=[base.plan,...base.alternatives].slice(0,limit);const scored=pool.map((candidate,index)=>({candidate,
index,
...scoreCandidate(table,game,candidate,opts),}));scored.sort((a,b)=>b.score-a.score||a.index-b.index);if((opts.plies??3)>=3&&scored.length>1){const depth=Math.min(DEEP_POOL,scored.length);for(let i=0;i<depth;i++){const deep=deepScore(table,scored[i],opts);if(deep)scored[i]={...scored[i],...deep};}
scored.sort((a,b)=>b.score-a.score||a.index-b.index);}
const winner=scored[0];return{plan:winner.candidate,
kind:base.kind,
alternatives:scored.slice(1).map((s)=>s.candidate),
scores:scored.map((s)=>({targetNumber:s.candidate.targetNumber,
pocketId:s.candidate.pocketId,
singleShotValue:s.candidate.value??s.candidate.difficulty,
score:Math.round(s.score*10)/10,
potted:s.potted,
fouled:s.fouled,
opponentEase:Math.round(s.humanEase*10)/10,
opponentToleranceDeg:Math.round(s.humanTolerance*100)/100,
myEase:s.myEase===undefined?null:Math.round(s.myEase*10)/10,
myToleranceDeg:s.myTolerance===undefined?null:Math.round(s.myTolerance*100)/100,
plies:s.myEase===undefined?2:3,
ended:s.ended,})),};}
function scoreCandidate(table,game,candidate,opts){const work=cloneGame(game);const shooter=work.turn;const facts=simulateShot(
table,
work.balls,
{angle:candidate.aimAngle,speed:candidate.speed,tip:{a:candidate.tip.a,b:candidate.tip.b}},
{dt:opts.dt??SEARCH_DT});const{next,report}=resolveShot(work,facts);const potted=report.pocketed.length>0;const cue=next.balls.find((b)=>isCueBall(b));const opponentAllow=legalTargetNumbers(next,numbersOnTable(next.balls));const humanTolerance=positionTolerance(table,next.balls,{cueId:cue?.id??'cue',
allow:opponentAllow,});const humanEase=toleranceToEase(humanTolerance);let base=100-(candidate.value??candidate.difficulty);if(report.fouled)base-=LOOKAHEAD_PENALTY_FOUL;if(!potted)base-=LOOKAHEAD_PENALTY_MISS;if(report.ended)base+=report.winner===shooter?1000:-1000;const score=base+LOOKAHEAD_WEIGHT*(100-humanEase);return{score,
base,
potted,
fouled:report.fouled,
humanTolerance,
humanEase,
ended:report.ended,
next,};}
function deepScore(table,entry,opts){if(entry.ended)return null;const reply=choosePlan(table,cloneGame(entry.next),{...opts,
plies:2,
lookahead:opts.deepLookahead??2,});let after=entry.next;if(reply.plan){const work=cloneGame(entry.next);const facts=simulateShot(
table,
work.balls,
{angle:reply.plan.aimAngle,speed:reply.plan.speed,tip:{a:reply.plan.tip.a,b:reply.plan.tip.b}},
{dt:opts.dt??SEARCH_DT});after=resolveShot(work,facts).next;}
const cue=after.balls.find((b)=>isCueBall(b));const myAllow=legalTargetNumbers(after,numbersOnTable(after.balls));const myTolerance=positionTolerance(table,after.balls,{cueId:cue?.id??'cue',allow:myAllow});const myEase=toleranceToEase(myTolerance);return{score:entry.base+LOOKAHEAD_WEIGHT*(100-myEase),
myEase,
myTolerance,
replyTarget:reply.plan?.targetNumber??null,};}
export function pickCueSpot(game,opts={}){const table=game.table;const R=table.ballRadius;const zone=game.ballInHand?.zone??'anywhere';const xMax=zone==='kitchen'?headStringX(table):table.bounds.maxX;const cols=opts.cols??12;const rows=opts.rows??8;let best=null;let bestClear=-1;for(let i=1;i<cols;i++){for(let j=1;j<rows;j++){const x=table.bounds.minX+((table.bounds.maxX-table.bounds.minX)*i)/cols;const y=table.bounds.minY+((table.bounds.maxY-table.bounds.minY)*j)/rows;if(x>xMax+1e-9)continue;if(!placementAllowed(game,x,y))continue;let clear=Infinity;for(const b of game.balls){if(isCueBall(b)||b.pocketed)continue;clear=Math.min(clear,Math.hypot(b.x-x,b.y-y));}
if(clear<2*R+1e-3)continue;if(clear>bestClear){bestClear=clear;best={x,y};}}}
return best;}
export function takeTurn(table,game,opts={}){const work=cloneGame(game);if(work.phase==='ended'){return{ok:false,reason:'ended',plan:null,facts:null,next:work,report:null};}
if(work.requiresRerack){return{ok:false,reason:'needs_rerack',plan:null,facts:null,next:work,report:null};}
let cuePlaced=false;let cueSpot=null;if(work.ballInHand){const spot=pickCueSpot(work,opts);if(!spot||!placeCueBall(work,spot.x,spot.y)){return{ok:false,reason:'no_spot',plan:null,facts:null,next:work,report:null};}
work.ballInHand=null;cuePlaced=true;const placed=work.balls.find((b)=>isCueBall(b));cueSpot=placed?{x:placed.x,y:placed.y}:spot;}
const allow=legalTargetNumbers(work,numbersOnTable(work.balls));const{plan,kind,alternatives,scores}=choosePlan(table,work,{allow,
safety:opts.safety===true,
dt:opts.dt,
lookahead:opts.lookahead,});if(!plan){return{ok:false,reason:'no_plan',plan:null,facts:null,next:work,report:null};}
const facts=simulateShot(
table,
work.balls,
{angle:plan.aimAngle,speed:plan.speed,tip:{a:plan.tip.a,b:plan.tip.b}},
{record:opts.record===true,dt:opts.dt??SEARCH_DT});const{next,report}=resolveShot(work,facts);return{ok:true,plan,kind,alternatives,scores,facts,next,report,cuePlaced,cueSpot};}
