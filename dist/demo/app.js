import{createTable}from'../src/table.js';import{TABLE_PRESETS,SEARCH_DT}from'../src/constants.js';import{createBall,createWorld}from'../src/physics.js';import{solveShot,
coach,
describeCandidate,
cueRestText,
toleranceText,
difficultyLabel,
difficultyCaveat,
LABEL_SIGMA_DEG,
pocketName,
planShot,}from'../src/solver.js';import{createRenderer,createShareScene,interpolateBallStates,sampleDampedCamera}from'./render.js';import{ballStyle,groupOf,RACK_NUMBERS,createStandardRack,createRack,GAME_KINDS}from'../src/rack.js';import{createGame,
legalTargetNumbers,
numbersOnTable,
remainingOfGroup,
simulateShot,
resolveShot,
rerack,
placementAllowed,
placeCueBall,
acceptTable,
handBackBreak,}from'../src/rules.js';import{takeTurn}from'../src/opponent.js';import{ballName as snookerBallName}from'../src/snooker.js';import{appendMatch,
loadSave,
readMatches,
writeSave,
clearSave,
describeSave,
readSaveMeta,
readSaveStamp,
saveFailureKind,
serialize,
sanitize,
SAVE_KEY,}from'./save.js';import{autoPauseHint,
buildMatchSummary,
buildShareSummary,
buildTableSummary,
clamp,
computeMatchStats,
currentAim,
describeManualShot,
describeNextShot,
esc,
findSpot,
gameKindOrThrow,
getAimHUDInfo,
getPowerTier,
practiceHint,
practiceReady,
pushHistoryEntry,
reduceAutoPause,
reduceSaveWrite,
reportHtml,
restoreGameState,
restorePositions,
shouldAutoShoot,
simulateFrames,
snapshotPositions,
summarizeHistory,
tableForKind,
undoLabel,
unpackHistory,}from'./state.js';import{appendPracticeResult,
clearPracticeLog,
DEFAULT_PRACTICE_GOAL,
DRILL_SET_SIZE,
DRILL_SET_TARGET,
exportPracticeBackup,
exportPracticeCsv,
MAX_BACKUP_BYTES,
MIN_CALIBRATION_SAMPLES,
popLastPracticeResult,
PRACTICE_DRILLS,
PRACTICE_DRILL_VARIATIONS,
PRACTICE_GOALS,
PRACTICE_MISS_REASONS,
PRACTICE_FOCUS_MIN_LABELS,
practiceDrillLayout,
readPracticeLog,
readPracticeGoal,
parsePracticeBackup,
replacePracticeLog,
summarizeDrills,
summarizeMissReasons,
summarizePracticeFocus,
summarizePracticeDays,
summarizeTodayPractice,
summarizePractice,
writePracticeGoal,}from'./practice.js';const $=(id)=>document.getElementById(id);const canvas=$('table');let table=createTable('pool9');let R=table.ballRadius;const view=createRenderer({canvas,table});function readTabSession(){const made=`tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;try{const kept=sessionStorage.getItem(SESSION_KEY);if(kept)return kept;sessionStorage.setItem(SESSION_KEY,made);return made;}catch{return made;}}
const SESSION_KEY='pool-ai-coach/tab/v1';const TAB_SESSION=readTabSession();const state={mode:'practice',
balls:[],
solution:null,
practiceRecorded:false,
lastRecordAt:0,
activeDrillId:null,
drillVariation:0,
activeDrillVariation:0,
game:null,
gSolution:null,
autoOpponent:true,
opponentThinking:false,
gameKind:'eightball',
tableManual:{},
allowSafety:true,
generation:0,
animating:false,
placing:false,
saveStamp:null,
saveSession:TAB_SESSION,
saveOverwrite:false,
otherSaveShots:null,
history:[],
shotLog:[],
autoPaused:false,
autoPauseReason:null,
historyNote:null,
manual:{speed:2.2,aimOffsetDeg:0,tipB:0,tipA:0,touched:false},};const GROUP_LABEL={solid:'全色',stripe:'花色',eight:'8 号',cue:'母球'};function resize(){const stage=$('stage');const cs=getComputedStyle(stage);const padX=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);const padY=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);const availW=Math.max(1,stage.clientWidth-padX-10);const availH=Math.max(1,stage.clientHeight-padY-10);view.fit(availW,availH);render();}
function resetLayout(){state.generation+=1;state.solution=null;state.practiceRecorded=false;state.activeDrillId=null;state.animating=false;invalidateShare();updateDrillStatus();updatePracticeFeedback();state.balls=[];state.balls.push(
createBall('cue',table.length*0.24,table.width*0.5,{number:0,...ballStyle(0)})
);for(const s of[
{x:0.62,y:0.78,n:1},
{x:0.82,y:0.34,n:2},
{x:0.46,y:0.24,n:3},
]){state.balls.push(
createBall('b'+s.n,s.x*table.length,s.y*table.width,{number:s.n,
...ballStyle(s.n),})
);}
createWorld(table,state.balls);refreshBallPicker();setAdvice('点「求解最佳方案」开始。','');$('alts').innerHTML='—';$('alts').className='empty';render();}
function refreshBallPicker(){const used=new Set(state.balls.filter((b)=>!b.pocketed).map((b)=>b.number));const sel=$('ballPick');const prev=Number(sel.value);sel.innerHTML='';const free=RACK_NUMBERS.filter((n)=>!used.has(n));if(!free.length){const opt=document.createElement('option');opt.textContent='15 颗都在台上了';opt.value='';sel.appendChild(opt);sel.disabled=true;$('addBall').disabled=true;}else{for(const n of free){const opt=document.createElement('option');opt.value=String(n);opt.textContent=`${n} 号（${GROUP_LABEL[groupOf(n)]}）`;sel.appendChild(opt);}
sel.disabled=false;$('addBall').disabled=false;if(free.includes(prev))sel.value=String(prev);}
refreshRemovePicker();}
function refreshRemovePicker(){const sel=$('ballRemove');if(!sel)return;const prev=sel.value;const onTable=state.balls.filter((b)=>!b.pocketed);sel.innerHTML='';const removable=onTable.filter((b)=>b.number!==0);if(!removable.length){const opt=document.createElement('option');opt.textContent='台上没有可拿掉的目标球';opt.value='';sel.appendChild(opt);sel.disabled=true;$('removeBall').disabled=true;return;}
for(const b of removable.sort((a,c)=>a.number-c.number)){const opt=document.createElement('option');opt.value=String(b.number);opt.textContent=`${b.number} 号（${GROUP_LABEL[groupOf(b.number)]}）`;sel.appendChild(opt);}
sel.disabled=false;$('removeBall').disabled=false;if([...sel.options].some((o)=>o.value===prev))sel.value=prev;}
function removeBall(){if(state.animating)return;const n=Number($('ballRemove').value);if(!n)return;const before=state.balls.length;state.balls=state.balls.filter((b)=>b.number!==n);if(state.balls.length===before)return;createWorld(table,state.balls);clearSolution(`已拿掉 ${n} 号球，重新求解。`);refreshBallPicker();render();}
function addBall(){if(state.animating)return;const n=Number($('ballPick').value);if(!n)return;if(state.balls.some((b)=>b.number===n&&!b.pocketed))return;const spot=findSpot(state.balls,table);if(!spot){setAdvice('台面上已经放不下更多球了。','');return;}
const ball=createBall('b'+n,spot.x,spot.y,{number:n,...ballStyle(n)});state.balls.push(ball);createWorld(table,state.balls);clearSolution('已加球，重新求解。');refreshBallPicker();render();}
function rackUp(){if(state.animating)return;state.balls=createStandardRack(table,{seed:Math.floor(Math.random()*1e6)}).map((b)=>
createBall(b.id,b.x,b.y,b)
);createWorld(table,state.balls);clearSolution('已摆满 15 颗，可以开球了。');refreshBallPicker();render();}
function clearSolution(text){state.solution=null;state.practiceRecorded=false;updatePracticeFeedback();if(text)setAdvice(text,'');$('alts').innerHTML='—';$('alts').className='empty';}
function setTablePreset(presetId){const next=createTable(presetId);table=next;R=next.ballRadius;view.setTable(next);state.generation+=1;state.game=null;state.history=[];resetLayout();resize();if(state.mode==='game')newGame();$('tablePreset').value=next.preset;$('subtitle').textContent=
`${next.label}（${next.length} × ${next.width} 米）· 换台后已重摆`;}
function setAdvice(text,verdict,cls=''){$('advice').textContent=text;$('advice').className=/^(点|没有|已|台面)/.test(text)?'empty':'';$('verdict').textContent=verdict;$('verdict').className=cls;}
const cameraAnim={active:false,
startTime:0,
fromT:0,
fromVelocity:0,
toT:0,
velocity:0,};function toggleView(){const currentT=view.getCamera().t;const targetT=cameraAnim.active?(cameraAnim.toT<0.5?1:0):(currentT<0.5?1:0);startCameraTransition(targetT);}
function startCameraTransition(targetT){const now=performance.now();const wasActive=cameraAnim.active;const current=wasActive
?sampleDampedCamera(
cameraAnim.fromT,
cameraAnim.toT,
cameraAnim.fromVelocity,
(now-cameraAnim.startTime)/1000
)
:{value:view.getCamera().t,velocity:0};const boundedT=Math.max(0,Math.min(1,current.value));cameraAnim.active=true;cameraAnim.startTime=now;cameraAnim.fromT=boundedT;cameraAnim.fromVelocity=boundedT===current.value?current.velocity:0;cameraAnim.velocity=cameraAnim.fromVelocity;cameraAnim.toT=targetT;updateViewToggleButton(targetT);if(!wasActive)requestAnimationFrame(animateCamera);}
function animateCamera(){if(!cameraAnim.active)return;const now=performance.now();const sample=sampleDampedCamera(
cameraAnim.fromT,
cameraAnim.toT,
cameraAnim.fromVelocity,
(now-cameraAnim.startTime)/1000
);const currentT=Math.max(0,Math.min(1,sample.value));cameraAnim.velocity=currentT===sample.value?sample.velocity:0;syncCamera(currentT);render();if(Math.abs(cameraAnim.toT-currentT)>0.001||Math.abs(cameraAnim.velocity)>0.008){requestAnimationFrame(animateCamera);}else{cameraAnim.active=false;syncCamera(cameraAnim.toT);render();}}
function updateViewToggleButton(targetT){const btn=$('viewToggle');const txt=$('viewToggleText');if(!btn)return;const isFPV=targetT>0.5;btn.classList.toggle('fpv',isFPV);if(txt){txt.textContent=isFPV?'视角: 第一人称趴杆':'视角: 俯视';}
const icon=btn.querySelector('.vt-icon');if(icon)icon.textContent=isFPV?'🎯':'🎥';}
function syncCamera(t){const inGame=state.mode==='game';const balls=inGame?(state.game?.balls??[]):state.balls;const cue=balls.find((b)=>b.number===0&&!b.pocketed);const aim=currentAim(state);const aimAngle=aim?(aim.angle+(state.manual.aimOffsetDeg*Math.PI)/180):0;view.setCamera({t,
aimAngle,
cueBall:cue?{x:cue.x,y:cue.y}:{x:table.length*0.25,y:table.width*0.5},});}
const HUD_SIG_CAP=512;const hudSigCur=new Float64Array(HUD_SIG_CAP);const hudSigPrev=new Float64Array(HUD_SIG_CAP);const hudRefsCur=new Array(8);const hudRefsPrev=new Array(8);let hudSigLen=-1;let hudRefsLen=-1;let hudCache=null;function hudInputsChanged(){const nums=hudSigCur;const refs=hudRefsCur;let n=0;let r=0;const inGame=state.mode==='game';const sol=inGame?state.gSolution:state.solution;const best=sol&&sol.found?sol.best:null;nums[n++]=inGame?1:0;nums[n++]=state.manual.speed;refs[r++]=sol||null;refs[r++]=best||null;if(best){nums[n++]=best.targetNumber;nums[n++]=best.toleranceDeg;nums[n++]=best.ghost?best.ghost.x:0;nums[n++]=best.ghost?best.ghost.y:0;refs[r++]=best.pocketId??null;}else if(inGame){return true;}else{const balls=state.balls;if(balls.length*4+2>HUD_SIG_CAP)return true;nums[n++]=balls.length;for(const b of balls){nums[n++]=b.number;nums[n++]=b.x;nums[n++]=b.y;nums[n++]=b.pocketed?1:0;}}
let changed=n!==hudSigLen||r!==hudRefsLen;if(!changed){for(let i=0;i<n;i+=1){if(nums[i]!==hudSigPrev[i]){changed=true;break;}}}
if(!changed){for(let i=0;i<r;i+=1){if(refs[i]!==hudRefsPrev[i]){changed=true;break;}}}
if(changed){hudSigPrev.set(nums.subarray(0,n));for(let i=0;i<r;i+=1)hudRefsPrev[i]=refs[i];hudSigLen=n;hudRefsLen=r;}
return changed;}
function aimHUDInfo(){if(hudInputsChanged()||!hudCache)hudCache=getAimHUDInfo(state);return hudCache;}
function render(){const camT=view.getCamera().t;view.clear();syncCamera(camT);view.drawTable();if(state.mode==='practice'){drawSolution(camT);drawBalls(state.balls,camT);}else{drawGameOverlay(camT);drawBalls(state.game?.balls??[],camT);}
if(camT>0.01){view.drawCueStick(state.manual.strokeOffset||0);view.draw1stPersonHUD(aimHUDInfo());}}
const visibleBalls=[];const BALL_DEPTH=Symbol('ballDepth');function drawBalls(balls,camT){const visible=visibleBalls;visible.length=0;for(const b of balls){if(!b.pocketed)visible.push(b);}
if(camT>0.01){for(const b of visible){b[BALL_DEPTH]=view.project(b.x,b.y,table.ballRadius).depth;}
visible.sort((a,b)=>b[BALL_DEPTH]-a[BALL_DEPTH]);}
for(const b of visible){view.drawBall(b);}}
function drawPositionGuide(candidate){if(!candidate.positioningRequired||!candidate.cueRest||!candidate.cueRoute?.length)return;const ctx=view.ctx;const path=candidate.cueRoute.map((point)=>view.project(point.x,point.y,table.ballRadius));ctx.save();ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);for(let i=1;i<path.length;i++)ctx.lineTo(path[i].x,path[i].y);ctx.setLineDash([5,5]);ctx.strokeStyle='rgba(56, 189, 248, 0.95)';ctx.lineWidth=Math.max(2,2.4*(path[path.length-1].scale/view.scale));ctx.stroke();ctx.setLineDash([]);const rest=view.project(candidate.cueRest.x,candidate.cueRest.y,table.ballRadius);const radius=Math.max(8,table.ballRadius*rest.scale);ctx.beginPath();ctx.arc(rest.x,rest.y,radius,0,Math.PI*2);ctx.fillStyle='rgba(56, 189, 248, 0.2)';ctx.fill();ctx.strokeStyle='#38bdf8';ctx.lineWidth=2;ctx.stroke();if(candidate.nextShot){const ghost=view.project(candidate.nextShot.ghost.x,candidate.nextShot.ghost.y,table.ballRadius);const target=view.project(candidate.nextShot.target.x,candidate.nextShot.target.y,table.ballRadius);const pocket=view.project(candidate.nextShot.pocket.x,candidate.nextShot.pocket.y,0);ctx.beginPath();ctx.moveTo(rest.x,rest.y);ctx.lineTo(ghost.x,ghost.y);ctx.lineTo(target.x,target.y);ctx.lineTo(pocket.x,pocket.y);ctx.setLineDash([3,5]);ctx.strokeStyle='rgba(192, 132, 252, 0.8)';ctx.lineWidth=Math.max(1.5,1.8*(rest.scale/view.scale));ctx.stroke();ctx.setLineDash([]);}
ctx.restore();}
function drawAimGuides(best,cue,target,pocket,camT){const ctx=view.ctx;const cuePx=view.project(cue.x,cue.y,table.ballRadius);const tgtPx=view.project(target.x,target.y,table.ballRadius);const ghostPx=view.project(best.ghost.x,best.ghost.y,table.ballRadius);if(pocket){const pocketPx=view.project(pocket.x,pocket.y,0);ctx.setLineDash([7,6]);ctx.strokeStyle='rgba(250, 204, 21, 0.90)';ctx.lineWidth=Math.max(1.8,2.4*(tgtPx.scale/view.scale));ctx.beginPath();ctx.moveTo(tgtPx.x,tgtPx.y);ctx.lineTo(pocketPx.x,pocketPx.y);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(pocketPx.x,pocketPx.y,Math.max(8,pocket.captureR*pocketPx.scale*1.15),0,Math.PI*2);ctx.strokeStyle='rgba(250, 204, 21, 0.65)';ctx.lineWidth=2;ctx.stroke();const gr=Math.max(4,R*ghostPx.scale);ctx.beginPath();ctx.arc(ghostPx.x,ghostPx.y,gr,0,Math.PI*2);ctx.strokeStyle='rgba(250, 204, 21, 0.95)';ctx.lineWidth=1.8;ctx.stroke();ctx.fillStyle='rgba(250, 204, 21, 0.16)';ctx.fill();const dtx=pocket.x-best.ghost.x;const dty=pocket.y-best.ghost.y;const dtLen=Math.hypot(dtx,dty)||1;const utx=dtx/dtLen;const uty=dty/dtLen;const dcx=best.ghost.x-cue.x;const dcy=best.ghost.y-cue.y;const dcLen=Math.hypot(dcx,dcy)||1;const ucx=dcx/dcLen;const ucy=dcy/dcLen;let sepX=-uty;let sepY=utx;if(sepX*ucx+sepY*ucy<0){sepX=uty;sepY=-utx;}
const sepDist=0.38;const sepPt=view.project(best.ghost.x+sepX*sepDist,best.ghost.y+sepY*sepDist,table.ballRadius);ctx.setLineDash([4,4]);ctx.strokeStyle='rgba(16, 185, 129, 0.70)';ctx.lineWidth=Math.max(1.5,1.8*(ghostPx.scale/view.scale));ctx.beginPath();ctx.moveTo(ghostPx.x,ghostPx.y);ctx.lineTo(sepPt.x,sepPt.y);ctx.stroke();ctx.setLineDash([]);}else{const gr=Math.max(4,R*ghostPx.scale);ctx.beginPath();ctx.arc(ghostPx.x,ghostPx.y,gr,0,Math.PI*2);ctx.strokeStyle='rgba(250, 204, 21, 0.95)';ctx.lineWidth=1.8;ctx.stroke();ctx.fillStyle='rgba(250, 204, 21, 0.16)';ctx.fill();}
ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(cuePx.x,cuePx.y);ctx.lineTo(ghostPx.x,ghostPx.y);ctx.strokeStyle=camT>0.5?'rgba(52, 211, 153, 0.95)':'rgba(16, 185, 129, 0.92)';ctx.lineWidth=Math.max(2,2.6*(cuePx.scale/view.scale));ctx.stroke();}
function drawSolution(camT){const sol=state.solution;if(!sol||!sol.found||state.animating)return;const best=sol.best;const cue=state.balls.find((b)=>b.id==='cue');const target=state.balls.find((b)=>b.id===best.targetId);const pocket=table.pockets.find((p)=>p.id===best.pocketId);if(!cue||!target||!pocket)return;const ctx=view.ctx;const cuePx=view.project(cue.x,cue.y,table.ballRadius);const ghostPx=view.project(best.ghost.x,best.ghost.y,table.ballRadius);if($('showGhost').checked){drawAimGuides(best,cue,target,pocket,camT);}
if($('showCone').checked&&camT<0.6){const dist=Math.hypot(cue.x-best.ghost.x,cue.y-best.ghost.y);const VISUAL_GAIN=20;const halfRad=((best.toleranceDeg*Math.PI)/180)*VISUAL_GAIN;const dirAngle=Math.atan2(ghostPx.y-cuePx.y,ghostPx.x-cuePx.x);const reach=dist*cuePx.scale*1.02;ctx.save();ctx.globalAlpha=1-camT;ctx.beginPath();ctx.moveTo(cuePx.x,cuePx.y);ctx.arc(cuePx.x,cuePx.y,reach,dirAngle-halfRad,dirAngle+halfRad);ctx.closePath();ctx.fillStyle='rgba(74, 222, 128, 0.16)';ctx.fill();ctx.strokeStyle='rgba(74, 222, 128, 0.5)';ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(cuePx.x,cuePx.y);ctx.lineTo(cuePx.x+Math.cos(dirAngle)*reach,cuePx.y+Math.sin(dirAngle)*reach);ctx.strokeStyle='rgba(74, 222, 128, 0.95)';ctx.stroke();ctx.setLineDash([]);ctx.restore();}
if(best.cuePath&&best.cuePath.kind==='pocket'){const p=view.project(best.cuePath.point.x,best.cuePath.point.y,0);ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.strokeStyle='rgba(248, 113, 113, 0.95)';ctx.lineWidth=2;ctx.stroke();}
drawPositionGuide(best);}
function drawGameOverlay(camT){const g=state.game;if(!g)return;const ctx=view.ctx;if(g.ballInHand&&!state.animating){const zone=g.ballInHand.zone;const x0=0;const x1=zone==='kitchen'?table.length/4:table.length;const p0=view.project(x0,0,0);const p1=view.project(x1,0,0);const p2=view.project(x1,table.width,0);const p3=view.project(x0,table.width,0);ctx.beginPath();ctx.moveTo(p0.x,p0.y);ctx.lineTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.lineTo(p3.x,p3.y);ctx.closePath();ctx.fillStyle='rgba(74, 222, 128, 0.10)';ctx.fill();ctx.strokeStyle='rgba(74, 222, 128, 0.45)';ctx.setLineDash([5,4]);ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);}
const sol=state.gSolution;if(!sol||!sol.found||state.animating)return;const best=sol.best;const cue=g.balls.find((b)=>b.number===0);const target=g.balls.find((b)=>b.id===best.targetId);if(!cue||!target)return;const pocket=best.pocketId?table.pockets.find((p)=>p.id===best.pocketId):null;drawAimGuides(best,cue,target,pocket,camT);drawPositionGuide(best);}
let drag=null;let canvasRectCache=null;let canvasRectWatched=false;function invalidateCanvasRect(){canvasRectCache=null;}
function canvasRect(){if(!canvasRectCache)canvasRectCache=canvas.getBoundingClientRect();return canvasRectCache;}
function watchCanvasRect(){if(canvasRectWatched)return;canvasRectWatched=true;window.addEventListener('resize',invalidateCanvasRect);window.addEventListener('orientationchange',invalidateCanvasRect);window.addEventListener('scroll',invalidateCanvasRect,true);if(window.visualViewport){window.visualViewport.addEventListener('resize',invalidateCanvasRect);window.visualViewport.addEventListener('scroll',invalidateCanvasRect);}
if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(invalidateCanvasRect);observer.observe(canvas);observer.observe(document.documentElement);}}
watchCanvasRect();function pointerPos(ev){const rect=canvasRect();return{x:ev.clientX-rect.left,y:ev.clientY-rect.top};}
canvas.addEventListener('pointerdown',(ev)=>{if(state.animating)return;invalidateCanvasRect();const p=pointerPos(ev);const w=view.toWorld(p.x,p.y);if(state.mode==='game'&&state.game?.ballInHand){if(state.autoOpponent&&!state.autoPaused&&state.game.turn===1){setReport('现在是对手持球，它会自己摆母球。');return;}
if(!placementAllowed(state.game,w.x,w.y)){setReport('这个位置不能放母球：'+(state.game.ballInHand.zone==='kitchen'?'开球线后才是合法区。':'要放在台面内。'));return;}
if(!placeCueBall(state.game,w.x,w.y))return;state.game.ballInHand=null;state.gSolution=null;setReport('母球已摆好，可以求解了。');updateScore();render();return;}
const balls=state.mode==='practice'?state.balls:state.game?.balls??[];let hit=null;let bestD=Infinity;for(const b of balls){if(b.pocketed)continue;if(state.mode==='game'&&b.number!==0)continue;const d=Math.hypot(b.x-w.x,b.y-w.y);if(d<R*2.5&&d<bestD){bestD=d;hit=b;}}
if(!hit)return;drag={ball:hit,dx:hit.x-w.x,dy:hit.y-w.y};canvas.setPointerCapture(ev.pointerId);canvas.classList.add('dragging');});let pendingDragRender=false;canvas.addEventListener('pointermove',(ev)=>{if(!drag||state.animating)return;const p=pointerPos(ev);const w=view.toWorld(p.x,p.y);const b=drag.ball;const balls=state.mode==='practice'?state.balls:state.game.balls;let nx=clamp(w.x+drag.dx,table.bounds.minX,table.bounds.maxX);let ny=clamp(w.y+drag.dy,table.bounds.minY,table.bounds.maxY);for(const other of balls){if(other===b||other.pocketed)continue;const d=Math.hypot(other.x-nx,other.y-ny);if(d<2*R+1e-4){const push=2*R+1e-4-d;const ux=(nx-other.x)/(d||1);const uy=(ny-other.y)/(d||1);nx+=ux*push;ny+=uy*push;}}
b.x=clamp(nx,table.bounds.minX,table.bounds.maxX);b.y=clamp(ny,table.bounds.minY,table.bounds.maxY);if(state.mode==='practice')clearSolution('摆位已改动，重新求解。');else state.gSolution=null;if(!pendingDragRender){pendingDragRender=true;requestAnimationFrame(()=>{pendingDragRender=false;render();});}});function endDrag(ev){if(!drag)return;drag=null;canvas.classList.remove('dragging');try{canvas.releasePointerCapture(ev.pointerId);}catch{}}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);function updatePracticeFeedback(message=null){const ready=practiceReady(state);$('practiceMade').disabled=!ready||state.animating;$('practiceMissed').disabled=!ready||state.animating;$('practiceMessage').textContent=message??practiceHint(state);}
function updatePracticeLog(){const records=readPracticeLog();const summary=summarizePractice(records);const weekly=summarizePracticeDays(records);const today=summarizeTodayPractice(records,readPracticeGoal());const drillSummary=summarizeDrills(records);const missSummary=summarizeMissReasons(records);const practiceFocus=summarizePracticeFocus(records);$('clearPractice').disabled=records.length===0;$('practiceUndo').disabled=records.length===0;$('exportPractice').disabled=records.length===0;$('practiceHistorySummary').textContent=records.length
?`查看最近 5 条（共 ${records.length} 条）`
:'暂无记录明细';$('practiceSummary').textContent=summary.attempts
?`${summary.made}/${summary.attempts} 杆命中 · 总命中率 ${Math.round(summary.rate * 100)}% · 最近 ${summary.recent.attempts} 杆 ${summary.recent.attempts ? `${Math.round(summary.recent.rate * 100)}%` : '—'}`
:'还没有实战记录。';$('practiceGoal').value=String(today.goal||DEFAULT_PRACTICE_GOAL);$('practiceStatsSummary').textContent=today.attempts
?`练习统计与今日目标（今天 ${today.attempts}/${today.goal} 杆${today.complete ? '，已达成' : ''}）`
:'练习统计与今日目标';$('practiceGoalSummary').textContent=today.complete
?`今日目标达成！已完成 ${today.attempts}/${today.goal} 杆。`
:`今日已练 ${today.attempts}/${today.goal} 杆 · 还差 ${today.remaining} 杆`;$('practiceGoalBar').setAttribute('aria-valuenow',String(Math.min(today.attempts,today.goal)));$('practiceGoalBar').setAttribute('aria-valuemax',String(today.goal));$('practiceGoalFill').style.width=`${Math.round(today.progress * 100)}%`;$('practiceWeekSummary').textContent=weekly.attempts
?`近 7 天 ${weekly.attempts} 杆 · 命中率 ${Math.round(weekly.rate * 100)}% · 练习 ${weekly.activeDays} 天 · 连续 ${weekly.streak} 天`
:`近 7 天还没有实战记录。${weekly.streak ? ` 已连续练习 ${weekly.streak} 天。` : '记录一杆真实练习，开启连续训练。'}`;updatePracticeTrend(weekly.days);updateDrillStatus(drillSummary);updateMissReasonSummary(missSummary);updatePracticeFocus(practiceFocus);const labels=[
['narrow','窄 <0.20°'],
['medium','中 0.20–0.49°'],
['wide','宽 ≥0.50°'],
];const buckets=$('practiceBuckets');buckets.textContent='';let calibratedBuckets=0;for(const[key,label]of labels){const stats=summary.tolerance[key];const item=document.createElement('div');item.append(document.createTextNode(label));const value=document.createElement('b');if(stats.confidence95){calibratedBuckets++;value.textContent=
`${Math.round(stats.rate * 100)}% · ${stats.made}/${stats.attempts}`+
` · 95% ${Math.round(stats.confidence95.low * 100)}–${Math.round(stats.confidence95.high * 100)}%`;}else{value.textContent=`${stats.made}/${stats.attempts} · ${MIN_CALIBRATION_SAMPLES - stats.attempts > 0 ? `再记 ${MIN_CALIBRATION_SAMPLES - stats.attempts} 杆` : '样本少'}`;}
item.appendChild(value);buckets.appendChild(item);}
$('practiceCalibration').textContent=calibratedBuckets
?`个人实战校准：${calibratedBuckets} 个容错区间达到 ${MIN_CALIBRATION_SAMPLES} 杆。区间为 95% 统计范围；仅作训练参考，不会自动修改 AI 推荐。`
:`个人校准样本还不够：某个容错区间至少记录 ${MIN_CALIBRATION_SAMPLES} 杆后，才显示该区间命中率及 95% 统计范围。`;const history=$('practiceHistory');history.textContent='';const recent=records.slice(-5).reverse();if(!recent.length){history.textContent='—';history.className='log empty';return;}
history.className='log';for(const record of recent){const item=document.createElement('div');const time=new Date(record.timestamp).toLocaleString();const reason=PRACTICE_MISS_REASONS.find((item)=>item.id===record.missReason)?.label;item.textContent=
`${time} · ${record.made ? '命中' : `未进${reason ? `（${reason}）` : ''}`} · ${record.targetNumber} 号 → ${pocketName(record.pocketId)} · 容错 ±${record.toleranceDeg.toFixed(2)}°`;history.appendChild(item);}}
function updateMissReasonSummary(summary){const details=PRACTICE_MISS_REASONS
.filter(({id})=>summary.counts[id]>0)
.map(({id,label})=>`${label} ${summary.counts[id]} 次`);if(summary.unclassified)details.push(`未分类 ${summary.unclassified} 次`);$('missReasonSummary').textContent=summary.misses
?`未进 ${summary.misses} 杆 · 已标注 ${summary.labeled} 杆：${details.join(' · ')}`
:'还没有未进记录。';}
function updatePracticeFocus(summary){const message=$('practiceFocus');const action=$('practiceFocusAction');action.hidden=true;if(summary.labeled<PRACTICE_FOCUS_MIN_LABELS){const remaining=PRACTICE_FOCUS_MIN_LABELS-summary.labeled;message.textContent=
`训练建议：近 ${summary.window} 次未进中已标注 ${summary.labeled} 次原因；再标注 ${remaining} 次后，可根据近期记录推荐练习重点。`;return;}
if(!summary.reason){message.textContent=`训练建议：近 ${summary.window} 次未进原因较分散，暂时没有明显的单一薄弱项；保持多类型练习，并继续记录原因。`;return;}
const reason=PRACTICE_MISS_REASONS.find(({id})=>id===summary.reason);const count=summary.counts[summary.reason];const guidance={aim:'建议先练直线球，稳定瞄准节奏。',
speed:'建议先练直线球，使用轻力并保持每次力度一致。',
contact:'建议练切球，观察目标球路线并校准击球厚薄。',
spin:'建议先练直线球，从中杆开始，再单独比较杆法。',
position:'多对照母球实际停位与建议路线；当前还没有专门的走位摆球训练。',
other:'继续记录更具体的未进原因，便于找到可练的方向。',}[summary.reason];message.textContent=
`训练建议：近 ${summary.window} 次未进中，“${reason.label}”出现 ${count} 次（已标注 ${summary.labeled} 次）。${guidance}`;if(summary.drillId){const drill=PRACTICE_DRILLS.find(({id})=>id===summary.drillId);action.textContent=`开始推荐训练：${drill.name}`;action.hidden=false;}}
function updatePracticeTrend(days){const chart=$('practiceTrend');chart.textContent='';for(const day of days){const item=document.createElement('div');item.className='practice-day';item.setAttribute(
'aria-label',
`${day.label}：${day.attempts ? `${day.made}/${day.attempts} 杆命中，命中率 ${Math.round(day.rate * 100)}%` : '没有记录'}`
);const rate=document.createElement('b');rate.className='practice-day-rate';rate.textContent=day.rate==null?'—':`${Math.round(day.rate * 100)}%`;const track=document.createElement('div');track.className='practice-day-track';const bar=document.createElement('div');bar.className=`practice-day-bar${day.rate == null ? ' no-data' : ''}`;bar.style.height=day.rate==null?'0%':`${Math.max(4, day.rate * 100)}%`;track.appendChild(bar);const count=document.createElement('span');count.className='practice-day-count';count.textContent=day.attempts?`${day.made}/${day.attempts}`:'—';const label=document.createElement('span');label.className='practice-day-label';label.textContent=day.label;item.append(rate,track,count,label);chart.appendChild(item);}}
function updateDrillStatus(summary=summarizeDrills(readPracticeLog())){const selected=PRACTICE_DRILLS.find((drill)=>drill.id===$('drillSelect').value);if(!selected)return;const stats=summary[selected.id];$('drillDescription').textContent=`${selected.description} 重点：${selected.focus}。`;$('drillProgress').textContent=
`${state.activeDrillId ? `当前计分：${PRACTICE_DRILLS.find((drill) => drill.id === state.activeDrillId).name} · 轮换球位 ${state.activeDrillVariation + 1}/${PRACTICE_DRILL_VARIATIONS} · ` : '尚未开始训练 · '}`+
`${stats.passedSets} 组达标 · 累计 ${stats.made}/${stats.attempts} 杆命中`+
` · 当前组 ${stats.currentSetAttempts}/${DRILL_SET_SIZE}（命中 ${stats.currentSetMade}）`+
` · 目标 ${DRILL_SET_TARGET}/${DRILL_SET_SIZE}`;}
function startPracticeDrill(){const drill=PRACTICE_DRILLS.find((item)=>item.id===$('drillSelect').value);if(!drill)return;const layout=practiceDrillLayout(table,drill.id,state.drillVariation++);const{cue,target}=layout;state.generation+=1;state.solution=null;state.practiceRecorded=false;state.activeDrillId=drill.id;state.activeDrillVariation=layout.variation;state.animating=false;updateDrillStatus();state.balls=[
createBall('cue',cue.x,cue.y,{number:0,...ballStyle(0)}),
createBall('b1',target.x,target.y,{number:1,...ballStyle(1)}),
];createWorld(table,state.balls);refreshBallPicker();updatePracticeFeedback(`已摆好「${drill.name}」专项训练。完成一杆后记录实战结果。`);setAdvice('练习球位已就绪。点击「求解最佳方案」查看建议，完成真实击球后记录结果。','');$('alts').textContent='—';$('alts').className='empty';render();}
function recordPracticeOutcome(made){if(state.mode!=='practice'||state.animating)return false;const now=Date.now();if(now-state.lastRecordAt<600)return false;const best=state.solution?.found?state.solution.best:null;if(!best?.pocketId){updatePracticeFeedback('请先求解一个有目标袋的方案。');return false;}
const saved=appendPracticeResult({timestamp:Date.now(),
made,
toleranceDeg:best.toleranceDeg,
difficulty:best.difficulty,
speed:best.speed,
targetNumber:best.targetNumber,
pocketId:best.pocketId,
tableId:table.preset,
drillId:state.activeDrillId,
missReason:made?null:$('missReason').value||null,});if(!saved){updatePracticeFeedback('本次记录未能保存；请检查浏览器是否允许本地存储。');return false;}
state.practiceRecorded=true;state.lastRecordAt=now;$('missReason').value='';updatePracticeLog();updatePracticeFeedback(`已记录实战结果：${made ? '命中' : '未进'}。同一个球位可以接着记。`);return true;}
function runSolve(){state.practiceRecorded=false;invalidateShare();const t0=performance.now();const all=solveShot(table,state.balls);const ms=performance.now()-t0;const card=coach(table,state.balls,{candidates:all});state.solution=card;updatePracticeFeedback();if(!card.found){setAdvice(card.message,'');$('alts').innerHTML='—';$('alts').className='empty';render();return;}
const cls=card.best.difficulty>80?'brutal':card.best.difficulty>55?'hard':'';setAdvice(card.message,`${card.verdict} · 求解 ${ms.toFixed(0)} ms`,cls);renderAlts(card,ms);render();}
function renderAlts(card,ms){$('alts').className='';$('alts').innerHTML='';const list=[card.best,...card.alternatives];for(const[i,c]of list.entries()){const row=document.createElement('div');row.className='alt'+(i===0?' active':'');const title=document.createElement('div');const name=document.createElement('span');name.className='name';name.textContent=`${i === 0 ? '★ ' : ''}${c.targetNumber} 号 → ${pocketName(c.pocketId)}`;title.appendChild(name);if(c.positioningRequired&&c.cueRest){const position=document.createElement('span');position.className='position';position.textContent=c.nextShot
?`${cueRestText(table, c.cueRest)} · 下一杆 ${c.nextShot.targetNumber} 号`
:cueRestText(table,c.cueRest);title.appendChild(position);}
const meta=document.createElement('span');meta.className='meta';meta.textContent=`±${c.toleranceDeg.toFixed(2)}° · ${difficultyLabel(c.value ?? c.difficulty)}`;const go=document.createElement('span');go.className='go';go.setAttribute('aria-hidden','true');go.textContent='›';row.append(title,meta,go);row.setAttribute('role','button');row.tabIndex=0;row.title='点一下换成这个方案';row.addEventListener('click',()=>{if(state.animating)return;const v=c.value??c.difficulty;state.solution={...card,
best:c,
message:describeCandidate(c),
verdict:`${difficultyLabel(v)}（综合 ${v}/100 · 单杆难度 ${c.difficulty}/100 · ${difficultyCaveat()}）`,};state.practiceRecorded=false;updatePracticeFeedback();for(const el of $('alts').querySelectorAll('.alt'))el.classList.toggle('active',el===row);const dd=c.difficulty;setAdvice(
state.solution.message,
state.solution.verdict+(ms?` · 求解 ${ms.toFixed(0)} ms`:''),
dd>80?'brutal':dd>55?'hard':''
);render();});row.addEventListener('keydown',(e)=>{if(e.key!=='Enter'&&e.key!==' ')return;e.preventDefault();row.click();});$('alts').appendChild(row);}}
function replay(frames,dt,onDone){const gen=state.generation;const targets=state.mode==='practice'?state.balls:state.game.balls;state.animating=true;updatePracticeFeedback();updateUndoButton();const restoreStroke=()=>{state.manual.strokeOffset=getPowerTier(state.manual.speed).ratio*0.12;};const startRolling=()=>{const t0=performance.now();const tick=()=>{if(gen!==state.generation){restoreStroke();updateUndoButton();return;}
const elapsed=(performance.now()-t0)/1000;const frameTime=Math.min(frames.length-1,elapsed/dt);const idx=Math.floor(frameTime);const f=interpolateBallStates(frames[idx],frames[Math.min(idx+1,frames.length-1)],frameTime-idx);const balls=targets;for(let i=0;i<balls.length&&i<f.length;i++){balls[i].x=f[i].x;balls[i].y=f[i].y;balls[i].pocketed=f[i].pocketed;balls[i].pocket=f[i].pocket;balls[i].rollAngle=f[i].rollAngle;balls[i].rollDirX=f[i].rollDirX;balls[i].rollDirY=f[i].rollDirY;}
render();if(frameTime>=frames.length-1){state.animating=false;updatePracticeFeedback();updateUndoButton();const tier=getPowerTier(state.manual.speed);state.manual.strokeOffset=tier.ratio*0.12;onDone();return;}
requestAnimationFrame(tick);};requestAnimationFrame(tick);};if(view.getCamera().t>0.05){const strikeStart=performance.now();const strikeDuration=60;const fromOffset=state.manual.strokeOffset||0.04;const strikeTick=()=>{if(gen!==state.generation){restoreStroke();return;}
const elapsed=performance.now()-strikeStart;const p=Math.min(1,elapsed/strikeDuration);state.manual.strokeOffset=fromOffset*(1-p)+(-0.012)*p;render();if(p<1){requestAnimationFrame(strikeTick);}else{startRolling();}};requestAnimationFrame(strikeTick);}else{startRolling();}}
function shootPractice(){const sol=state.solution;if(!sol||!sol.found){setAdvice('先求解，再演示。','');return;}
const best=sol.best;const sim=simulateFrames(
state.balls,
table,
{angle:best.aimAngle,speed:best.speed,tip:{a:best.tip.a,b:best.tip.b}},
SEARCH_DT
);if(!sim)return;const{frames,dt}=sim;const original=snapshotPositions(state.balls);const gen=state.generation;replay(frames,dt,()=>{if(gen!==state.generation||state.balls.length!==original.length)return;const target=state.balls.find((b)=>b.id===best.targetId);const ok=Boolean(target&&target.pocketed&&target.pocket===best.pocketId);setAdvice((ok?'✓ 进球。':'✗ 这一杆没进（袋口或力度需要微调）。')+' '+sol.message,sol.verdict);restorePositions(state.balls,original);render();});}
function newGame(){const kind=state.gameKind;const balls=createRack(kind,table,{seed:Math.floor(Math.random()*1e6)}).map((b)=>
createBall(b.id,b.x,b.y,b)
);state.generation+=1;state.game=createGame(table,balls,{names:['你','对手'],kind});state.gSolution=null;state.animating=false;state.opponentThinking=false;state.history=[];state.shotLog=[];Object.assign(state,reduceAutoPause(state,'new-game'));state.historyNote=null;updateUndoButton();setReport(
kind==='nineball'
?'九球开球。只能先碰台面上号码最小的那颗；合法进 9 号直接赢局。点「求解」看第一杆怎么打。'
:'开球。点「求解」看第一杆怎么打。'
);$('gAdvice').textContent='—';$('gAdvice').className='empty';$('gVerdict').textContent='';$('gRerack').classList.add('hidden');$('gChoice').classList.add('hidden');updateScore();updateLog();updateAutoPauseBar();render();}
function setReport(html){$('report').innerHTML=html;$('report').className='';}
function updateScore(){const g=state.game;if(!g)return;const box=$('score');box.innerHTML='';if(g.snooker){for(let i=0;i<2;i++){const p=g.players[i];const div=document.createElement('div');div.className='who'+(g.turn===i&&g.phase==='playing'?' turn':'');div.innerHTML=`<span class="nm">${esc(p.name)}</span>
        <span class="tag2">${g.snooker.scores[i]} 分</span>`;box.appendChild(div);}
const on=document.createElement('div');on.className='who';const onText=
g.phase==='ended'
?`本局结束 · ${esc(g.players[g.winner]?.name ?? '—')} 获胜`
:g.snooker.ballOn==='red'
?'该打：红球'
:g.snooker.ballOn==='color'
?'该打：任意彩球'
:`该打：${snookerBallName(g.snooker.ballOn)}`;on.innerHTML=`<span class="nm">${onText}</span>`;box.appendChild(on);return;}
for(let i=0;i<2;i++){const p=g.players[i];const div=document.createElement('div');div.className='who'+(g.turn===i&&g.phase==='playing'?' turn':'');const tagCls=p.group??'';const tagTxt=p.group?GROUP_LABEL[p.group]:'未分组';const left=p.group?remainingOfGroup(numbersOnTable(g.balls),p.group):null;div.innerHTML=`<span class="nm">${esc(p.name)}</span>
      <span class="tag2 ${tagCls}">${tagTxt}</span>
      ${left !== null ? `<span class="tag2">剩 ${left}</span>` : ''}
      ${p.fouls > 0 ? `<span class="fs">连犯 ${p.fouls}</span>` : ''}`;box.appendChild(div);}
if(g.phase==='ended'){const d=document.createElement('div');d.className='who';d.innerHTML=`<span class="nm">本局结束</span><span class="tag2">${esc(g.players[g.winner]?.name ?? '—')} 获胜</span>`;box.appendChild(d);}}
function updateLog(){const g=state.game;updateMatchStats();const box=$('log');let note=null;if(state.historyNote){note=document.createElement('div');note.setAttribute('data-role','history-note');note.setAttribute('style','color:#f59e0b;margin-bottom:4px;');note.textContent=state.historyNote;}
if(!g||!g.log.length){box.innerHTML='';if(note)box.appendChild(note);box.appendChild(document.createTextNode('—'));return;}
box.innerHTML='';if(note)box.appendChild(note);for(const entry of g.log.slice(-40).reverse()){const d=document.createElement('div');d.textContent=`第 ${entry.shot} 杆 · ${entry.summary}`;box.appendChild(d);}
box.scrollTop=0;}
let matchedGeneration=-1;const MATCH_RESULT_TEXT={win:'胜',loss:'负',undecided:'未分胜负'};function formatRate(rate){return typeof rate==='number'&&Number.isFinite(rate)?`${Math.round(rate * 100)}%`:'—';}
function formatMatchWhen(ts){if(!ts)return'—';const d=new Date(ts);if(Number.isNaN(d.getTime()))return'—';const p=(n)=>String(n).padStart(2,'0');return`${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
function recordFinishedMatch(g){if(!g||g.phase!=='ended')return;if(matchedGeneration===state.generation)return;matchedGeneration=state.generation;const stats=computeMatchStats({log:g.log,kind:g.kind,winner:g.winner,myself:0});appendMatch({kind:g.kind,
result:stats.result,
shots:stats.shots,
potRate:stats.potRate,
longestRun:stats.longestRun,
fouls:stats.fouls,});}
function updateMatchStats(){const box=$('matchStats');if(!box)return;const g=state.game;recordFinishedMatch(g);const stats=computeMatchStats({log:g?g.log:[],
kind:g?g.kind:'',
winner:g&&g.phase==='ended'?g.winner:null,
myself:0,});const history=readMatches();const sum=summarizeHistory(history);const parts=[];if(g){parts.push(
'<div class="match-grid">'+
`<div>杆数<b>${stats.shots}</b></div>`+
`<div>进球<b>${stats.pots}</b></div>`+
`<div>命中率<b>${formatRate(stats.potRate)}</b></div>`+
`<div>最长连击<b>${stats.longestRun}</b></div>`+
`<div>犯规<b>${stats.fouls}</b></div>`+
`<div>本局结果<b>${MATCH_RESULT_TEXT[stats.result]}</b></div>`+
'</div>'
);}else{parts.push('<p class="hint">开一局球，打完在这里看复盘。</p>');}
if(!history.length){parts.push('<p class="hint">还没有打完的对局——一局结束会自动记一条。</p>');}else{parts.push('<div class="match-title">最近 5 场</div><ul class="match-list">');for(const m of history.slice(-5).reverse()){const kindLabel=GAME_KINDS[m.kind]?.label??m.kind;const cls=m.result==='win'?'warm':m.result==='loss'?'cold':'';parts.push(
`<li><span>${formatMatchWhen(m.ts)} · ${esc(kindLabel)}</span>`+
`<span class="${cls}">${MATCH_RESULT_TEXT[m.result]} · ${m.shots} 杆 · ${formatRate(m.potRate)}</span></li>`
);}
parts.push('</ul>');parts.push(
'<div class="match-title">汇总</div>'+
`<div class="match-sum">共 ${sum.matches} 场 · ${sum.wins} 胜 ${sum.losses} 负`+
`${sum.undecided ? ` ${sum.undecided} 未分胜负` : ''} · 总杆数 ${sum.shots} · `+
`总体命中率 ${formatRate(sum.potRate)} · 最长连击 ${sum.longestRun}</div>`+
'<div class="match-form">'+
sum.recent
.map((r)=>{const cls=r==='win'?'warm':r==='loss'?'cold':'';return`<i class="match-dot ${cls}" title="${MATCH_RESULT_TEXT[r]}"></i>`;})
.join('')+
'</div>'
);}
box.innerHTML=parts.join('');updateShareMatchButton();}
function updateAutoPauseBar(){const bar=$('autoPauseBar');if(!bar)return;const hint=state.mode==='game'?autoPauseHint(state):null;if(!hint){bar.classList.add('hidden');return;}
bar.classList.remove('hidden');const text=$('autoPauseText');if(text)text.textContent=hint.text;const btn=$('autoPauseResume');if(btn)btn.classList.toggle('hidden',!hint.canResume);}
function resumeAutoOpponent(){Object.assign(state,reduceAutoPause(state,'resume'));if(!state.autoOpponent){state.autoOpponent=true;const box=$('autoOpponent');if(box)box.checked=true;}
updateAutoPauseBar();setReport('已恢复对手自动出杆。');maybeOpponentTurn();}
function gameSolve(){const g=state.game;if(!g||g.phase==='ended')return;if(state.autoOpponent&&!state.autoPaused&&g.turn===1){$('gAdvice').textContent='现在是对手回合，不用你算——它会自己打。';$('gAdvice').className='empty';$('gVerdict').textContent='';return;}
if(state.animating)return;if(g.requiresRerack){$('gAdvice').textContent='上一杆开球不合法，必须先点「重摆开球」——规则里这一杆不算数。';$('gAdvice').className='empty';$('gVerdict').textContent='';return;}
if(g.ballInHand){$('gAdvice').textContent='先把母球摆到台面上（在合法区里点一下）。';$('gAdvice').className='empty';return;}
const onTable=numbersOnTable(g.balls);const allow=legalTargetNumbers(g,onTable);const t0=performance.now();const{plan,kind,alternatives}=planShot(table,g,{allow,safety:state.allowSafety});const ms=performance.now()-t0;if(!plan){state.gSolution={found:false};$('gAdvice').textContent='台面上没有可以合法先碰的球。';$('gAdvice').className='empty';$('gVerdict').textContent='';render();return;}
state.gSolution={found:true,best:plan,all:[plan,...alternatives],kind};$('gAdvice').textContent=describeCandidate(plan);$('gAdvice').className='';const kindLabel=
kind==='break'
?'开球'
:kind==='direct'
?'没有进攻机会，先保证合法'
:kind==='safety'
?'防守'
:difficultyLabel(plan.value??plan.difficulty);const diffTxt=
kind==='attack'
?`（综合 ${plan.value ?? plan.difficulty}/100 · 单杆难度 ${plan.difficulty}/100 · ${difficultyCaveat()}）`
:kind==='safety'
?`（对手容错 ±${plan.safetyOppToleranceDeg.toFixed(2)}° · 从 ±${plan.safetyBaseToleranceDeg.toFixed(2)}° 压下来）`
:'';$('gVerdict').textContent=`${kindLabel}${diffTxt} · 求解 ${ms.toFixed(0)} ms`;$('gVerdict').className=
kind==='attack'&&plan.difficulty>80?'brutal':kind==='attack'&&plan.difficulty>55?'hard':'';render();}
function gameShoot(){const g=state.game;if(!g||g.phase==='ended')return;if(state.autoOpponent&&!state.autoPaused&&g.turn===1)return;if(state.animating)return;if(g.requiresRerack){$('gAdvice').textContent='上一杆开球不合法，先点「重摆开球」。';return;}
if(g.ballInHand){$('gAdvice').textContent='先把母球摆到台面上。';return;}
const sol=state.gSolution;if(!sol||!sol.found){$('gAdvice').textContent='先点「求解」。';return;}
const best=sol.best;const facts=simulateShot(
table,
g.balls,
{angle:best.aimAngle,speed:best.speed,tip:{a:best.tip.a,b:best.tip.b}},
{record:true,dt:SEARCH_DT});const{next,report}=resolveShot(g,facts);pushHistory(g);const gen=state.generation;replay(facts.frames,facts.dt,()=>{if(gen!==state.generation)return;state.game=next;state.gSolution=null;recordTolerance(next.shots,best);state.placing=Boolean(next.ballInHand);canvas.classList.toggle('placing',state.placing);setReport(reportHtml(report,{next,spotted:'only8'}));$('gRerack').classList.toggle('hidden',!next.requiresRerack);$('gAdvice').textContent=next.phase==='ended'?'这一局结束了。':'—';$('gAdvice').className='empty';$('gVerdict').textContent='';updateScore();updateLog();render();Object.assign(state,reduceAutoPause(state,'user-shot'));updateAutoPauseBar();maybeOpponentTurn();});}
function recordTolerance(shotNumber,candidate){if(!candidate||typeof candidate!=='object')return;const shot=Math.floor(Number(shotNumber));const deg=Number(candidate.toleranceDeg);if(!Number.isFinite(shot)||shot<=0)return;if(!Number.isFinite(deg)||deg<=0)return;const entry={shot,
targetNumber:Number.isFinite(Number(candidate.targetNumber))?Number(candidate.targetNumber):null,
pocketId:typeof candidate.pocketId==='string'?candidate.pocketId:'',
toleranceDeg:deg,};state.shotLog=state.shotLog.filter((e)=>e&&e.shot!==shot);state.shotLog.push(entry);if(state.shotLog.length>200)state.shotLog=state.shotLog.slice(-200);}
function pushHistory(game){pushHistoryEntry(state.history,game);updateUndoButton();}
function updateUndoButton(){const btn=$('gUndo');if(!btn)return;const n=state.history.length;btn.disabled=n===0||state.animating;btn.textContent=undoLabel(n);btn.title=state.animating?'这一杆还在回放，演完才能撤销':'';}
function undoGame(){if(state.animating){setReport('这一杆还在回放（对手出杆也算），演完才能撤销——现在撤，下一秒的球位又会盖回来。');return;}
const prev=state.history.pop();if(!prev){setReport('已经退到这一局的起点了，没有更早的局面可退。');return;}
state.game=prev;if(Array.isArray(state.shotLog)){const keep=Number(prev.shots)||0;state.shotLog=state.shotLog.filter((e)=>e&&e.shot<=keep);}
state.generation+=1;state.gSolution=null;state.placing=Boolean(prev.ballInHand);canvas.classList.toggle('placing',state.placing);$('gRerack').classList.toggle('hidden',!prev.requiresRerack);setReport(`已撤销一步，回到第 ${prev.shots} 杆之后的局面。`);$('gAdvice').textContent=prev.phase==='ended'?'这一局结束了。':'—';$('gAdvice').className='empty';$('gVerdict').textContent='撤销后要重新「求解」，原来那份方案对应的是旧局面。';updateScore();updateLog();updateUndoButton();render();state.opponentThinking=false;Object.assign(state,reduceAutoPause(state,'undo'));updateAutoPauseBar();}
function maybeOpponentTurn(){const g=state.game;if(!shouldAutoShoot(state))return;if(g.requiresRerack){setReport('对手开球不合法，需要重摆——点「重摆开球」继续。');$('gRerack').classList.remove('hidden');return;}
state.opponentThinking=true;$('gAdvice').textContent='对手在算这一杆……';$('gAdvice').className='empty';const gen=state.generation;requestAnimationFrame(()=>{if(gen!==state.generation)return;runOpponentTurn(gen);});}
function runOpponentTurn(gen=state.generation){const g=state.game;if(!g||g.phase==='ended'||state.animating){state.opponentThinking=false;return;}
const r=takeTurn(table,g,{record:true,dt:SEARCH_DT,safety:state.allowSafety});if(!r.ok){state.opponentThinking=false;if(r.reason==='needs_rerack'){setReport('对手开球不合法，需要重摆——点「重摆开球」继续。');$('gRerack').classList.remove('hidden');return;}
setReport(`对手这一杆打不出来（${r.reason}）。`);$('gAdvice').textContent='—';$('gAdvice').className='empty';return;}
const placedNote=r.cuePlaced?'（持球，自己摆了母球）':'';const shotNote=
r.kind==='break'
?'开球'
:r.kind==='direct'
?'没有进攻机会，直接撞球'
:r.kind==='safety'
?'打防守'
:describeCandidate(r.plan);setReport(`<b>对手</b>${placedNote}：${shotNote}<div>正在打……</div>`);$('gAdvice').textContent='对手出杆中……';$('gAdvice').className='empty';pushHistory(g);replay(r.facts.frames,r.facts.dt,()=>{if(gen!==state.generation)return;state.game=r.next;recordTolerance(r.next.shots,r.plan);state.opponentThinking=false;state.placing=Boolean(r.next.ballInHand)&&r.next.turn===0;canvas.classList.toggle('placing',state.placing);const chosen=r.scores?.[0];const tail=[];if(chosen){const tol=chosen.myToleranceDeg??chosen.opponentToleranceDeg;const behind=`打完留给你最好打的一杆容错 ±${tol.toFixed(2)}°`;tail.push(r.scores.length>1?`在 ${r.scores.length} 个能进的方案里挑的：${behind}`:behind);}
setReport(
reportHtml(r.report,{next:r.next,
prefix:'<b>对手</b> · ',
spotted:'only8',
ballInHandForPlayerOnly:true,
tail,})
);$('gRerack').classList.toggle('hidden',!r.next.requiresRerack);$('gVerdict').textContent='';updateScore();updateLog();render();updateAutoPauseBar();if(r.next.phase==='ended'){$('gAdvice').textContent='这一局结束了。';$('gAdvice').className='empty';return;}
if(r.next.turn===1){$('gAdvice').textContent='对手继续……';$('gAdvice').className='empty';setTimeout(()=>{if(gen!==state.generation)return;maybeOpponentTurn();},450);return;}
$('gAdvice').textContent='轮到你了。点「求解」看怎么打。';$('gAdvice').className='empty';});}
function doRerack(){const g=state.game;if(!g)return;const balls=createRack(g.kind??'eightball',table,{seed:Math.floor(Math.random()*1e6),}).map((b)=>createBall(b.id,b.x,b.y,b));rerack(g,balls);state.gSolution=null;state.placing=false;canvas.classList.remove('placing');$('gRerack').classList.add('hidden');setReport(`已重摆，${esc(g.players[g.turn].name)}开球。`);$('gAdvice').textContent='—';$('gAdvice').className='empty';updateScore();updateLog();render();Object.assign(state,reduceAutoPause(state,'resume'));updateAutoPauseBar();maybeOpponentTurn();}
function readManualControls(){const m=state.manual;m.speed=Number($('power').value);m.aimOffsetDeg=Number($('aimOffset').value);m.tipB=Number($('tipB').value);m.tipA=Number($('tipA').value);updateManualLabels();}
function updateCueBallPad(){const dot=$('cueBallDot');if(!dot)return;const x=50+(state.manual.tipA/0.5)*38;const y=50-(state.manual.tipB/0.5)*38;dot.style.left=`${x}%`;dot.style.top=`${y}%`;}
function updatePowerMeterUI(tier,speed){const levelEl=$('powerMeterLevel');const pctEl=$('powerMeterPct');const speedEl=$('powerMeterSpeed');const fillEl=$('powerMeterFill');const handleEl=$('powerMeterHandle');if(levelEl){levelEl.textContent=tier.level;levelEl.style.background=tier.badgeBg;levelEl.style.boxShadow=`0 2px 10px ${tier.glow}`;}
if(pctEl){pctEl.textContent=`${tier.pct}%`;pctEl.style.color=tier.color;}
if(speedEl){speedEl.textContent=`${speed.toFixed(2)} m/s`;}
if(fillEl){fillEl.style.height=`${tier.pct}%`;fillEl.style.boxShadow=`0 0 14px ${tier.glow}`;}
if(handleEl){handleEl.style.bottom=`${tier.pct}%`;}
const chips=document.querySelectorAll('.power-chip, .power-meter-chip');chips.forEach((chip)=>{const s=Number(chip.getAttribute('data-speed'));if(Math.abs(s-speed)<0.25){chip.classList.add('active');}else{chip.classList.remove('active');}});}
function updateManualLabels(){const m=state.manual;const tier=getPowerTier(m.speed);$('powerVal').textContent=`${m.speed.toFixed(2)} m/s · ${tier.level} ${tier.pct}%`;$('aimOffsetVal').textContent=`${m.aimOffsetDeg >= 0 ? '' : ''}${m.aimOffsetDeg.toFixed(2)}°`;$('tipBVal').textContent=
Math.abs(m.tipB)<0.03
?'中杆'
:m.tipB>0
?`高杆 +${m.tipB.toFixed(2)}`
:`低杆 ${m.tipB.toFixed(2)}`;$('tipAVal').textContent=
Math.abs(m.tipA)<0.03
?'无塞'
:m.tipA>0
?`右塞 +${m.tipA.toFixed(2)}`
:`左塞 ${m.tipA.toFixed(2)}`;updateCueBallPad();updatePowerMeterUI(tier,m.speed);state.manual.strokeOffset=tier.ratio*0.12;}
function applySolutionToManual(){const inGame=state.mode==='game';const sol=inGame?state.gSolution:state.solution;if(!sol?.found||!sol.best){setAdvice('先求解，才有参数可以套用。','');return;}
const b=sol.best;state.manual.speed=Math.round(clamp(b.speed,Number($('power').min),Number($('power').max))*20)/20;state.manual.aimOffsetDeg=0;state.manual.tipB=b.tip.b??0;state.manual.tipA=b.tip.a??0;state.manual.touched=true;$('power').value=String(state.manual.speed);$('aimOffset').value='0';$('tipB').value=String(state.manual.tipB);$('tipA').value=String(state.manual.tipA);updateManualLabels();if(inGame){$('gAdvice').textContent=`已套用求解参数：${state.manual.speed.toFixed(2)} m/s · ${b.tip.name}。用滑块微调后再打。`;$('gAdvice').className='';}else{setAdvice(`已套用求解参数：${state.manual.speed.toFixed(2)} m/s · ${b.tip.name}。用滑块微调后再打。`,'');}}
function shootManual(){if(state.animating)return;readManualControls();const aim=currentAim(state);if(!aim){if(state.mode==='game')$('gAdvice').textContent='台面上没有可以打的球。';else setAdvice('台面上没有可以打的球。','');return;}
const angle=aim.angle+(state.manual.aimOffsetDeg*Math.PI)/180;const shot={angle,
speed:state.manual.speed,
tip:{a:state.manual.tipA,b:state.manual.tipB},};if(state.mode==='practice')shootPracticeWith(shot,aim);else shootGameWith(shot,aim);}
function solveNextShot(balls){const t0=performance.now();try{return{candidates:solveShot(table,balls,{extras:false}),ms:performance.now()-t0};}catch{return{candidates:null,ms:performance.now()-t0};}}
function shootPracticeWith(shot,aim){const sim=simulateFrames(state.balls,table,shot,SEARCH_DT);if(!sim)return;const{frames,dt,balls:copy}=sim;const next=solveNextShot(copy);const original=snapshotPositions(state.balls);replay(frames,dt,()=>{const outcome=describeManualShot(copy);setAdvice(
describeNextShot({outcome,
balls:copy,
candidates:next.candidates,
table,
finished:numbersOnTable(copy).length===0,
aimFrom:aim.from,
aimOffsetDeg:state.manual.aimOffsetDeg,
touched:state.manual.touched,
speed:state.manual.speed,
tipBLabel:$('tipBVal').textContent,
tipALabel:$('tipAVal').textContent,
solveMs:next.ms,}),
aim.from==='solution'?'方向取自求解结果 + 你调的偏移':'方向直指最近的球（没有求解）'
);restorePositions(state.balls,original);render();});}
function shootGameWith(shot,aim){const g=state.game;if(!g||g.phase==='ended')return;if(state.autoOpponent&&!state.autoPaused&&g.turn===1)return;if(g.requiresRerack){$('gAdvice').textContent='上一杆开球不合法，先点「重摆开球」。';return;}
if(g.ballInHand){$('gAdvice').textContent='先把母球摆到台面上。';return;}
const facts=simulateShot(table,g.balls,shot,{record:true,dt:SEARCH_DT});const{next,report}=resolveShot(g,facts);pushHistory(g);const gen=state.generation;replay(facts.frames,facts.dt,()=>{if(gen!==state.generation)return;finishGameShot(next,report,gen);});void aim;}
function finishGameShot(next,report,gen){state.game=next;state.gSolution=null;state.placing=Boolean(next.ballInHand);canvas.classList.toggle('placing',state.placing);setReport(reportHtml(report,{next,spotted:'any',pendingChoiceHint:true}));$('gRerack').classList.toggle('hidden',!next.requiresRerack);updateChoicePanel(next);$('gAdvice').textContent=next.phase==='ended'?'这一局结束了。':'—';$('gAdvice').className='empty';$('gVerdict').textContent='';updateScore();updateLog();updateUndoButton();render();Object.assign(state,reduceAutoPause(state,'user-shot'));updateAutoPauseBar();if(gen===state.generation)maybeOpponentTurn();}
function updateChoicePanel(g){const pending=g?.pendingChoice??null;if(!pending){$('gChoice').classList.add('hidden');return;}
if(pending.player===1){$('gChoice').classList.add('hidden');const next=acceptTable(g);state.game=next;setReport(`${esc(next.players[1].name)}选择照这样打。`);return;}
$('gChoice').classList.remove('hidden');}
function saveGame(){const g=state.game;if(!g){setReport('还没有开局，没有可存的。');return;}
const stored=readSaveMeta();const verdict=reduceSaveWrite(stored,{stamp:state.saveStamp,
session:state.saveSession,
overwrite:state.saveOverwrite,});if(!verdict.write){const theirs=describeSave();state.saveOverwrite=true;setReport(
(verdict.reason==='other-tab'
?'这份存档是另一个标签页写的'
:'存档已经被另一个标签页改过了')+
`（那边存的是第 ${theirs?.shots ?? '?'} 杆），这一局没有覆盖它。`+
'确认要覆盖的话，再点一次「存这一局」。'
);refreshSaveInfo();return;}
const ok=writeSave(g,undefined,{history:state.history,session:state.saveSession});state.saveOverwrite=false;if(ok){state.otherSaveShots=null;state.saveStamp=readSaveStamp();setReport(`已存档：第 ${g.shots} 杆，${g.balls.filter((b) => !b.pocketed && b.number !== 0).length} 颗目标球在台上。刷新页面后点「读取存档」能接着打。`);refreshSaveInfo();}else{setReport(
saveFailureKind()==='quota'
?'存不了——本地存储的配额满了，这一局没有写进去。点下面「删除存档」清掉旧的那份腾出空间，再存一次。'
:'存不了——浏览器禁用了本地存储（隐私模式、或站点被设成不保存数据）。换个普通窗口打开这一页再存。'
);}}
function loadGame(){const{status,saved,discarded}=loadSave();if(!saved){if(status==='corrupt'){setReport(
discarded
?'存档已损坏（读不出合法局面），已从本地存储删除。'
:'存档已损坏（读不出合法局面），本次没有加载；本地存储删不掉，它还会在。',
);refreshSaveInfo();return;}
if(status==='newer'){setReport('存档来自更新的版本，这个版本读不了；没有动它，换回新版页面还能接着打。');refreshSaveInfo();return;}
setReport('没有可用的存档。');refreshSaveInfo();return;}
applyLoadedGame(saved);state.saveSession=readSaveMeta()?.session??TAB_SESSION;}
function applyLoadedGame(saved){if(saved.table.id!==table.preset){const okTable=TABLE_PRESETS[saved.table.id];if(!okTable){setReport(`存档用的球台（${saved.table.id}）这个版本不认识，读不了。`);return;}
setTablePreset(saved.table.id);}
const balls=saved.balls.map((b)=>createBall(b.id,b.x,b.y,b));const g=createGame(table,balls,{names:saved.players.map((p)=>p.name),kind:saved.kind});state.gameKind=g.kind;$('gameKind').value=g.kind;restoreGameState(g,saved);state.generation+=1;state.game=g;matchedGeneration=state.generation;state.gSolution=null;state.animating=false;state.opponentThinking=false;state.placing=Boolean(g.ballInHand);canvas.classList.toggle('placing',state.placing);const decoded=unpackHistory(saved.history,g);state.history=decoded.entries;state.shotLog=[];const missing=Math.max(decoded.dropped,saved.shots-decoded.entries.length);state.historyNote=missing>0?`更早的 ${missing} 步未随存档保存`:null;state.saveStamp=saved.savedAt;state.saveOverwrite=false;Object.assign(state,reduceAutoPause(state,'load'));updateUndoButton();$('gRerack').classList.toggle('hidden',!g.requiresRerack);$('gAdvice').textContent='—';$('gAdvice').className='empty';$('gVerdict').textContent='';setReport(`已读取存档：第 ${g.shots} 杆，轮到「${esc(g.players[g.turn].name)}」。`);if(state.mode!=='game')setMode('game');updateScore();updateLog();render();updateAutoPauseBar();maybeOpponentTurn();}
function removeSave(){const ok=clearSave();state.saveStamp=null;state.saveSession=TAB_SESSION;state.saveOverwrite=false;setReport(ok?'存档已删除。':'删不了——浏览器禁用了本地存储。');refreshSaveInfo();}
function exportGameText(now=Date.now()){const g=state.game;if(!g)return null;return JSON.stringify(serialize(g,now,state.history),null,2);}
function importGameText(text){let raw;try{raw=JSON.parse(text);}catch{return{ok:false,reason:'这个文件不是 JSON，可能选错了。'};}
const saved=sanitize(raw);if(!saved){return{ok:false,
reason:'这份存档用不了：球台或玩法认不出来，或者球位跑出台了面。为了不把台面弄乱，整份丢掉了。',};}
applyLoadedGame(saved);return{ok:true,reason:''};}
function downloadText(filename,text,mime='application/json'){let url;try{url=URL.createObjectURL(new Blob([text],{type:mime}));}catch{return false;}
const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;}
const SHARE_WIDTH=1080;const SHARE_PAD=48;const SHARE_FONT='"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';const SHARE_TITLE_FONT=`700 46px ${SHARE_FONT}`;const SHARE_META_FONT=`500 26px ${SHARE_FONT}`;const SHARE_LABEL_FONT=`600 30px ${SHARE_FONT}`;const SHARE_VALUE_FONT=`500 30px ${SHARE_FONT}`;const SHARE_FOOT_FONT=`500 22px ${SHARE_FONT}`;const SHARE_TITLE_H=58;const SHARE_META_H=34;const SHARE_LINE_H=44;const SHARE_ROW_GAP=24;const SHARE_LABEL_COL=156;const SHARE_BG='#0b1219';const SHARE_TEXT='#e8f0f7';const SHARE_MUTED='#93a4b5';const SHARE_CHART_H=300;const SHARE_CHART_GAP=34;const SHARE_CHART_BG='rgba(148, 163, 184, 0.08)';const SHARE_CHART_GRID='rgba(147, 164, 181, 0.28)';const SHARE_CHART_FONT=`500 24px ${SHARE_FONT}`;const SHARE_CHART_TICK_FONT=`500 22px ${SHARE_FONT}`;const SHARE_CHART_SERIES=[
{key:'y1',label:'我',color:'#38bdf8'},
{key:'y2',label:'对手',color:'#f59e0b'},
];const shareState={url:'',filename:''};function shareFileName(prefix='shot'){const d=new Date();const pad=(n)=>String(n).padStart(2,'0');return`billiards-${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;}
function invalidateShare(){if(shareState.url){URL.revokeObjectURL(shareState.url);shareState.url='';}
shareState.filename='';const out=$('shareOut');if(out)out.classList.add('hidden');const img=$('shareImage');if(img)img.removeAttribute('src');const hint=$('shareHint');if(hint)hint.textContent='生成一张图，发给练球的人。';}
function wrapShareText(ctx,text,maxWidth){const chars=Array.from(String(text??''));if(!chars.length)return[''];const lines=[];let line='';for(const ch of chars){const next=line+ch;if(line&&ctx.measureText(next).width>maxWidth){lines.push(line);line=ch;}else{line=next;}}
lines.push(line);return lines;}
function drawShareChart(ctx,chart,x,y,width,height){ctx.save();ctx.textBaseline='top';ctx.fillStyle=SHARE_CHART_BG;ctx.fillRect(x,y,width,height);ctx.font=SHARE_CHART_FONT;ctx.fillStyle=SHARE_MUTED;ctx.textAlign='left';ctx.fillText('比分走势（累计进球）',x+24,y+18);let legendRight=x+width-24;for(const s of[...SHARE_CHART_SERIES].reverse()){ctx.textAlign='right';ctx.fillStyle=SHARE_MUTED;ctx.fillText(s.label,legendRight,y+19);const labelW=ctx.measureText(s.label).width;ctx.fillStyle=s.color;ctx.fillRect(legendRight-labelW-22,y+23,14,14);legendRight-=labelW+44;}
const plotX=x+64;const plotY=y+64;const plotW=width-64-28;const plotH=height-64-42;let maxY=1;for(const p of chart)maxY=Math.max(maxY,p.y1,p.y2);maxY=Math.ceil(maxY);const minX=chart[0].x;const maxX=chart[chart.length-1].x;const spanX=Math.max(1,maxX-minX);const px=(v)=>plotX+((v-minX)/spanX)*plotW;const py=(v)=>plotY+plotH-(v/maxY)*plotH;ctx.font=SHARE_CHART_TICK_FONT;ctx.strokeStyle=SHARE_CHART_GRID;ctx.lineWidth=1;const ticks=maxY<=4?Array.from({length:maxY+1},(_,i)=>i):[0,Math.round(maxY/2),maxY];for(const t of ticks){const ty=Math.round(py(t))+0.5;ctx.beginPath();ctx.moveTo(plotX,ty);ctx.lineTo(plotX+plotW,ty);ctx.stroke();ctx.fillStyle=SHARE_MUTED;ctx.textAlign='right';ctx.fillText(String(t),plotX-14,ty-12);}
ctx.textAlign='left';ctx.fillStyle=SHARE_MUTED;ctx.fillText(`第 ${minX} 杆`,plotX,plotY+plotH+12);ctx.textAlign='right';ctx.fillText(`第 ${maxX} 杆`,plotX+plotW,plotY+plotH+12);for(const s of SHARE_CHART_SERIES){ctx.strokeStyle=s.color;ctx.lineWidth=4;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();chart.forEach((p,i)=>{const cx=px(p.x);const cy=py(p[s.key]);if(i===0)ctx.moveTo(cx,cy);else ctx.lineTo(cx,cy);});ctx.stroke();if(chart.length<=20){ctx.fillStyle=s.color;for(const p of chart){ctx.beginPath();ctx.arc(px(p.x),py(p[s.key]),4,0,Math.PI*2);ctx.fill();}}}
ctx.restore();}
function buildShareSheet({scene,summary,meta}){const measure=document.createElement('canvas').getContext('2d');const bodyWidth=SHARE_WIDTH-SHARE_PAD*2-SHARE_LABEL_COL;const rows=summary.lines.map((row)=>{measure.font=SHARE_VALUE_FONT;return{label:row.label,chunks:wrapShareText(measure,row.value,bodyWidth)};});const rowsH=rows.reduce((sum,r)=>sum+r.chunks.length*SHARE_LINE_H+SHARE_ROW_GAP,0);const sceneH=scene?scene.height:0;const chart=Array.isArray(summary.chart)
?summary.chart.filter((p)=>p&&typeof p==='object')
:[];const chartH=chart.length>=2?SHARE_CHART_H:0;const height=Math.round(
SHARE_PAD+
SHARE_TITLE_H+
SHARE_META_H+
18+
sceneH+
(scene?34:0)+
chartH+
(chartH?SHARE_CHART_GAP:0)+
rowsH+
40+
SHARE_PAD,
);const out=document.createElement('canvas');out.width=SHARE_WIDTH;out.height=height;const ctx=out.getContext('2d');ctx.textBaseline='top';ctx.fillStyle=SHARE_BG;ctx.fillRect(0,0,out.width,out.height);let y=SHARE_PAD;ctx.fillStyle=SHARE_TEXT;ctx.font=SHARE_TITLE_FONT;ctx.fillText(summary.title,SHARE_PAD,y);y+=SHARE_TITLE_H;ctx.fillStyle=SHARE_MUTED;ctx.font=SHARE_META_FONT;ctx.fillText(meta,SHARE_PAD,y);y+=SHARE_META_H+18;if(scene){ctx.drawImage(
scene.canvas,
0,
0,
scene.canvas.width,
scene.canvas.height,
SHARE_PAD,
y,
scene.width,
sceneH,
);y+=sceneH+34;}
if(chartH){drawShareChart(ctx,chart,SHARE_PAD,y,SHARE_WIDTH-SHARE_PAD*2,chartH);y+=chartH+SHARE_CHART_GAP;}
for(const row of rows){ctx.fillStyle=SHARE_MUTED;ctx.font=SHARE_LABEL_FONT;ctx.fillText(row.label,SHARE_PAD,y+2);ctx.fillStyle=SHARE_TEXT;ctx.font=SHARE_VALUE_FONT;row.chunks.forEach((chunk,i)=>{ctx.fillText(chunk,SHARE_PAD+SHARE_LABEL_COL,y+i*SHARE_LINE_H);});y+=row.chunks.length*SHARE_LINE_H+SHARE_ROW_GAP;}
ctx.fillStyle=SHARE_MUTED;ctx.font=SHARE_FOOT_FONT;ctx.fillText('AI 台球教练 · 长按图片可保存',SHARE_PAD,y+6);return out;}
function shareMetaText(){const board=TABLE_PRESETS[table.preset]?.label??'台面';const d=new Date();const pad=(n)=>String(n).padStart(2,'0');return`${board} · ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function buildShotSheet(){const card=state.solution;if(!card)return null;const summary=buildShareSummary({shot:card,table,balls:state.balls});const scene=createShareScene({table,
balls:state.balls,
shot:card.found?card.best:null,
maxWidth:SHARE_WIDTH-SHARE_PAD*2,});return{canvas:buildShareSheet({scene,summary,meta:shareMetaText()}),
title:summary.title,
alt:`这一杆：${summary.title}`,
prefix:'shot',};}
function buildTableSheet(){const game=state.mode==='game'?state.game:null;const balls=game?game.balls:state.balls;const list=Array.isArray(balls)?balls.filter((b)=>b&&typeof b==='object'):[];if(!list.length)return null;const summary=buildTableSummary({game,
balls:list,
table,
shot:game?state.gSolution:state.solution,});const scene=createShareScene({table,
balls:list,
mark:summary.mark,
maxWidth:SHARE_WIDTH-SHARE_PAD*2,});return{canvas:buildShareSheet({scene,summary,meta:shareMetaText()}),
title:summary.title,
alt:`局面：${summary.title}`,
prefix:'table',};}
function buildMatchSheet(){const game=state.mode==='game'?state.game:null;if(!game)return null;const summary=currentMatchSummary();if(!summary)return null;const list=Array.isArray(game.balls)?game.balls.filter((b)=>b&&typeof b==='object'):[];if(!list.length)return null;const scene=createShareScene({table,balls:list,maxWidth:SHARE_WIDTH-SHARE_PAD*2});return{canvas:buildShareSheet({scene,summary,meta:shareMetaText()}),
title:summary.title,
alt:`复盘：${summary.title}`,
prefix:'match',};}
async function publishShare({canvas,alt,prefix}){const blob=await new Promise((resolve)=>{canvas.toBlob((b)=>resolve(b),'image/png');});if(!blob)return null;if(shareState.url)URL.revokeObjectURL(shareState.url);const url=URL.createObjectURL(blob);const filename=shareFileName(prefix);shareState.url=url;shareState.filename=filename;const img=$('shareImage');img.alt=alt;img.src=url;$('sharePreview').href=url;$('shareOpen').href=url;const download=$('shareDownload');download.href=url;download.download=filename;$('shareOut').classList.remove('hidden');try{await img.decode();}catch{}
return{url,filename,bytes:blob.size,width:canvas.width,height:canvas.height};}
async function exportShare({buttonId,blockedReason,blockedHint,build}){const button=$(buttonId);const hint=$('shareHint');let job=null;try{job=build();}catch{job=null;}
if(!job){if(hint)hint.textContent=blockedHint;return{ok:false,reason:blockedReason};}
if(button)button.disabled=true;if(hint)hint.textContent='正在生成…';try{const out=await publishShare(job);if(!out){if(hint)hint.textContent='这张图没生成出来，换个浏览器或重试一次。';return{ok:false,reason:'no-blob'};}
if(hint)hint.textContent=`${out.width}×${out.height} PNG · ${Math.round(out.bytes / 1024)} KB`;return{ok:true,
width:out.width,
height:out.height,
bytes:out.bytes,
url:out.url,
filename:out.filename,
title:job.title,};}catch(err){if(hint)hint.textContent='生成失败：这个浏览器画不出导出图。';return{ok:false,reason:err instanceof Error?err.message:String(err)};}finally{if(button)button.disabled=false;}}
async function shareShot(){return exportShare({buttonId:'shareShot',
blockedReason:'no-solution',
blockedHint:'先点「求解最佳方案」，再把这一杆分享出去。',
build:buildShotSheet,});}
async function shareTable(){return exportShare({buttonId:'shareTable',
blockedReason:'no-table',
blockedHint:'台面上还没有球，先摆球或开一局。',
build:buildTableSheet,});}
function currentMatchSummary(){const game=state.mode==='game'?state.game:null;if(!game)return null;const log=Array.isArray(game.log)?game.log:[];return buildMatchSummary({game,
log,
stats:computeMatchStats({log,
kind:game.kind,
winner:game.phase==='ended'?game.winner:null,
myself:0,}),
table,
shots:state.shotLog,});}
function matchShareBlockedReason(){const game=state.mode==='game'?state.game:null;if(!game)return'先开一局球，打完才能复盘。';if(game.phase!=='ended')return'本局还没结束，打完这一局才能导出复盘。';return'';}
function updateShareMatchButton(){const btn=$('shareMatch');if(!btn)return;const why=matchShareBlockedReason()||(currentMatchSummary()?'':'这一局没有可复盘的内容。');btn.disabled=Boolean(why);btn.title=why||'把这一局的终局台面、比分走势和关键杆导成一张图';}
async function shareMatch(){return exportShare({buttonId:'shareMatch',
blockedReason:'no-match',
blockedHint:matchShareBlockedReason()||'这一局还没有可以复盘的内容。',
build:buildMatchSheet,}).finally(updateShareMatchButton);}
function exportGameSave(){const text=exportGameText();if(!text){setReport('还没有开局，没有可导出的。');return;}
const d=new Date();const pad=(n)=>String(n).padStart(2,'0');const name=`billiards-game-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;if(!downloadText(name,text)){setReport('导出失败：浏览器没法创建下载文件。');return;}
setReport(`已导出 ${name}（第 ${state.game.shots} 杆）。换设备后用「从文件读取」能接着打。`);}
function importGameSaveFromFile(file){if(!file)return;const reader=new FileReader();reader.onload=()=>{const result=importGameText(String(reader.result??''));if(result.ok){setReport(`已从文件读入：第 ${state.game.shots} 杆，轮到「${esc(state.game.players[state.game.turn].name)}」。`);}else{setReport(result.reason);}};reader.onerror=()=>setReport('读取文件失败，可能没有权限或文件已被移动。');reader.readAsText(file);}
function undoLastPracticeRecord(){const before=readPracticeLog().length;if(!popLastPracticeResult()){updatePracticeFeedback('没有可撤销的记录。');return false;}
state.practiceRecorded=false;updatePracticeLog();updatePracticeFeedback(`已撤销刚才那条记录（${before} → ${before - 1} 条）。`);return true;}
function removePracticeLog(){if(!window.confirm('确定清空本机保存的实战练习记录吗？'))return;const ok=clearPracticeLog();if(ok){updatePracticeLog();updatePracticeFeedback('实战记录已清空。');}else{updatePracticeFeedback('记录未能清空；请检查浏览器是否允许本地存储。');}}
function exportPracticeRecords(){const records=readPracticeLog();if(!records.length){updatePracticeFeedback('暂无可导出的实战练习记录。');return;}
let downloadUrl;try{const blob=new Blob([exportPracticeCsv(records)],{type:'text/csv;charset=utf-8'});downloadUrl=URL.createObjectURL(blob);const link=document.createElement('a');link.href=downloadUrl;const now=new Date();const date=`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;link.download=`台球练习记录-${date}.csv`;document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(downloadUrl),1000);updatePracticeFeedback(`已导出 ${records.length} 条练习记录。`);}catch(error){if(downloadUrl)URL.revokeObjectURL(downloadUrl);updatePracticeFeedback(`导出失败：${error.message || '浏览器无法创建下载文件。'}`);}}
function downloadPracticeBackup(){const records=readPracticeLog();let downloadUrl;try{const blob=new Blob(
[exportPracticeBackup(records)],
{type:'application/json;charset=utf-8'});downloadUrl=URL.createObjectURL(blob);const link=document.createElement('a');const now=new Date();const date=`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;link.href=downloadUrl;link.download=`台球练习备份-${date}.json`;document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(downloadUrl),1000);updatePracticeFeedback(`已备份 ${records.length} 条练习记录。`);}catch(error){if(downloadUrl)URL.revokeObjectURL(downloadUrl);updatePracticeFeedback(`备份失败：${error.message || '浏览器无法创建下载文件。'}`);}}
async function restorePracticeBackup(file){if(!file)return;if(file.size>MAX_BACKUP_BYTES){updatePracticeFeedback('备份文件超过 1 MB，已拒绝导入。');return;}
try{const records=parsePracticeBackup(await file.text());if(!records){updatePracticeFeedback('备份文件无效或包含不支持的数据；现有记录未更改。');return;}
if(!window.confirm(`将用备份中的 ${records.length} 条记录替换当前记录，是否继续？`)){updatePracticeFeedback('已取消恢复，现有记录未更改。');return;}
if(!replacePracticeLog(records)){updatePracticeFeedback('恢复失败；浏览器未能保存备份，现有记录未更改。');return;}
updatePracticeLog();updatePracticeFeedback(`已恢复 ${records.length} 条练习记录。`);}catch(error){updatePracticeFeedback(`读取备份失败：${error.message || '无法读取所选文件。'}`);}}
function refreshSaveInfo(){const info=describeSave();const box=$('saveInfo');if(!box)return;if(!info){box.textContent='还没有存档。存的是局面本身（球位、分组、杆数、轮到谁），刷新页面之后还能接着打。';return;}
const who=info.turn===0?'你':'对手';const takeBtn=$('takeOtherSave');if(takeBtn){const pending=state.otherSaveShots;takeBtn.classList.toggle('hidden',pending===null);takeBtn.textContent=pending===null?'读入另一个标签页存的':`读入另一个标签页存的（第 ${pending} 杆）`;}
box.textContent=info.ended
?`存档：${info.tableId} · 第 ${info.shots} 杆 · 这一局已经结束（${who}赢）`
:`存档：${info.tableId} · 第 ${info.shots} 杆 · ${info.onTable} 颗目标球在台上 · 轮到${who}`;}
function setMode(mode){state.generation+=1;state.mode=mode;state.solution=null;state.gSolution=null;state.animating=false;updatePracticeFeedback();$('tabPractice').classList.toggle('on',mode==='practice');$('tabGame').classList.toggle('on',mode==='game');$('practicePanel').classList.toggle('hidden',mode!=='practice');$('gamePanel').classList.toggle('hidden',mode!=='game');$('subtitle').textContent=
mode==='practice'
?'拖动任意球改摆位 · 求解后给出瞄准线、容错窗口与力度'
:'标准黑八 15 颗 + 母球 · 按 WPA 规则判分组、犯规与胜负';if(mode==='game'&&!state.game)newGame();updateShareMatchButton();render();updateAutoPauseBar();if(mode==='game')maybeOpponentTurn();}
$('tabPractice').addEventListener('click',()=>setMode('practice'));$('tabGame').addEventListener('click',()=>setMode('game'));$('solve').addEventListener('click',()=>{if(!state.animating)runSolve();});$('shoot').addEventListener('click',()=>{if(!state.animating)shootPractice();});$('reset').addEventListener('click',resetLayout);$('shareShot').addEventListener('click',()=>{if(!state.animating)shareShot();});$('shareTable').addEventListener('click',()=>{if(!state.animating)shareTable();});$('shareMatch').addEventListener('click',()=>{if(!state.animating)shareMatch();});$('addBall').addEventListener('click',addBall);$('rackUp').addEventListener('click',rackUp);$('newGame').addEventListener('click',newGame);$('gSolve').addEventListener('click',gameSolve);$('gShoot').addEventListener('click',gameShoot);$('gUndo').addEventListener('click',undoGame);$('gRerack').addEventListener('click',doRerack);$('removeBall').addEventListener('click',removeBall);$('tablePreset').addEventListener('change',(ev)=>{state.tableManual[state.gameKind]=ev.target.value;setTablePreset(ev.target.value);});$('viewToggle').addEventListener('click',toggleView);$('showCone').addEventListener('change',render);$('showGhost').addEventListener('change',render);$('autoOpponent').addEventListener('change',(ev)=>{state.autoOpponent=ev.target.checked;if(state.autoOpponent)Object.assign(state,reduceAutoPause(state,'resume'));updateAutoPauseBar();if(state.autoOpponent)maybeOpponentTurn();});$('autoPauseResume').addEventListener('click',resumeAutoOpponent);$('gameKind').addEventListener('change',(ev)=>{const v=ev.target.value;state.gameKind=gameKindOrThrow(v);const target=tableForKind(state.gameKind,state.tableManual);if(target&&target!==table.preset){setTablePreset(target);if(state.mode!=='game')newGame();return;}
newGame();});$('allowSafety').addEventListener('change',(ev)=>{state.allowSafety=ev.target.checked;});$('gAccept').addEventListener('click',()=>{const g=state.game;if(!g?.pendingChoice)return;const next=acceptTable(g);state.generation+=1;state.game=next;state.gSolution=null;$('gChoice').classList.add('hidden');setReport('你选择照这样打。');$('gAdvice').textContent='—';$('gAdvice').className='empty';updateScore();updateLog();render();maybeOpponentTurn();});$('gHandBack').addEventListener('click',()=>{const g=state.game;if(!g?.pendingChoice)return;const next=handBackBreak(g);state.generation+=1;state.game=next;state.gSolution=null;$('gChoice').classList.add('hidden');setReport(`已把台面交回给 ${esc(next.players[next.turn].name)}。`);$('gAdvice').textContent='—';$('gAdvice').className='empty';updateScore();updateLog();render();maybeOpponentTurn();});let pendingSliderRender=false;for(const id of['power','aimOffset','tipB','tipA']){$(id).addEventListener('input',()=>{readManualControls();state.manual.touched=true;if(view.getCamera().t>0.01&&!pendingSliderRender){pendingSliderRender=true;requestAnimationFrame(()=>{pendingSliderRender=false;render();});}});}
const cuePad=$('cueBallPad');if(cuePad){let draggingPad=false;const setFromPad=(ev)=>{const rect=cuePad.getBoundingClientRect();const cx=rect.left+rect.width/2;const cy=rect.top+rect.height/2;let dx=(ev.clientX-cx)/(rect.width/2);let dy=(ev.clientY-cy)/(rect.height/2);const dist=Math.hypot(dx,dy);if(dist>1){dx/=dist;dy/=dist;}
const tipA=Math.round(clamp(dx*0.5,-0.5,0.5)*20)/20;const tipB=Math.round(clamp(-dy*0.5,-0.5,0.5)*20)/20;$('tipA').value=String(tipA);$('tipB').value=String(tipB);readManualControls();state.manual.touched=true;};cuePad.addEventListener('pointerdown',(ev)=>{draggingPad=true;cuePad.setPointerCapture?.(ev.pointerId);setFromPad(ev);});cuePad.addEventListener('pointermove',(ev)=>{if(draggingPad)setFromPad(ev);});const endPadDrag=()=>{draggingPad=false;};cuePad.addEventListener('pointerup',endPadDrag);cuePad.addEventListener('pointercancel',endPadDrag);}
$('useSolution').addEventListener('click',applySolutionToManual);$('shootManual').addEventListener('click',shootManual);$('practiceMade').addEventListener('click',()=>recordPracticeOutcome(true));$('practiceMissed').addEventListener('click',()=>recordPracticeOutcome(false));$('clearPractice').addEventListener('click',removePracticeLog);$('practiceUndo').addEventListener('click',undoLastPracticeRecord);$('exportPractice').addEventListener('click',exportPracticeRecords);$('backupPractice').addEventListener('click',downloadPracticeBackup);$('restorePractice').addEventListener('click',()=>$('practiceBackupFile').click());$('practiceBackupFile').addEventListener('change',(event)=>{restorePracticeBackup(event.target.files?.[0]).finally(()=>{event.target.value='';});});$('practiceGoal').addEventListener('change',(event)=>{const goal=Number(event.target.value);if(!PRACTICE_GOALS.includes(goal)||!writePracticeGoal(goal)){$('practiceGoal').value=String(readPracticeGoal());updatePracticeFeedback('目标设置未能保存；请检查浏览器是否允许本地存储。');return;}
updatePracticeLog();updatePracticeFeedback(`今日目标已更新为 ${goal} 杆。`);});$('drillSelect').addEventListener('change',()=>updateDrillStatus());$('startDrill').addEventListener('click',startPracticeDrill);$('practiceFocusAction').addEventListener('click',()=>{const focus=summarizePracticeFocus(readPracticeLog());if(!focus.drillId)return;$('drillSelect').value=focus.drillId;startPracticeDrill();});$('saveGame').addEventListener('click',saveGame);$('loadGame').addEventListener('click',loadGame);$('clearSave').addEventListener('click',removeSave);$('exportGameSave').addEventListener('click',exportGameSave);$('importGameSave').addEventListener('click',()=>$('gameSaveFile').click());$('gameSaveFile').addEventListener('change',(e)=>{importGameSaveFromFile(e.target.files?.[0]??null);e.target.value='';});$('takeOtherSave').addEventListener('click',()=>{const shots=state.otherSaveShots;state.otherSaveShots=null;loadGame();refreshSaveInfo();setReport(`读入另一个标签页存的存档（第 ${shots ?? '?'} 杆）。这一边原来的局面被替换掉了。`);});window.addEventListener('storage',(e)=>{if(e.key!==SAVE_KEY)return;state.saveOverwrite=false;if(e.newValue===null){state.saveStamp=null;state.otherSaveShots=null;setReport('另一个标签页把存档删掉了。这边不受影响。');}else{const theirs=describeSave();state.otherSaveShots=theirs?.shots??0;setReport(
`另一个标签页刚存了一份新的（第 ${theirs?.shots ?? '?'} 杆）。`+
'这边接着打没问题；想接着那边打，点「读入另一个标签页存的」。'+
'点「存这一局」时也会先问一句，免得把它盖掉。'
);}
refreshSaveInfo();});function isTypingTarget(el){if(!el)return false;const tag=el.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return true;return el.isContentEditable===true;}
function nudgeManual(kind,delta){const id=kind==='aim'?'aimOffset':'power';const el=$(id);const min=Number(el.min);const max=Number(el.max);el.value=String(clamp(Number(el.value)+delta,min,max));readManualControls();state.manual.touched=true;}
function onKeyDown(ev){if(ev.ctrlKey||ev.metaKey||ev.altKey)return;if(isTypingTarget(ev.target))return;if(state.animating){if((ev.key==='z'||ev.key==='Z')&&state.mode==='game'){ev.preventDefault();undoGame();}
return;}
const inGame=state.mode==='game';switch(ev.key){case'v':
case'V':
ev.preventDefault();toggleView();break;case's':
case'S':
ev.preventDefault();if(inGame)gameSolve();else runSolve();break;case'Enter':
case' ':
ev.preventDefault();if(inGame)gameShoot();else shootPractice();break;case'z':
case'Z':
if(!inGame)return;ev.preventDefault();undoGame();break;case'n':
case'N':
ev.preventDefault();if(inGame)newGame();else resetLayout();break;case'1':
ev.preventDefault();setMode('practice');break;case'2':
ev.preventDefault();setMode('game');break;case'ArrowLeft':
ev.preventDefault();nudgeManual('aim',-0.1);break;case'ArrowRight':
ev.preventDefault();nudgeManual('aim',0.1);break;case'ArrowUp':
ev.preventDefault();nudgeManual('power',0.1);break;case'ArrowDown':
ev.preventDefault();nudgeManual('power',-0.1);break;default:
break;}}
document.addEventListener('keydown',onKeyDown);window.addEventListener('resize',resize);resetLayout();resize();updatePracticeLog();updateMatchStats();for(const preset of Object.values(TABLE_PRESETS)){const opt=document.createElement('option');opt.value=preset.id;opt.textContent=preset.label;$('tablePreset').appendChild(opt);}
$('tablePreset').value=table.preset;function initPowerMeterEvents(){const track=$('powerMeterTrack');const handle=$('powerMeterHandle');if(!track)return;let dragging=false;const setPowerFromPointer=(ev,throttled=false)=>{const rect=track.getBoundingClientRect();const ratio=clamp(1-(ev.clientY-rect.top)/rect.height,0,1);const min=Number($('power').min)||0.55;const max=Number($('power').max)||6.60;const speed=Math.round((min+ratio*(max-min))*20)/20;$('power').value=String(speed);state.manual.speed=speed;state.manual.touched=true;updateManualLabels();if(view.getCamera().t>0.01){if(throttled&&!pendingSliderRender){pendingSliderRender=true;requestAnimationFrame(()=>{pendingSliderRender=false;render();});}else if(!throttled){render();}}};track.addEventListener('pointerdown',(ev)=>{dragging=true;handle?.classList.add('dragging');track.setPointerCapture?.(ev.pointerId);setPowerFromPointer(ev,false);});track.addEventListener('pointermove',(ev)=>{if(dragging)setPowerFromPointer(ev,true);});const stopDrag=()=>{if(dragging){dragging=false;handle?.classList.remove('dragging');}};track.addEventListener('pointerup',stopDrag);track.addEventListener('pointercancel',stopDrag);document.querySelectorAll('.power-meter-chip, .power-chip').forEach((btn)=>{btn.addEventListener('click',(ev)=>{ev.stopPropagation();const targetSpeed=Number(btn.getAttribute('data-speed'));if(!Number.isFinite(targetSpeed))return;$('power').value=String(targetSpeed);state.manual.speed=targetSpeed;state.manual.touched=true;updateManualLabels();if(view.getCamera().t>0.01)render();});});}
initPowerMeterEvents();updateManualLabels();refreshSaveInfo();$('verdictNote').textContent=
`难度档位按「瞄准误差 ±${LABEL_SIGMA_DEG}°」估算`+
`（1 米外偏 ${(Math.tan((LABEL_SIGMA_DEG * Math.PI) / 180) * 1000).toFixed(1)} 毫米，`+
`2 米外偏 ${(Math.tan((LABEL_SIGMA_DEG * Math.PI) / 180) * 2000).toFixed(1)} 毫米）。`+
`瞄得比这松，实际命中率会低于档位名；瞄得比这准，会高于档位名。`;window.__app={state,
get table(){return table;},
view,
get mode(){return state.mode;},
setMode,
replay,
runSolve,
gameSolve,
gameShoot,
undoGame,
maybeOpponentTurn,
newGame,
rackUp,
addBall,
removeBall,
setTablePreset,
resetLayout,
shootManual,
recordPracticeOutcome,
undoLastPracticeRecord,
updatePracticeLog,
practiceCount:()=>readPracticeLog().length,
applySolutionToManual,
currentAim:()=>currentAim(state),
saveGame,
loadGame,
removeSave,
resumeAutoOpponent,
exportGameText,
importGameText,
shareShot,
shareTable,
shareMatch,
buildMatchSummary,
buildTableSummary,
refreshSaveInfo,
onKeyDown,
toggleView,
getCamera:()=>view.getCamera(),
setCameraT:(t)=>{syncCamera(t);render();},};
