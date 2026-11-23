import{cloneGame,
legalTargetNumbers,
numbersOnTable,
remainingOfGroup,}from'../src/rules.js';import{SEARCH_DT}from'../src/constants.js';import{createWorld,strike,stepWorld,allStopped,createRollTracker}from'../src/physics.js';import{ballLabel,cueRestText,pocketName,toleranceText}from'../src/solver.js';export function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}
const ESC_MAP={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};export function esc(value){return String(value??'').replace(/[&<>"']/g,(ch)=>ESC_MAP[ch]);}
export const DEFAULT_TABLE_BY_KIND=Object.freeze({eightball:'pool8',
nineball:'pool9',
snooker:'snooker',});export function tableForKind(kind,manualByKind={}){const fallback=DEFAULT_TABLE_BY_KIND[kind];if(!fallback)return null;if(kind==='snooker')return'snooker';const manual=manualByKind?.[kind];return typeof manual==='string'&&manual?manual:fallback;}
export function getPowerTier(speed){const min=0.55;const max=6.6;const clamped=clamp(speed,min,max);const ratio=(clamped-min)/(max-min);const pct=Math.round(ratio*100);if(pct<30){return{level:'轻力',
sub:'细腻走位',
pct,
ratio,
color:'#10b981',
badgeBg:'linear-gradient(135deg, #059669 0%, #10b981 100%)',
glow:'rgba(16, 185, 129, 0.5)',};}else if(pct<60){return{level:'中力',
sub:'标准进球',
pct,
ratio,
color:'#0ea5e9',
badgeBg:'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)',
glow:'rgba(14, 165, 233, 0.5)',};}else if(pct<85){return{level:'发力',
sub:'强拉长台',
pct,
ratio,
color:'#f59e0b',
badgeBg:'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)',
glow:'rgba(245, 158, 11, 0.5)',};}else{return{level:'爆杆',
sub:'强力冲球',
pct,
ratio,
color:'#ef4444',
badgeBg:'linear-gradient(135deg, #dc2626 0%, #f87171 100%)',
glow:'rgba(239, 68, 68, 0.65)',};}}
export function copyBallsForShot(balls){return balls.map((b)=>({...b,vx:0,vy:0,wx:0,wy:0,wz:0}));}
export function snapshotPositions(balls){return balls.map((b)=>({x:b.x,y:b.y,pocketed:b.pocketed,pocket:b.pocket}));}
export function restorePositions(balls,snapshot){for(let i=0;i<balls.length;i++){balls[i].x=snapshot[i].x;balls[i].y=snapshot[i].y;balls[i].pocketed=snapshot[i].pocketed;balls[i].pocket=snapshot[i].pocket;}}
export function captureBallFrame(balls,trackRoll){const roll=trackRoll();return balls.map((ball,index)=>({x:ball.x,
y:ball.y,
pocketed:ball.pocketed,
pocket:ball.pocket,
...roll[index],}));}
export function describeManualShot(balls){const pocketed=balls.filter((b)=>b.pocketed&&b.number!==0).map((b)=>b.number);const cuePocketed=balls.some((b)=>b.pocketed&&b.number===0);const detail=[];if(pocketed.length)detail.push(`进 ${pocketed.join('、')} 号`);if(cuePocketed)detail.push('母球落袋');if(!pocketed.length&&!cuePocketed)detail.push('没有球进袋');return{pocketed,cuePocketed,detail};}
export const NEXT_SHOT_SLOW_MS=50;export const AIM_NOTE_MIN_DEG=0.2;function aimOffsetNote(aimFrom,aimOffsetDeg,touched){if(!touched)return'';const off=Number(aimOffsetDeg);if(!Number.isFinite(off)||Math.abs(off)<AIM_NOTE_MIN_DEG)return'';const label=aimFrom==='solution'?'已偏离推荐':'已偏离直指方向';return`${label} ±${Math.abs(off).toFixed(1)}°`;}
function nextCandidateText(candidate,table){const bits=[];const number=candidate?.targetNumber;const pocket=candidate?.pocketId?pocketName(candidate.pocketId):'';if(typeof number==='number'&&pocket)bits.push(`${number} 号→${pocket}`);const tol=Number(candidate?.toleranceDeg);if(Number.isFinite(tol)&&tol>0)bits.push(`容错 ±${tol.toFixed(1)}°`);if(candidate?.cueRest){bits.push(cueRestText(table,candidate.cueRest).replace('母球建议停位：','母球停在'));}
return bits.join('，');}
function nextStepText({balls,candidates,table,finished,solveMs}){if(finished)return'本局已结束';const list=Array.isArray(balls)?balls.filter((b)=>b&&typeof b.number==='number'):[];const live=list.filter((b)=>b.number!==0&&!b.pocketed);if(!live.length)return'没有可以合法先碰的球';const cue=list.find((b)=>b.number===0);if(cue?.pocketed)return'没有可以合法先碰的球（母球落袋，先把它摆回台面）';if(!Number.isFinite(solveMs)||solveMs>=NEXT_SHOT_SLOW_MS)return'点「求解」看看';const best=Array.isArray(candidates)?candidates[0]:null;const text=best?nextCandidateText(best,table):'';if(!text)return'没有直接的进球线，点「求解」看组合球或防守';return text;}
export function describeNextShot(input){const{outcome,
balls,
candidates=null,
table=null,
finished=false,
aimFrom='direct',
aimOffsetDeg=0,
touched=false,
speed,
tipBLabel='',
tipALabel='',
solveMs=null,}=input??{};const detail=outcome?.detail?.length?outcome.detail.join(' · '):'没有球进袋';const params=[];const v=Number(speed);if(Number.isFinite(v))params.push(`${v.toFixed(2)} m/s`);if(tipBLabel)params.push(tipBLabel);if(tipALabel)params.push(tipALabel);const note=aimOffsetNote(aimFrom,aimOffsetDeg,touched);if(note)params.push(note);const head=params.length?`手打结果：${detail}（${params.join(' · ')}）`:`手打结果：${detail}`;const next=nextStepText({balls,candidates,table,finished,solveMs});return`${head}｜下一步：${next}`;}
export function findSpot(balls,table){const R2=table.ballRadius*2+1e-4;const clear=(x,y)=>
x>=table.bounds.minX&&x<=table.bounds.maxX&&
y>=table.bounds.minY&&y<=table.bounds.maxY&&
!balls.some((b)=>!b.pocketed&&Math.hypot(b.x-x,b.y-y)<R2);for(let ring=0;ring<60;ring++){const radius=ring*table.ballRadius*1.6;const count=ring===0?1:Math.max(8,ring*8);for(let i=0;i<count;i++){const a=(i/count)*Math.PI*2+ring*0.37;const x=table.length*0.5+Math.cos(a)*radius;const y=table.width*0.5+Math.sin(a)*radius*0.55;if(clear(x,y))return{x,y};}}
return null;}
const MAX_FRAME_STEPS=2400;export function simulateFrames(balls,table,shot,dt=SEARCH_DT){const copy=copyBallsForShot(balls);const world=createWorld(table,copy);const cue=copy.find((b)=>b.id==='cue');if(!cue)return null;strike(cue,shot);const trackRoll=createRollTracker(copy,table.ballRadius);const frames=[captureBallFrame(copy,trackRoll)];for(let i=0;i<MAX_FRAME_STEPS;i++){stepWorld(world,dt);frames.push(captureBallFrame(copy,trackRoll));if(allStopped(world))break;}
return{frames,balls:copy,dt};}
export const HISTORY_LIMIT=20;export function pushHistoryEntry(history,game,limit=HISTORY_LIMIT){history.push(cloneGame(game));if(history.length>limit)history.shift();return history;}
export function undoLabel(n){return n===0?'撤销上一杆':`撤销上一杆（${n}）`;}
export function practiceHint(state){if(state.mode!=='practice')return'';if(!state.solution?.found||!state.solution.best?.pocketId){return'先求解一个目标袋方案，再记录真实练习结果。';}
if(state.practiceRecorded)return'这一杆记下了。同一个球位可以接着记，换球位就再求解一次。';return'按实际结果点「进了」或「没进」——记下来才看得出进步。';}
export function practiceReady(state){return Boolean(
state.mode==='practice'&&
state.solution?.found&&
state.solution.best?.pocketId
);}
export function currentAim(state){const inGame=state.mode==='game';const sol=inGame?state.gSolution:state.solution;const balls=inGame?(state.game?.balls??[]):state.balls;const cue=balls.find((b)=>b.number===0&&!b.pocketed);if(!cue)return null;if(sol?.found&&sol.best){return{angle:sol.best.aimAngle,targetId:sol.best.targetId,from:'solution'};}
const allow=inGame&&state.game
?legalTargetNumbers(state.game,numbersOnTable(state.game.balls))
:null;const allowSet=allow?new Set(allow):null;let target=null;let bestD=Infinity;for(const b of balls){if(b.pocketed||b.number===0)continue;if(allowSet&&!allowSet.has(b.number))continue;const d=Math.hypot(b.x-cue.x,b.y-cue.y);if(d<bestD){bestD=d;target=b;}}
if(!target)return null;return{angle:Math.atan2(target.y-cue.y,target.x-cue.x),
targetId:target.id,
from:'direct',};}
export function getAimHUDInfo(state){const inGame=state.mode==='game';const sol=inGame?state.gSolution:state.solution;const tier=getPowerTier(state.manual.speed);if(sol?.found&&sol.best){const b=sol.best;return{title:'第一人称瞄准',
detail:`${b.targetNumber} 号球 → ${pocketName(b.pocketId)} · 容错 ±${b.toleranceDeg.toFixed(2)}° · ${tier.level} ${state.manual.speed.toFixed(2)} m/s`,
ghost:b.ghost,};}
const aim=currentAim(state);if(aim){const balls=inGame?(state.game?.balls??[]):state.balls;const target=balls.find((b)=>b.id===aim.targetId);return{title:'第一人称手打瞄准',
detail:`${target ? target.number + ' 号球 · ' : ''}力度 ${state.manual.speed.toFixed(2)} m/s (${tier.level} ${tier.pct}%)`,
ghost:target?{x:target.x,y:target.y}:null,};}
return{title:'第一人称瞄准',
detail:`力度 ${state.manual.speed.toFixed(2)} m/s (${tier.level}) · 按 V 切换俯视`,
ghost:null,};}
export function restoreGameState(game,saved){game.players=saved.players.map((p)=>({...p}));game.turn=saved.turn;game.breakShot=saved.breakShot;game.open=saved.open;game.ballInHand=saved.ballInHand?{...saved.ballInHand}:null;game.requiresRerack=saved.requiresRerack;game.phase=saved.phase;game.winner=saved.winner;game.shots=saved.shots;game.log=Array.isArray(saved.log)
?saved.log.map((e)=>({...e,fouls:Array.isArray(e?.fouls)?e.fouls.slice():[]}))
:[];if(saved.snooker&&game.snooker)game.snooker={...saved.snooker,scores:saved.snooker.scores.slice()};return game;}
export const SAVE_COORD_DECIMALS=3;export const SAVE_HISTORY_BUDGET=256*1024;const COORD_SCALE=10**SAVE_COORD_DECIMALS;export function saveCoord(v){return typeof v==='number'&&Number.isFinite(v)?Math.round(v*COORD_SCALE)/COORD_SCALE:0;}
export function utf8Bytes(text){let n=0;for(const ch of String(text)){const code=ch.codePointAt(0);n+=code<0x80?1:code<0x800?2:code<0x10000?3:4;}
return n;}
const POCKET_ON_TABLE=-1;const POCKET_UNKNOWN=-2;const ZONES=[null,'kitchen','anywhere','d'];const GROUPS=[null,'solid','stripe'];function zoneCode(ballInHand){const i=ZONES.indexOf(ballInHand?.zone??null);return i<0?0:i;}
function zoneFromCode(code){const zone=ZONES[code]??null;return zone?{zone}:null;}
function groupCode(group){const i=GROUPS.indexOf(group??null);return i<0?0:i;}
function groupFromCode(code){return GROUPS[code]??null;}
function ballOnCode(ballOn){if(ballOn==='red')return 0;if(ballOn==='color')return 1;return Number.isFinite(ballOn)?ballOn:0;}
function ballOnFromCode(code){if(code===0)return'red';if(code===1)return'color';return Number.isFinite(code)&&code>=16&&code<=21?code:'red';}
function pocketCode(ball,pocketIds){if(!ball.pocketed)return POCKET_ON_TABLE;const i=typeof ball.pocket==='string'?pocketIds.indexOf(ball.pocket):-1;return i<0?POCKET_UNKNOWN:i;}
function ballIdsOf(game){return game.balls.map((b)=>b.id);}
function sameIds(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function encodeStep(entry,pocketIds){const x=[];for(const b of entry.balls)x.push(saveCoord(b.x),saveCoord(b.y),pocketCode(b,pocketIds));const step={s:Number.isFinite(entry.shots)?entry.shots:0,
t:entry.turn===1?1:0,
k:entry.breakShot?1:0,
o:entry.open?1:0,
h:zoneCode(entry.ballInHand),
r:entry.requiresRerack?1:0,
e:entry.phase==='ended'?1:0,
w:entry.winner===0||entry.winner===1?entry.winner:-1,
g:entry.players.map((p)=>groupCode(p.group)),
f:entry.players.map((p)=>(Number.isFinite(p.fouls)?Math.max(0,Math.floor(p.fouls)):0)),
n:entry.players.map((p)=>(p.warned?1:0)),
l:Array.isArray(entry.log)?entry.log.length:0,
x,};if(entry.snooker){step.c=[
entry.snooker.scores[0],
entry.snooker.scores[1],
ballOnCode(entry.snooker.ballOn),
entry.snooker.reds,
];}
return step;}
export function packHistory(history,{limit=HISTORY_LIMIT,budget=SAVE_HISTORY_BUDGET}={}){const list=Array.isArray(history)?history:[];const src=list.slice(Math.max(0,list.length-limit));const steps=[];const newest=src[src.length-1];const ids=newest?ballIdsOf(newest):[];const pocketIds=newest?newest.table.pockets.map((p)=>p.id):[];let dropped=list.length-src.length;for(let i=src.length-1;i>=0;i-=1){const entry=src[i];if(!sameIds(ballIdsOf(entry),ids)){dropped+=i+1;break;}
const trial=[encodeStep(entry,pocketIds),...steps];if(steps.length>0&&utf8Bytes(JSON.stringify({b:ids,s:trial}))>budget){dropped+=i+1;break;}
steps.unshift(trial[0]);}
const payload={b:ids,s:steps,d:dropped};payload.bytes=utf8Bytes(JSON.stringify(payload));return payload;}
function decodeStep(step,baseGame,slots,pocketIds){const entry=cloneGame(baseGame);entry.pendingChoice=null;entry.shots=Number.isFinite(step.s)?Math.max(0,Math.floor(step.s)):0;entry.turn=step.t===1?1:0;entry.breakShot=Boolean(step.k);entry.open=Boolean(step.o);entry.ballInHand=zoneFromCode(step.h);entry.requiresRerack=Boolean(step.r);entry.phase=step.e?'ended':'playing';entry.winner=step.w===0||step.w===1?step.w:null;const groups=Array.isArray(step.g)?step.g:[];const fouls=Array.isArray(step.f)?step.f:[];const warned=Array.isArray(step.n)?step.n:[];entry.players=baseGame.players.map((p,i)=>({name:p.name,
group:groupFromCode(groups[i]),
fouls:Number.isFinite(fouls[i])?Math.max(0,Math.floor(fouls[i])):0,
warned:Boolean(warned[i]),}));const logLen=Number.isFinite(step.l)?clamp(Math.floor(step.l),0,baseGame.log.length):0;entry.log=baseGame.log.slice(0,logLen);if(entry.snooker&&Array.isArray(step.c)){entry.snooker={scores:[
Number.isFinite(step.c[0])?Math.max(0,Math.floor(step.c[0])):0,
Number.isFinite(step.c[1])?Math.max(0,Math.floor(step.c[1])):0,
],
ballOn:ballOnFromCode(step.c[2]),
reds:Number.isFinite(step.c[3])?Math.max(0,Math.floor(step.c[3])):0,};}
for(let i=0;i<slots.length;i+=1){const ball=entry.balls[slots[i]];if(!ball)continue;ball.x=saveCoord(step.x[i*3]);ball.y=saveCoord(step.x[i*3+1]);const code=step.x[i*3+2];if(code===POCKET_ON_TABLE){ball.pocketed=false;ball.pocket=null;}else if(code===POCKET_UNKNOWN){ball.pocketed=true;ball.pocket=null;}else{ball.pocketed=true;ball.pocket=pocketIds[code]??null;}}
return entry;}
function historyCoordLimit(table){const b=table?.bounds;if(!b||![b.minX,b.maxX,b.minY,b.maxY].every((v)=>Number.isFinite(v)))return null;const r=Number.isFinite(table.ballRadius)?table.ballRadius:0;const jaw=Array.isArray(table.pockets)
?table.pockets.reduce((m,p)=>(Number.isFinite(p?.captureR)?Math.max(m,p.captureR):m),0)
:0;const margin=Math.max(2*r,jaw);return{minX:b.minX-margin,
maxX:b.maxX+margin,
minY:b.minY-margin,
maxY:b.maxY+margin,};}
function stepInRange(x,limit){if(!limit)return true;for(let i=0;i+2<x.length;i+=3){const px=x[i];const py=x[i+1];if(!(px>=limit.minX&&px<=limit.maxX&&py>=limit.minY&&py<=limit.maxY))return false;}
return true;}
export function unpackHistory(packed,baseGame){const empty={entries:[],dropped:0};if(!packed||!baseGame||!Array.isArray(packed.s)||packed.s.length===0)return empty;const ids=Array.isArray(packed.b)?packed.b:[];const slots=ids.map((id)=>baseGame.balls.findIndex((b)=>b.id===id));if(ids.length===0||slots.some((i)=>i<0))return empty;const pocketIds=baseGame.table.pockets.map((p)=>p.id);const limit=historyCoordLimit(baseGame.table);const entries=[];for(const step of packed.s){if(!step||!Array.isArray(step.x)||step.x.length!==ids.length*3)continue;if(!stepInRange(step.x,limit))continue;entries.push(decodeStep(step,baseGame,slots,pocketIds));}
const declared=Number.isFinite(packed.d)?Math.max(0,Math.floor(packed.d)):0;return{entries,dropped:declared+(packed.s.length-entries.length)};}
export function reduceAutoPause(prev,action){switch(action){case'undo':
return{autoPaused:true,autoPauseReason:'undo'};case'load':
return{autoPaused:true,autoPauseReason:'load'};case'user-shot':
case'resume':
case'new-game':
return{autoPaused:false,autoPauseReason:null};default:
return{autoPaused:Boolean(prev?.autoPaused),
autoPauseReason:prev?.autoPauseReason??null,};}}
export function shouldAutoShoot(state){const g=state?.game;if(!g||g.phase==='ended')return false;if(!state.autoOpponent||state.autoPaused)return false;if(g.turn!==1)return false;if(state.animating||state.opponentThinking)return false;return true;}
export function autoPauseHint(state){const g=state?.game;if(!g||g.phase==='ended')return null;if(state.autoPaused){return{level:'paused',
canResume:true,
text:
state.autoPauseReason==='undo'
?'已暂停对手自动出杆 —— 撤销之后先让你看清局面，点此继续'
:'已暂停对手自动出杆 —— 读档之后先让你看清局面，点此继续',};}
if(!state.autoOpponent&&g.turn===1){return{level:'off',
canResume:false,
text:'对手自动出杆已关闭 —— 轮到对手，点「求解」自己打这一杆',};}
return null;}
export function reduceSaveWrite(stored,own){const mine=own??{};if(!stored)return{write:true,reason:'empty'};if(mine.overwrite)return{write:true,reason:'confirmed'};if(stored.session&&mine.session&&stored.session!==mine.session){return{write:false,reason:'other-tab'};}
if(mine.stamp!==null&&mine.stamp!==undefined&&stored.stamp!==mine.stamp){return{write:false,reason:'changed'};}
return{write:true,reason:'same'};}
const POTTED_NUMBERS=/进\s*(\d+(?:\s*[、,，]\s*\d+)*)\s*号/;const SNOOKER_POINTS=/得\s*(\d+)\s*分/;const FOUL_WORD=/犯规/;const GAME_ENDED=/这一局结束/;export const MATCH_RECENT_LIMIT=10;function readLogEntry(raw,kind){const e=raw&&typeof raw==='object'?raw:{};const summary=typeof e.summary==='string'?e.summary:'';const fouls=Array.isArray(e.fouls)?e.fouls.filter((c)=>typeof c==='string'&&c):[];const shotNumber=Number(e.shot);const shooterNumber=Number(e.shooter);let balls=0;const numbers=POTTED_NUMBERS.exec(summary);if(numbers){balls=numbers[1].split(/[、,，]/).filter((n)=>n.trim()).length;}else if(kind==='snooker'){const points=SNOOKER_POINTS.exec(summary);if(points&&Number(points[1])>0)balls=1;}
const foul=fouls.length>0||FOUL_WORD.test(summary);return{shot:Number.isFinite(shotNumber)&&shotNumber>0?Math.floor(shotNumber):null,
shooter:shooterNumber===0||shooterNumber===1?shooterNumber:null,
foul,
potted:balls>0&&!foul,
balls,
end:GAME_ENDED.test(summary),};}
function isPotted(entry,winner){return entry.potted||(entry.end&&!entry.foul&&winner!==null&&entry.shooter===winner);}
export function computeMatchStats(input){const src=input&&typeof input==='object'?input:{};const log=Array.isArray(src.log)?src.log:[];const kind=typeof src.kind==='string'?src.kind:'';const entries=readMatchLog(log,kind);let highestShot=0;for(const entry of entries){if(entry.shot!==null&&entry.shot>highestShot)highestShot=entry.shot;}
const shots=highestShot>0?highestShot:entries.length;const w=src.winner;const winner=w===0||w===1?w:w==='0'?0:w==='1'?1:null;const me=Number(src.myself)===1?1:0;let pots=0;let fouls=0;let run=0;let longestRun=0;let lastShooter=null;for(const entry of entries){if(entry.foul)fouls+=1;const potted=isPotted(entry,winner);if(potted){pots+=1;run=lastShooter!==null&&entry.shooter===lastShooter?run+1:1;if(run>longestRun)longestRun=run;}else{run=0;}
if(entry.shooter!==null)lastShooter=entry.shooter;}
return{shots,
pots,
potRate:shots>0?pots/shots:null,
longestRun,
fouls,
result:winner===null?'undecided':winner===me?'win':'loss',};}
export function summarizeHistory(entries){const list=Array.isArray(entries)?entries:[];let matches=0;let wins=0;let losses=0;let undecided=0;let shots=0;let longestRun=0;let weightedRate=0;let weightedShots=0;const results=[];for(const raw of list){if(!raw||typeof raw!=='object')continue;const result=raw.result==='win'||raw.result==='loss'?raw.result:'undecided';const oneShots=
typeof raw.shots==='number'&&Number.isFinite(raw.shots)&&raw.shots>0
?Math.floor(raw.shots)
:0;const rate=
typeof raw.potRate==='number'&&Number.isFinite(raw.potRate)
?clamp(raw.potRate,0,1)
:null;const run=
typeof raw.longestRun==='number'&&Number.isFinite(raw.longestRun)&&raw.longestRun>0
?Math.floor(raw.longestRun)
:0;matches+=1;if(result==='win')wins+=1;else if(result==='loss')losses+=1;else undecided+=1;shots+=oneShots;if(rate!==null&&oneShots>0){weightedRate+=rate*oneShots;weightedShots+=oneShots;}
if(run>longestRun)longestRun=run;results.push(result);}
return{matches,
wins,
losses,
undecided,
shots,
potRate:weightedShots>0?weightedRate/weightedShots:null,
longestRun,
recent:results.slice(-MATCH_RECENT_LIMIT),};}
const SHARE_TOL_PREFIX=/^容错\s*/;const SHARE_REST_PREFIX=/^母球建议停位[：:]?\s*/;export function buildShareSummary({shot,table,balls}={}){const card=shot&&typeof shot==='object'?shot:{};const best=card.best&&typeof card.best==='object'?card.best:null;const candidate=best||(looksLikeCandidate(card)?card:null);if(card.found===false||!candidate){const message=typeof card.message==='string'?card.message.trim():'';return{title:'这一杆没有可以直接进攻的球',
lines:[{label:'说明',value:message||'需要打防守，或先解一杆。'}],};}
const c=candidate;const ball=shareBallText(c.targetNumber);const pocket=
typeof c.pocketId==='string'&&c.pocketId?pocketName(c.pocketId):'';const lines=[
{label:'目标球',value:ball},
{label:'袋口',value:pocket||'不限（只保证合法碰球）'},
{label:'杆法',value:shareTipText(c)},
{label:'力度',value:sharePowerText(c)},
{label:'切角',value:shareCutText(c)},
{label:'容错',value:shareToleranceText(c)},
{label:'母球落点',value:shareCueRestText(table,c,balls)},
];if(c.scratchRisk===true||(c.cuePath&&c.cuePath.kind==='pocket')){lines.push({label:'⚠ 注意',value:'母球有摔袋风险'});}
return{title:pocket?`${ball} → ${pocket}`:`${ball}（不指定袋口）`,
lines,};}
function looksLikeCandidate(obj){return(
(typeof obj.targetNumber==='number'&&Number.isFinite(obj.targetNumber))||
(typeof obj.pocketId==='string'&&obj.pocketId.length>0)
);}
function shareBallText(number){if(typeof number!=='number'||!Number.isFinite(number)||number<=0)return'—';return ballLabel(number);}
function shareTipText(c){const name=c.tip&&typeof c.tip.name==='string'?c.tip.name.trim():'';return name||'—';}
function sharePowerText(c){const name=c.power&&typeof c.power.name==='string'?c.power.name.trim():'';const speed=typeof c.speed==='number'&&Number.isFinite(c.speed)?c.speed:null;if(name&&speed!==null)return`${name}力（${speed.toFixed(2)} m/s）`;if(name)return`${name}力`;if(speed!==null)return`${speed.toFixed(2)} m/s`;return'—';}
function shareCutText(c){return typeof c.cutDeg==='number'&&Number.isFinite(c.cutDeg)
?`${c.cutDeg.toFixed(0)}°`
:'—';}
function shareToleranceText(c){if(typeof c.toleranceDeg!=='number'||!Number.isFinite(c.toleranceDeg))return'—';if(c.toleranceDeg<=0)return'—';const text=toleranceText(c).replace(SHARE_TOL_PREFIX,'').trim();return text||'—';}
function shareCueRestText(table,c,balls){const rest=c.cueRest;if(rest&&typeof rest==='object'&&Number.isFinite(rest.x)&&Number.isFinite(rest.y)){const text=cueRestText(table,rest).replace(SHARE_REST_PREFIX,'').trim();if(text&&text!=='—')return text;}
const cue=cueBallOf(balls);if(cue&&cue.pocketed===true)return'母球已落袋';return'未要求走位';}
function cueBallOf(balls){if(!Array.isArray(balls))return null;for(const b of balls){if(!b||typeof b!=='object')continue;if(b.number===0||b.id==='cue')return b;}
return null;}
const TABLE_GROUP_NAME={solid:'全色',stripe:'花色'};const TABLE_KIND_LABEL={eightball:'八球',nineball:'九球',snooker:'斯诺克'};export function buildTableSummary(input={}){const opts=input&&typeof input==='object'?input:{};const g=opts.game&&typeof opts.game==='object'?opts.game:null;const list=tableBallsOf(opts.balls,g);const onTable=numbersOnTable(list);const cue=cueBallOf(list);const next=tableNextShotText(opts.shot);if(!g)return practiceTableSummary(onTable,cue,next);return matchTableSummary(g,onTable,next);}
function tableBallsOf(balls,g){const source=Array.isArray(balls)
?balls
:Array.isArray(g&&g.balls)
?g.balls
:[];return source.filter((b)=>b&&typeof b==='object');}
function practiceTableSummary(onTable,cue,next){const n=onTable.length;const title=n?`练习台面 · 还剩 ${n} 颗球`:'练习台面 · 已经清台';return{title,
lines:[
{label:'玩法',value:'练习摆球（还没开局）'},
{label:'台面',
value:`${n} 颗目标球 · ${cue ? '母球在台上' : '母球不在台上'}`,},
{label:'下一步',value:next},
],
mark:{numbers:[],label:'练习摆球'},};}
function matchTableSummary(g,onTable,next){const kind=typeof g.kind==='string'?g.kind:'';const kindLabel=TABLE_KIND_LABEL[kind]||'对局';const players=Array.isArray(g.players)?g.players:[];const nameOf=(i)=>{const p=players[i];const name=p&&typeof p.name==='string'?p.name.trim():'';return name||`玩家 ${i + 1}`;};const groupOfPlayer=(i)=>{const p=players[i];return p&&(p.group==='solid'||p.group==='stripe')?p.group:null;};const p0=nameOf(0);const p1=nameOf(1);const g0=groupOfPlayer(0);const g1=groupOfPlayer(1);const left0=g0?remainingOfGroup(onTable,g0):0;const left1=g1?remainingOfGroup(onTable,g1):0;const ended=g.phase==='ended';const winnerName=
ended&&typeof g.winner==='number'&&players[g.winner]?nameOf(g.winner):'';const shots=Number.isFinite(g.shots)?g.shots:0;const turn=g.turn===1?1:0;const turnGroup=turn===0?g0:g1;const title=ended
?`${kindLabel} · ${winnerName ? `${winnerName} 获胜` : '本局结束'}`
:`${kindLabel} · ${shots > 0 ? `第 ${shots} 杆` : '开球'}`;const lines=[];if(ended){lines.push({label:'状态',value:winnerName?`本局结束 · ${winnerName} 获胜`:'本局结束'});}else{const who=nameOf(turn);lines.push({label:'轮到',
value:kind==='eightball'?`${who}（${turnGroup ? TABLE_GROUP_NAME[turnGroup] : '未分组'}）`:who,});}
if(kind==='snooker'){const scores=g.snooker&&Array.isArray(g.snooker.scores)?g.snooker.scores:[];const s0=Number.isFinite(scores[0])?scores[0]:0;const s1=Number.isFinite(scores[1])?scores[1]:0;lines.push({label:'比分',value:`${p0} ${s0} : ${s1} ${p1}`});}else if(kind==='nineball'){lines.push({label:'比分',
value:onTable.length
?`已进 ${Math.max(0, 9 - onTable.length)} 颗 · 台面剩 ${onTable.length} 颗`
:'台面已清空',});}else if(!g0&&!g1){lines.push({label:'比分',value:`未分球 · 台面剩 ${onTable.length} 颗`});}else{const potted0=g0?7-left0:0;const potted1=g1?7-left1:0;lines.push({label:'比分',value:`${p0} ${potted0} : ${potted1} ${p1}`});}
if(kind==='snooker'){lines.push({label:'球局',value:snookerTableText(g,onTable)});}else if(kind==='nineball'){const target=onTable.length?Math.min(...onTable):null;lines.push({label:'球组',
value:target?`无分组 · 目标 ${target} 号球 · 台面剩 ${onTable.length} 颗`:'无分组 · 台面已清空',});}else if(!g0&&!g1){lines.push({label:'球组',value:`未分球 · 台面剩 ${onTable.length} 颗`});}else{const left=[
`${p0} ${g0 ? TABLE_GROUP_NAME[g0] : '未分组'} 剩 ${g0 ? left0 : 0}`,
`${p1} ${g1 ? TABLE_GROUP_NAME[g1] : '未分组'} 剩 ${g1 ? left1 : 0}`,
].join(' · ');const onlyEight=onTable.length===1&&onTable[0]===8;lines.push({label:'球组',value:onlyEight?`${left} · 只剩黑八`:left});}
lines.push({label:'下一步',value:next});const targets=safeLegalTargets(g,onTable);return{title,
lines,
mark:{numbers:targets,label:tableMarkLabel(kind,turnGroup,targets)},};}
function tableMarkLabel(kind,turnGroup,targets){if(kind==='eightball')return turnGroup?TABLE_GROUP_NAME[turnGroup]:'未分组';if(kind==='nineball')return targets.length?`目标 ${targets[0]} 号球`:'台面已清空';if(kind==='snooker')return'当前该打';return'台面';}
function snookerTableText(g,onTable){const redsOnTable=onTable.filter((n)=>n>=1&&n<=15).length;const fromGame=g.snooker&&Number.isFinite(g.snooker.reds)?g.snooker.reds:null;const reds=redsOnTable||(fromGame===null?0:fromGame);const ballOn=g.snooker?g.snooker.ballOn:'red';return`红球剩 ${reds} 颗 · 该打 ${snookerBallOnText(ballOn)}`;}
function snookerBallOnText(ballOn){if(ballOn==='red')return'红球';if(ballOn==='color')return'任意彩球';if(typeof ballOn==='number'&&Number.isFinite(ballOn)&&ballOn>0)return ballLabel(ballOn);return'红球';}
function safeLegalTargets(g,onTable){try{const list=legalTargetNumbers(g,onTable);return Array.isArray(list)
?list.filter((n)=>typeof n==='number'&&Number.isFinite(n))
:[];}catch{return[];}}
function tableNextShotText(shot){const card=shot&&typeof shot==='object'?shot:null;if(!card)return'还没求解';const best=card.best&&typeof card.best==='object'?card.best:null;const cand=best||(looksLikeCandidate(card)?card:null);if(!cand){const message=typeof card.message==='string'?card.message.trim():'';if(message)return message;if(card.found===false)return'求解过：没有可直接进攻的球，先防守或解一杆。';return'还没求解';}
const ball=shareBallText(cand.targetNumber);const pocket=typeof cand.pocketId==='string'&&cand.pocketId?pocketName(cand.pocketId):'';const tip=cand.tip&&typeof cand.tip.name==='string'?cand.tip.name.trim():'';const power=cand.power&&typeof cand.power.name==='string'?cand.power.name.trim():'';const how=[tip,power?`${power}力`:''].filter(Boolean).join(' · ');const main=pocket?`${ball} → ${pocket}`:`${ball}（不指定袋口）`;return how?`${main}，${how}`:main;}
const MATCH_CHART_LIMIT=60;const MATCH_KEY_LIMIT=3;const FOUL_CODE_TEXT={illegal_break:'开球不合法',
scratch:'母球落袋',
no_contact:'母球没碰到球',
wrong_ball_first:'先碰错球',
no_rail:'无球碰库',
wrong_ball_potted:'打进不该进的球',};function readMatchLog(log,kind){const entries=[];const seen=new Set();for(const raw of log){const entry=readLogEntry(raw,kind);if(entry.shot!==null){if(seen.has(entry.shot))continue;seen.add(entry.shot);}
entries.push({...entry,raw});}
return entries;}
function matchWinnerOf(game){const w=game.winner;if(w===0||w===1)return w;if(w==='0')return 0;if(w==='1')return 1;return null;}
function matchPlayerName(game,i){const players=Array.isArray(game.players)?game.players:[];const p=players[i];const name=p&&typeof p.name==='string'?p.name.trim():'';return name||(i===0?'你':'对手');}
function matchSeriesOf(entries,winner){const series=[{x:0,y1:0,y2:0}];const pots=[0,0];let y1=0;let y2=0;let lastX=0;for(const entry of entries){const x=entry.shot!==null&&entry.shot>lastX?entry.shot:lastX+1;lastX=x;if(isPotted(entry,winner)){if(entry.shooter===0){pots[0]+=1;y1+=1;}else if(entry.shooter===1){pots[1]+=1;y2+=1;}}
series.push({x,y1,y2});}
return{series,pots};}
function sampleMatchSeries(points,limit){if(points.length<=limit)return points;const out=[];const last=points.length-1;for(let i=0;i<limit;i+=1){const p=points[Math.round((i*last)/(limit-1))];if(!out.length||out[out.length-1].x!==p.x)out.push(p);}
if(out[out.length-1].x!==points[last].x)out.push(points[last]);return out;}
function longestRunRange(entries,winner){let best={len:0,from:null,to:null};let run=0;let from=null;let lastShooter=null;for(const entry of entries){if(!isPotted(entry,winner)){run=0;lastShooter=null;continue;}
const same=lastShooter!==null&&entry.shooter===lastShooter;run=same?run+1:1;if(!same)from=entry.shot;lastShooter=entry.shooter;if(run>best.len)best={len:run,from,to:entry.shot};}
return best;}
function bestToleranceShot(input){const lists=[input&&input.shots,input&&input.attempts];let best=null;for(const list of lists){if(!Array.isArray(list))continue;for(const c of list){if(!c||typeof c!=='object')continue;const deg=Number(c.toleranceDeg);if(!Number.isFinite(deg)||deg<=0)continue;const shot=Number(c.shot);const target=Number(c.targetNumber);const item={shot:Number.isFinite(shot)&&shot>0?Math.floor(shot):null,
targetNumber:Number.isFinite(target)&&target>0?target:null,
pocketId:typeof c.pocketId==='string'?c.pocketId:'',
toleranceDeg:deg,};if(!best||item.toleranceDeg>best.toleranceDeg)best=item;}}
return best;}
function foulBreakdownText(entries,total){const tally=new Map();for(const entry of entries){if(!entry.foul)continue;const codes=entry.raw&&Array.isArray(entry.raw.fouls)?entry.raw.fouls:[];for(const code of codes){if(typeof code!=='string'||!code)continue;tally.set(code,(tally.get(code)||0)+1);}}
const all=[...tally.entries()].sort((a,b)=>b[1]-a[1]);if(!all.length)return`${total} 次`;const parts=all
.slice(0,2)
.map(([code,n])=>`${FOUL_CODE_TEXT[code] || code} ×${n}`);const more=all.length>2?` 等 ${all.length} 类`:'';return`${total} 次（${parts.join('、')}${more}）`;}
function matchKeyLines({entries,stats,winner,winnerName,shots}){const lines=[];const run=longestRunRange(entries,winner);if(run.len>=2){const where=run.from===run.to?`第 ${run.from} 杆`:`第 ${run.from}–${run.to} 杆`;lines.push(`最长连击 ${run.len} 杆（${where}）`);}
const tol=bestToleranceShot(shots);if(tol){const ball=tol.targetNumber?shareBallText(tol.targetNumber):'';const pocket=tol.pocketId?pocketName(tol.pocketId):'';const where=ball&&pocket?`${ball} → ${pocket}`:ball||pocket||`第 ${tol.shot} 杆`;lines.push(`最大容错杆 ${where} ±${tol.toleranceDeg.toFixed(2)}°`);}
if(stats.fouls>0)lines.push(`犯规 ${foulBreakdownText(entries, stats.fouls)}`);if(lines.length<MATCH_KEY_LIMIT){const end=entries.filter((e)=>e.end).pop();if(end)lines.push(`收官一杆 第 ${end.shot} 杆 · ${winnerName} 赢下这一局`);}
if(!lines.length)lines.push('这一局没有可复盘的关键杆');return lines.slice(0,MATCH_KEY_LIMIT).map((value,i)=>({label:`关键杆 ${i + 1}`,
value,}));}
export function buildMatchSummary(input={}){const opts=input&&typeof input==='object'?input:{};const game=opts.game&&typeof opts.game==='object'?opts.game:null;if(!game)return null;if(game.phase!=='ended')return null;const winner=matchWinnerOf(game);if(winner===null)return null;const kind=typeof game.kind==='string'?game.kind:'';const log=Array.isArray(opts.log)
?opts.log
:Array.isArray(game.log)
?game.log
:[];const entries=readMatchLog(log,kind);if(!entries.length)return null;if(!entries.some((e)=>e.shot!==null))return null;const derived=computeMatchStats({log,kind,winner});const src=opts.stats&&typeof opts.stats==='object'?opts.stats:{};const pick=(v,fallback)=>(typeof v==='number'&&Number.isFinite(v)&&v>=0?v:fallback);const stats={shots:Math.floor(pick(src.shots,derived.shots)),
potRate:
typeof src.potRate==='number'&&Number.isFinite(src.potRate)
?clamp(src.potRate,0,1)
:derived.potRate,
longestRun:Math.floor(pick(src.longestRun,derived.longestRun)),
fouls:Math.floor(pick(src.fouls,derived.fouls)),};const{series,pots}=matchSeriesOf(entries,winner);const oppName=matchPlayerName(game,1);const kindLabel=TABLE_KIND_LABEL[kind]||'对局';let mine=pots[0];let theirs=pots[1];if(kind==='snooker'){const scores=game.snooker&&Array.isArray(game.snooker.scores)?game.snooker.scores:[];if(Number.isFinite(scores[0])&&Number.isFinite(scores[1])){mine=scores[0];theirs=scores[1];}}
const lines=matchKeyLines({entries,
stats,
winner,
winnerName:matchPlayerName(game,winner),
shots:opts,});let chart=series;if(series.length>MATCH_CHART_LIMIT){chart=sampleMatchSeries(series,MATCH_CHART_LIMIT);lines.push({label:'走势',
value:`共 ${series.length - 1} 杆，折线降采样到 ${chart.length} 点`,});}
lines.push({label:'杆数',value:`${stats.shots} 杆`});lines.push({label:'命中率',value:stats.potRate===null?'—':`${Math.round(stats.potRate * 100)}%`});lines.push({label:'最长连击',value:`${stats.longestRun} 杆`});lines.push({label:'犯规',value:`${stats.fouls} 次`});return{title:`${kindLabel} · 我 ${mine} : ${theirs} ${oppName}`,
lines,
chart,};}
