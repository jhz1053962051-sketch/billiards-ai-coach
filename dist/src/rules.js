import{groupOf,findFreeSpot,GAME_KINDS}from'./rack.js';export{GAME_KINDS};import{createBall,createRollTracker,isCueBall}from'./physics.js';import{SEARCH_DT,MAX_SHOT_TIME,SNOOKER_SPOTS}from'./constants.js';import{simulateShot as runShotSim}from'./sim.js';import{resolveSnooker,initialSnooker,snookerTargets}from'./snooker.js';export const FOUL={ILLEGAL_BREAK:'illegal_break',
SCRATCH:'scratch',
NO_CONTACT:'no_contact',
WRONG_BALL_FIRST:'wrong_ball_first',
NO_RAIL:'no_rail',
WRONG_BALL_POTTED:'wrong_ball_potted',};const FOUL_TEXT={[FOUL.ILLEGAL_BREAK]:'开球不合法：没有球进袋，且被驱向库边的目标球不足四颗（WPA 4.3d / 5.3b）',
[FOUL.SCRATCH]:'母球落袋（WPA 3.1）',
[FOUL.NO_CONTACT]:'母球没有碰到任何球（WPA 3.2）',
[FOUL.WRONG_BALL_FIRST]:'母球先碰到的不是合法目标球（WPA 3.2）',
[FOUL.NO_RAIL]:'碰球之后没有球再碰库、也没有球进袋（WPA 3.3）',
[FOUL.WRONG_BALL_POTTED]:'打进了不该进的球',};export const ILLEGAL_BREAK_NOTICE='three_ball_rule';export function headStringX(table){return table.length/4;}
export function footSpotX(table){return(table.length*3)/4;}
export function createGame(table,balls,opts={}){const names=opts.names??['玩家 1','玩家 2'];const breaker=opts.breaker===1?1:0;const kind=opts.kind===undefined?'eightball':GAME_KINDS[opts.kind]?opts.kind:null;if(kind===null){throw new Error(`不认识的玩法：${String(opts.kind)}（支持 ${Object.keys(GAME_KINDS).join(' / ')}）`);}
const cue=balls.find((b)=>isCueBall(b));if(!cue)throw new Error('建局需要一颗母球（number 0 或 id "cue"）');const normalized=balls.map((b)=>
typeof b.vx==='number'&&typeof b.pocketed==='boolean'?{...b}:createBall(b.id,b.x,b.y,b)
);const game={kind,
table,
balls:normalized,
players:[
{name:names[0]??'玩家 1',group:null,fouls:0,warned:false},
{name:names[1]??'玩家 2',group:null,fouls:0,warned:false},
],
turn:breaker,
breakShot:true,
open:true,
ballInHand:null,
requiresRerack:false,
phase:'playing',
winner:null,
shots:0,
log:[],
pendingChoice:null,
snooker:kind==='snooker'?initialSnooker(balls.filter((b)=>b.number>=1&&b.number<=15).length):null,};return game;}
export function cloneGame(game){return{...game,
balls:game.balls.map((b)=>({...b})),
players:game.players.map((p)=>({...p})),
ballInHand:game.ballInHand?{...game.ballInHand}:null,
log:game.log.slice(),
pendingChoice:game.pendingChoice?{...game.pendingChoice}:null,
snooker:game.snooker?{...game.snooker,scores:game.snooker.scores.slice()}:null,};}
export function numbersOnTable(balls){return balls.filter((b)=>!b.pocketed&&!isCueBall(b)).map((b)=>b.number);}
export function legalTargetNumbers(game,onTable){if(game.kind==='snooker')return snookerTargets(game,onTable);if(game.breakShot)return onTable.slice();if(game.kind==='nineball'){const low=Math.min(...onTable);return Number.isFinite(low)?[low]:[];}
const mine=game.players[game.turn].group;if(!mine){const rest=onTable.filter((n)=>n!==8);return rest.length?rest:[8];}
const own=onTable.filter((n)=>groupOf(n)===mine);return own.length?own:[8];}
export function remainingOfGroup(onTable,group){return onTable.filter((n)=>groupOf(n)===group).length;}
export function simulateShot(table,balls,shot,opts={}){const dt=opts.dt??SEARCH_DT;const maxTime=opts.maxTime??MAX_SHOT_TIME;const cueId=shot.cueId??'cue';const frameEvery=Math.max(1,Math.round(opts.frameEvery??1));let copy=null;let snapshot=null;let frames=null;let step=0;let onTableBefore=[];const sim=runShotSim(
table,
balls,
{cueId,angle:shot.angle,speed:shot.speed,tip:shot.tip},
{dt,
maxTime,
normalize:true,
rejectPocketedCue:true,
onStart:(world)=>{copy=world.balls;onTableBefore=copy.filter((b)=>!b.pocketed&&!isCueBall(b)).map((b)=>b.number);if(!opts.record)return;const trackRoll=createRollTracker(copy,table.ballRadius);snapshot=()=>{const roll=trackRoll();return copy.map((b,i)=>({x:b.x,
y:b.y,
pocketed:b.pocketed,
pocket:b.pocket,
...roll[i],}));};frames=[snapshot()];},
onStep:()=>{step++;if(frames&&step%frameEvery===0)frames.push(snapshot());},});if(!sim.ok){const failed=(sim);if(failed.reason==='no_cue')throw new Error(`找不到母球: ${cueId}`);if(failed.reason==='cue_pocketed')throw new Error('母球已落袋，不能击球');throw new Error(`无法击球: ${failed.reason}`);}
if(frames&&step%frameEvery!==0){frames.push(snapshot());}
const{events}=sim;const contactIndex=sim.contactIndex;const firstContactId=sim.firstContactId;const firstContact=sim.firstContact;const railsAfterContact=[];if(contactIndex>=0){for(let i=contactIndex+1;i<events.length;i++){const e=events[i];if(e.type==='cushion'&&!railsAfterContact.includes(e.ball))railsAfterContact.push(e.ball);}}
const toRail=new Set();for(const e of events){if(e.type!=='cushion')continue;const b=copy.find((x)=>x.id===e.ball);if(b&&!isCueBall(b))toRail.add(b.number);}
const pocketed=[];for(const e of events){if(e.type!=='pocket')continue;const b=copy.find((x)=>x.id===e.ball);if(b)pocketed.push({id:b.id,number:b.number,pocket:e.pocket});}
for(const p of pocketed)if(!isCueBall(p))toRail.add(p.number);return{firstContact,
firstContactId,
pocketed,
cueScratched:pocketed.some((p)=>isCueBall(p)),
railsAfterContact,
objectBallsToRail:[...toRail].sort((a,b)=>a-b),
onTableBefore,
onTableAfter:copy.filter((b)=>!b.pocketed&&!isCueBall(b)).map((b)=>b.number),
settled:sim.settled,
elapsed:sim.elapsed,
events,
frames,
dt,
ballsAfter:copy.map((b)=>({...b})),};}
export function footSpotPosition(table,balls,excludeNumber){const R=table.ballRadius;const cx=footSpotX(table);const cy=table.width/2;const free=(x,y)=>
x>=table.bounds.minX&&x<=table.bounds.maxX&&
balls.every((b)=>{if(b.pocketed||b.number===excludeNumber)return true;return Math.hypot(b.x-x,b.y-y)>=2*R+1e-4;});if(free(cx,cy))return{x:cx,y:cy};const step=R*0.5;for(let i=1;i<=400;i++){const x=cx+i*step;if(x>table.bounds.maxX)break;if(free(x,cy))return{x,y:cy};}
for(let i=1;i<=400;i++){const x=cx-i*step;if(x<table.bounds.minX)break;if(free(x,cy))return{x,y:cy};}
return null;}
export function spotEight(game){return spotBall(game,8);}
export function resolveShot(game,facts){if(game.kind==='snooker')return resolveSnooker(game,facts);return game.kind==='nineball'?resolveNineBall(game,facts):resolveEightBall(game,facts);}
function beginShot(game,facts){const next=cloneGame(game);const me=next.turn;const opp=1-me;const ctx={next,
facts,
me,
opp,
myName:next.players[me].name,
oppName:next.players[opp].name,
isBreak:next.breakShot,
fouls:[],
notes:[],
addFoul:(code)=>{if(!ctx.fouls.includes(code))ctx.fouls.push(code);},
pocketedObjects:facts.pocketed.filter((p)=>p.number!==0),};return ctx;}
function judgeBreakFouls({facts,pocketedObjects,addFoul}){if(facts.cueScratched)addFoul(FOUL.SCRATCH);if(pocketedObjects.length===0&&facts.objectBallsToRail.length<4){addFoul(FOUL.ILLEGAL_BREAK);}}
function judgeShotFouls({next,facts,addFoul}){if(facts.cueScratched)addFoul(FOUL.SCRATCH);if(facts.firstContact===null){addFoul(FOUL.NO_CONTACT);}else{const legal=legalTargetNumbers(next,facts.onTableBefore);if(!legal.includes(facts.firstContact))addFoul(FOUL.WRONG_BALL_FIRST);}
const railOk=facts.railsAfterContact.length>0||facts.pocketed.length>0;if(facts.firstContact!==null&&!railOk)addFoul(FOUL.NO_RAIL);}
function judgeFouls(ctx){if(ctx.isBreak)judgeBreakFouls(ctx);else judgeShotFouls(ctx);return ctx.fouls.length>0;}
function assignGroups({next,facts,me,opp,myName,isBreak,fouled,ended,pocketedObjects,notes}){if(isBreak||fouled||!next.open||pocketedObjects.length===0||ended)return null;const first=pocketedObjects.find((p)=>p.number===facts.firstContact);const pick=first??pocketedObjects[0];const g=groupOf(pick.number);if(g!=='solid'&&g!=='stripe')return null;next.players[me].group=g;next.players[opp].group=g==='solid'?'stripe':'solid';next.open=false;notes.push(`${myName} 打进 ${pick.number} 号球，分到${g === 'solid' ? '全色（1–7）' : '花色（9–15）'}。`);return{player:me,group:g};}
const FOUL_COUNTERS={record({next,me,fouled,ended,winner}){if(fouled)next.players[me].fouls+=1;else next.players[me].fouls=0;return{ended,winner};},
threeFoul({next,me,opp,myName,notes,fouled,ended,winner}){if(fouled){next.players[me].fouls+=1;if(next.players[me].fouls===2){next.players[me].warned=true;notes.push(`${myName} 已经连续两次犯规——再犯一次就输掉这一局（WPA 3.13）。`);}
if(next.players[me].fouls>=3&&next.players[me].warned){notes.push(`${myName} 连续三次犯规，判负（WPA 3.13 + 5.8）。`);return{ended:true,winner:opp};}}else{next.players[me].fouls=0;next.players[me].warned=false;}
return{ended,winner};},};const EIGHT_BALL_SETTLE={endedFirst:false,
foulCounter:'record',
groupLogic:assignGroups,
ballInHandZone:(isBreak)=>(isBreak?'kitchen':'anywhere'),
illegalBreak:{onFoul:'rerack',notice:null},
continuing:({next,me,isBreak,pocketedObjects,ended,fouled})=>{if(ended||fouled)return false;if(isBreak)return pocketedObjects.length>0;const mine=next.players[me].group;if(!mine)return pocketedObjects.length>0;return pocketedObjects.some((p)=>groupOf(p.number)===mine);},
extraReport:false,};function nineBallSettle(threeBallFailed){return{endedFirst:true,
foulCounter:'threeFoul',
groupLogic:null,
ballInHandZone:()=>'anywhere',
illegalBreak:{onFoul:'foul',notice:()=>threeBallFailed},
continuing:({pocketedObjects,ended,fouled})=>
threeBallFailed?false:!ended&&!fouled&&pocketedObjects.length>0,
extraReport:true,};}
function settleShot(ctx,opts){const{next,facts,me,myName,oppName,spotted}=ctx;let ended=ctx.ended;let winner=ctx.winner;const groupAssigned=opts.groupLogic?opts.groupLogic(ctx):null;const counted=countFouls(ctx,opts,{ended,winner});ended=counted.ended;winner=counted.winner;const continuing=opts.continuing({...ctx,ended});const pendingChoice=advanceTurn(ctx,opts,{ended,winner,continuing});if(opts.extraReport)next.pendingChoice=pendingChoice;next.breakShot=false;next.shots+=1;syncBallsAfterShot(next,facts,spotted);const report=buildShotReport(ctx,opts,{continuing,groupAssigned,pendingChoice,ended,winner});report.summary=summarizeReport(report,next,myName,oppName);next.log.push({shot:next.shots,shooter:me,summary:report.summary,fouls:report.fouls.map((f)=>f.code)});return{next,report};}
function countFouls(ctx,opts,{ended,winner}){if(opts.endedFirst&&ended)return{ended,winner};return FOUL_COUNTERS[opts.foulCounter]({...ctx,ended,winner});}
function advanceTurn(ctx,opts,{ended,winner,continuing}){const{next,me,opp,isBreak,fouls,fouled}=ctx;let pendingChoice=null;if(!ended){if(opts.illegalBreak.onFoul==='rerack'&&fouls.includes(FOUL.ILLEGAL_BREAK)){next.turn=opp;next.requiresRerack=true;next.ballInHand=null;}else if(fouled){next.turn=opp;next.ballInHand={zone:opts.ballInHandZone(isBreak)};}else if(opts.illegalBreak.notice&&opts.illegalBreak.notice()){next.turn=opp;next.ballInHand=null;pendingChoice={player:opp,kind:ILLEGAL_BREAK_NOTICE,breaker:me};}else if(!continuing){next.turn=opp;next.ballInHand=null;}else{next.ballInHand=null;}}else{next.phase='ended';next.winner=winner;next.ballInHand=null;}
return pendingChoice;}
function syncBallsAfterShot(next,facts,spotted){for(const b of next.balls){const after=facts.ballsAfter.find((x)=>x.id===b.id);if(!after)continue;if(spotted!==null&&b.number===spotted)continue;b.x=after.x;b.y=after.y;b.pocketed=after.pocketed;b.pocket=after.pocket;b.vx=b.vy=b.wx=b.wy=b.wz=0;}}
function buildShotReport(ctx,opts,{continuing,groupAssigned,pendingChoice,ended,winner}){const{next,facts,me,isBreak,fouls,fouled,pocketedObjects,spotted,notes}=ctx;return{kind:isBreak?'break':'shot',
shooter:me,
fouls:fouls.map((code)=>({code,text:FOUL_TEXT[code]})),
fouled,
pocketed:pocketedObjects.filter((p)=>!(spotted!==null&&p.number===spotted)),
cueScratched:facts.cueScratched,
firstContact:facts.firstContact,
railsAfterContact:facts.railsAfterContact,
objectBallsToRail:facts.objectBallsToRail,
continuing,
groupAssigned,
ballInHand:next.ballInHand?{player:next.turn,zone:next.ballInHand.zone}:null,
requiresRerack:next.requiresRerack,
spotted,
...(opts.extraReport?{pendingChoice}:{}),
ended,
winner,
notes,
unsettled:facts.settled===false,
summary:'',};}
function resolveEightBall(game,facts){const c=beginShot(game,facts);const fouled=judgeFouls(c);const outcome=judgeEightBallPocket({...c,fouled});return settleShot({...c,fouled,...outcome},EIGHT_BALL_SETTLE);}
function judgeEightBallPocket({next,facts,me,opp,myName,isBreak,fouled,pocketedObjects,notes}){const hasEight=next.balls.some((b)=>b.number===8);const eightPocketed=pocketedObjects.some((p)=>p.number===8);let ended=false;let winner=null;let spotted=null;if(!(eightPocketed&&hasEight))return{ended,winner,spotted};if(isBreak){if(spotEight(next)){spotted=8;notes.push('开球进 8 号球：按 4.3(e) 重摆回 8 号点，局面保持。');}
return{ended,winner,spotted};}
const myGroup=next.players[me].group;const clearedBefore=myGroup
?facts.onTableBefore.filter((n)=>n!==8).every((n)=>groupOf(n)!==myGroup)
:false;if(clearedBefore&&!fouled){ended=true;winner=me;notes.push(`${myName} 清完本组后合法打进 8 号球，赢下这一局。`);}else{ended=true;winner=opp;notes.push(
clearedBefore
?`${myName} 打进 8 号球，但这一杆犯规（WPA 4.8），判负。`
:`${myName} 本组球还没清完就打进 8 号球（WPA 4.8），判负。`
);}
return{ended,winner,spotted};}
function resolveNineBall(game,facts){const c=beginShot(game,facts);const{fouled,threeBallFailed}=judgeNineBallOpening(c);const outcome=judgeNineBallPocket({...c,fouled,threeBallFailed});return settleShot({...c,fouled,...outcome},nineBallSettle(threeBallFailed));}
function judgeNineBallOpening(ctx){const fouled=judgeFouls(ctx);if(!ctx.isBreak)return{fouled,threeBallFailed:false};return{fouled,threeBallFailed:judgeThreeBallRule(ctx)};}
function judgeThreeBallRule({next,facts,pocketedObjects,notes}){const line=headStringX(next.table);const crossed=facts.ballsAfter.filter((b)=>b.number!==0&&!b.pocketed&&b.x<line).length;const threeBallCount=pocketedObjects.length+crossed;if(threeBallCount>=3)return false;notes.push(
`开球只做到 ${threeBallCount} 颗目标球「进袋或越过开球线」`+
`（进 ${pocketedObjects.length} 颗、过线 ${crossed} 颗，要求 3 颗）——`+
'按 Regulation 16 属于「非法开球」，不是犯规；接手方可以选择照打或让原开球方再打一杆。'
);return true;}
function judgeNineBallPocket({next,me,myName,fouled,threeBallFailed,pocketedObjects,notes}){const ninePocketed=pocketedObjects.some((p)=>p.number===9);let ended=false;let winner=null;let spotted=null;if(!ninePocketed)return{ended,winner,spotted};if(fouled){if(spotBall(next,9)){spotted=9;notes.push('犯规时打进了 9 号球：按 WPA 5.6 把 9 号球摆回底点，局面继续。');}}else if(threeBallFailed){if(spotBall(next,9)){spotted=9;notes.push('开球没达到三球过线的要求却打进了 9 号球：按 Regulation 16(5) 摆回底点，不算赢局。');}}else{ended=true;winner=me;notes.push(`${myName} 合法打进 9 号球，赢下这一局（WPA 5.5）。`);}
return{ended,winner,spotted};}
function spotBall(game,number){const ball=game.balls.find((b)=>b.number===number);if(!ball)return false;const pos=footSpotPosition(game.table,game.balls,number);if(!pos)return false;ball.x=pos.x;ball.y=pos.y;ball.pocketed=false;ball.pocket=undefined;ball.vx=ball.vy=ball.wx=ball.wy=ball.wz=0;return true;}
export function acceptTable(game){game.pendingChoice=null;return game;}
export function handBackBreak(game){const c=game.pendingChoice;if(!c||c.kind!==ILLEGAL_BREAK_NOTICE)return game;game.turn=c.breaker;game.ballInHand=null;game.pendingChoice=null;game.log.push({shot:game.shots,
shooter:c.player,
summary:`接手方选择把这一杆交回给原开球方再打一杆（WPA Regulation 16(4)）。`,
fouls:[],});return game;}
function summarizeReport(report,game,myName,oppName){if(report.ended){return`${myName} 与 ${oppName} 的这一局结束：${game.players[report.winner]?.name ?? '—'} 获胜。`;}
const parts=[];if(report.kind==='break')parts.push('开球');if(report.pocketed.length)parts.push(`进 ${report.pocketed.map((p) => p.number).join('、')} 号`);else parts.push('没有球进袋');if(report.fouls.length)parts.push(`犯规：${report.fouls.map((f) => f.text).join('；')}`);if(report.pendingChoice)parts.push('开球不达标，接手方可以选择照打或交回');parts.push(report.continuing?`${myName} 继续`:`换 ${oppName}`);if(report.unsettled)parts.push('（这一杆没在限时内停稳，结果是按超时那一刻的球位算的）');return parts.join(' · ');}
export function rerack(game,rackedBalls){game.balls=rackedBalls.map((b)=>({...b}));game.turn=1-game.turn;game.players=game.players.map((p)=>({...p,group:null,fouls:0,warned:false}));game.breakShot=true;game.open=true;game.ballInHand=null;game.requiresRerack=false;game.pendingChoice=null;game.phase='playing';game.winner=null;return game;}
export function placementAllowed(game,x,y){if(!game.ballInHand)return true;if(!game.table.insideBounds(x,y))return false;if(game.ballInHand.zone==='kitchen')return x<=headStringX(game.table)+1e-9;if(game.ballInHand.zone==='d'){const{baulkX,dRadius}={baulkX:SNOOKER_SPOTS.baulkX,dRadius:SNOOKER_SPOTS.dRadius};const cy=game.table.width/2;if(x>baulkX+1e-9)return false;return Math.hypot(x-baulkX,y-cy)<=dRadius+1e-9;}
return true;}
export function placeCueBall(game,x,y){const cue=game.balls.find((b)=>isCueBall(b));if(!cue)return false;const R=game.table.ballRadius;const spot=findFreeSpot(game.table,game.balls.filter((b)=>b!==cue),R,{x,y},(px,py)=>
placementAllowed(game,px,py)
);if(!spot)return false;cue.x=spot.x;cue.y=spot.y;cue.pocketed=false;cue.pocket=undefined;cue.vx=cue.vy=cue.wx=cue.wy=cue.wz=0;return true;}
