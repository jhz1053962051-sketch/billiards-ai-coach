import{findFreeSpot}from'./rack.js';import{SNOOKER_SPOTS}from'./constants.js';export const RED_MIN=1;export const RED_MAX=15;export const YELLOW=16;export const GREEN=17;export const BROWN=18;export const BLUE=19;export const PINK=20;export const BLACK=21;export const COLOR_ORDER=Object.freeze([YELLOW,GREEN,BROWN,BLUE,PINK,BLACK]);export function valueOf(number){if(number>=RED_MIN&&number<=RED_MAX)return 1;const i=COLOR_ORDER.indexOf(number);return i<0?0:i+2;}
export function isRed(number){return number>=RED_MIN&&number<=RED_MAX;}
export function isColor(number){return COLOR_ORDER.includes(number);}
export function ballName(number){if(number===0)return'母球';if(isRed(number))return'红球';const names={[YELLOW]:'黄球',[GREEN]:'绿球',[BROWN]:'咖啡球',[BLUE]:'蓝球',[PINK]:'粉球',[BLACK]:'黑球'};return names[number]??`${number} 号球`;}
export function snookerSpots(table){const L=table.length;const W=table.width;const baulkX=SNOOKER_SPOTS.baulkX;const dRadius=SNOOKER_SPOTS.dRadius;return{baulkX,
dRadius,
brown:{x:baulkX,y:W/2},
yellow:{x:baulkX,y:W/2-dRadius},
green:{x:baulkX,y:W/2+dRadius},
blue:{x:L/2,y:W/2},
pink:{x:(L/2+L)/2,y:W/2},
black:{x:L-SNOOKER_SPOTS.blackFromTop,y:W/2},};}
export function spotFor(table,number){const s=snookerSpots(table);switch(number){case YELLOW:return s.yellow;case GREEN:return s.green;case BROWN:return s.brown;case BLUE:return s.blue;case PINK:return s.pink;case BLACK:return s.black;default:return null;}}
function blackRespotPosition(table,balls,black){const spot=spotFor(table,BLACK);const R=table.ballRadius;const others=balls.filter((b)=>b!==black&&!b.pocketed);const minDist=2*R+1e-4;const clear=(x,y)=>
x>=table.bounds.minX&&
x<=table.bounds.maxX&&
y>=table.bounds.minY&&
y<=table.bounds.maxY&&
others.every((o)=>Math.hypot(o.x-x,o.y-y)>=minDist);if(clear(spot.x,spot.y))return{x:spot.x,y:spot.y,kind:'spot',offset:0};const step=R*0.25;for(let d=step;spot.x+d<=table.bounds.maxX;d+=step){if(clear(spot.x+d,spot.y)){return{x:spot.x+d,y:spot.y,kind:'line',offset:d};}}
const free=findFreeSpot(table,others,R,spot);if(free){return{x:free.x,
y:free.y,
kind:'free',
offset:Math.hypot(free.x-spot.x,free.y-spot.y),};}
return{x:spot.x,y:spot.y,kind:'blocked',offset:0};}
export function initialSnooker(reds=15){return{scores:[0,0],ballOn:'red',reds};}
export function snookerTargets(game,onTable){const st=game.snooker;if(!st)return onTable.slice();if(st.ballOn==='red')return onTable.filter(isRed);if(st.ballOn==='color')return onTable.filter(isColor);return onTable.includes(st.ballOn)?[st.ballOn]:[];}
const FOUL_TEXT={scratch:'母球落袋',
no_contact:'母球没有碰到任何球',
wrong_ball_first:'母球先碰到的不是该打的球',
no_rail:'碰球之后没有球碰库、也没有球进袋',
wrong_ball_potted:'打进了不该进的球',};export function resolveSnooker(game,facts){const next={...game,
balls:game.balls.map((b)=>({...b})),
players:game.players.map((p)=>({...p})),
log:game.log.slice(),
snooker:{...game.snooker,
scores:game.snooker.scores.slice(),},};const st=next.snooker;const me=next.turn;const opp=1-me;const myName=next.players[me].name;const oppName=next.players[opp].name;const ballOn=st.ballOn;const fouls=[];const notes=[];const addFoul=(code)=>{if(!fouls.includes(code))fouls.push(code);};const potted=facts.pocketed.filter((p)=>p.number!==0);const pottedReds=potted.filter((p)=>isRed(p.number));const pottedColors=potted.filter((p)=>isColor(p.number));if(facts.cueScratched)addFoul('scratch');if(facts.firstContact===null){addFoul('no_contact');}else{const ok=
ballOn==='red'
?isRed(facts.firstContact)
:ballOn==='color'
?isColor(facts.firstContact)
:facts.firstContact===ballOn;if(!ok)addFoul('wrong_ball_first');}
const railOk=facts.railsAfterContact.length>0||facts.pocketed.length>0;if(facts.firstContact!==null&&!railOk)addFoul('no_rail');if(ballOn==='red'){if(pottedColors.length)addFoul('wrong_ball_potted');}else if(ballOn==='color'){if(pottedReds.length)addFoul('wrong_ball_potted');if(pottedColors.length>1)addFoul('wrong_ball_potted');}else if(potted.some((p)=>p.number!==ballOn)){addFoul('wrong_ball_potted');}
const fouled=fouls.length>0;let penalty=0;if(fouled){const candidates=[4];if(ballOn==='red')candidates.push(1);else if(typeof ballOn==='number')candidates.push(valueOf(ballOn));for(const p of potted)candidates.push(valueOf(p.number));if(facts.firstContact!==null)candidates.push(valueOf(facts.firstContact));penalty=Math.max(...candidates);}
let continuing=false;let gained=0;if(fouled){st.scores[opp]+=penalty;next.players[me].fouls+=1;notes.push(`${myName} 犯规，罚 ${penalty} 分给 ${oppName}。`);}else{next.players[me].fouls=0;gained=potted.reduce((sum,p)=>sum+valueOf(p.number),0);st.scores[me]+=gained;continuing=potted.length>0;if(gained>0)notes.push(`${myName} 得 ${gained} 分。`);}
for(const b of next.balls){const after=facts.ballsAfter.find((x)=>x.id===b.id);if(!after)continue;b.x=after.x;b.y=after.y;b.pocketed=after.pocketed;b.pocket=after.pocket;b.vx=b.vy=b.wx=b.wy=b.wz=0;}
const redsLeft=next.balls.filter((b)=>isRed(b.number)&&!b.pocketed).length;const colorPhase=typeof ballOn==='number';const respotted=[];for(const p of pottedColors){if(colorPhase&&!fouled)continue;const ball=next.balls.find((b)=>b.id===p.id);if(!ball)continue;const spot=spotFor(next.table,ball.number);if(!spot)continue;const R=next.table.ballRadius;const occupied=(x,y)=>
next.balls.some(
(o)=>o!==ball&&!o.pocketed&&Math.hypot(o.x-x,o.y-y)<2*R-1e-9
);let pos={...spot};if(occupied(pos.x,pos.y)){const free=findFreeSpot(next.table,next.balls.filter((o)=>o!==ball),R,spot);if(free)pos=free;}
ball.pocketed=false;ball.pocket=undefined;ball.x=pos.x;ball.y=pos.y;respotted.push(ball.number);notes.push(`${ballName(ball.number)}回位。`);}
const colorsLeft=COLOR_ORDER.filter((n)=>
next.balls.some((b)=>b.number===n&&!b.pocketed)
);let ballOnNext;if(continuing&&pottedReds.length>0){ballOnNext='color';}else if(redsLeft>0){ballOnNext='red';}else{ballOnNext=colorsLeft.length?colorsLeft[0]:null;}
let ended=false;let winner=null;let respotTie=false;let spotted=null;let tieBlackNote=null;const onlyBlackBefore=
facts.onTableBefore.every((n)=>n===BLACK)&&facts.onTableBefore.includes(BLACK);if(fouled&&redsLeft===0&&onlyBlackBefore){ended=true;winner=opp;notes.push('只剩黑球时犯规，这一局结束。');}else if(redsLeft===0&&colorsLeft.length===0){ended=true;if(st.scores[0]===st.scores[1]){notes.push('比分相同：黑球重摆，换对手在 D 区开球。');const black=next.balls.find((b)=>b.number===BLACK);if(black){const placed=blackRespotPosition(next.table,next.balls,black);black.pocketed=false;black.pocket=undefined;black.x=placed.x;black.y=placed.y;black.vx=black.vy=black.wx=black.wy=black.wz=0;if(placed.kind==='line'){notes.push(
`黑球点被占：黑球沿中线向顶库方向让到 ${(placed.offset * 100).toFixed(1)} cm 处。`
);}else if(placed.kind==='free'){tieBlackNote='黑球点与中线都被占，黑球摆在离黑球点最近的空位';notes.push(`黑球点与整条中线都被占住：${tieBlackNote}。`);}else if(placed.kind==='blocked'){notes.push('黑球点被占，台面上又找不到空位：黑球只能摆回黑球点。');}}
ended=false;winner=null;ballOnNext=BLACK;respotTie=true;spotted=BLACK;continuing=false;}else{winner=st.scores[0]>st.scores[1]?0:1;}}
if(!ended){if(fouled||!continuing)next.turn=opp;next.ballInHand=respotTie||(fouled&&fouls.includes('scratch'))?{zone:'d'}:null;next.phase='playing';next.winner=null;}else{next.phase='ended';next.winner=winner;next.ballInHand=null;}
if(respotTie)next.turn=opp;st.ballOn=ballOnNext;st.reds=redsLeft;next.breakShot=false;next.shots+=1;const parts=[];if(fouled)parts.push(`犯规：${fouls.map((c) => FOUL_TEXT[c]).join('；')}，罚 ${penalty} 分`);else if(gained>0)parts.push(`得 ${gained} 分`);else parts.push('没有球进袋');if(respotted.length)parts.push(`回位：${respotted.map(ballName).join('、')}`);if(tieBlackNote)parts.push(tieBlackNote);parts.push(`${st.scores[0]} : ${st.scores[1]}`);if(!ended){parts.push(ballOnNext==='red'?'该打红球':ballOnNext==='color'?'该打彩球':`该打${ballName(ballOnNext)}`);parts.push(continuing?`${myName} 继续`:`换 ${oppName}`);}
const summary=ended
?`${myName} 与 ${oppName} 的这一局结束：${next.players[winner]?.name ?? '—'} 获胜（${st.scores[0]} : ${st.scores[1]}）。`
:parts.join(' · ');const report={kind:next.shots===1?'break':'shot',
shooter:me,
fouls:fouls.map((code)=>({code,text:FOUL_TEXT[code]})),
fouled,
pocketed:potted.filter(
(p)=>!respotted.includes(p.number)&&!(spotted!==null&&p.number===spotted)
),
cueScratched:facts.cueScratched,
firstContact:facts.firstContact,
railsAfterContact:facts.railsAfterContact,
objectBallsToRail:facts.objectBallsToRail,
continuing,
ballInHand:next.ballInHand?{player:next.turn,zone:next.ballInHand.zone}:null,
requiresRerack:false,
spotted,
ended,
winner,
notes,
unsettled:facts.settled===false,
snooker:{gained,
penalty,
scores:st.scores.slice(),
ballOn:ballOnNext,
respotted:respotted.slice(),},
summary,};if(report.unsettled)report.summary+='（这一杆没在限时内停稳，结果是按超时那一刻的球位算的）';next.log.push({shot:next.shots,
shooter:me,
summary,
fouls:report.fouls.map((f)=>f.code),});return{next,report};}
