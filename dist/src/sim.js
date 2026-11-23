import{SEARCH_DT,MAX_SHOT_TIME}from'./constants.js';import{createBall,createWorld,strike,runShot}from'./physics.js';const resetMotion=(b)=>({...b,vx:0,vy:0,wx:0,wy:0,wz:0});function snapshotBall(b){return typeof b.vx==='number'&&typeof b.pocketed==='boolean'
?{...b}
:createBall(b.id,b.x,b.y,b);}
let simRuns=0;export function simRunCount(){return simRuns;}
export function resetSimRunCount(){simRuns=0;}
const NO_SHOT={ok:false,
cue:null,
balls:[],
events:[],
elapsed:0,
settled:false,
firstContact:null,
firstContactId:null,
hitNumber:null,
hitBall:null,};export function simulateShot(table,balls,shot,opts={}){const cueId=shot.cueId??opts.cueId??'cue';const dt=opts.dt??SEARCH_DT;const maxTime=opts.maxTime??MAX_SHOT_TIME;const copy=balls.map(opts.normalize?snapshotBall:resetMotion);const world=createWorld(table,copy);const cue=copy.find((b)=>b.id===cueId);if(!cue)return{...NO_SHOT,cue:null,balls:copy,reason:'no_cue'};if(opts.rejectPocketedCue&&cue.pocketed)return{...NO_SHOT,cue,balls:copy,reason:'cue_pocketed'};if(opts.targetId&&!copy.some((b)=>b.id===opts.targetId)){return{...NO_SHOT,cue,balls:copy,reason:'no_target'};}
simRuns++;strike(cue,{angle:shot.angle,speed:shot.speed,tip:shot.tip??{a:0,b:0}});if(opts.onStart)opts.onStart(world);const run=runShot(world,{dt,maxTime,onEvent:opts.onEvent,onStep:opts.onStep});let firstContactId=null;let contactIndex=-1;for(let i=0;i<run.events.length;i++){const e=run.events[i];if(e.type!=='ball')continue;if(e.a===cueId){firstContactId=e.b;contactIndex=i;break;}
if(e.b===cueId){firstContactId=e.a;contactIndex=i;break;}}
const hitBall=firstContactId?copy.find((b)=>b.id===firstContactId)??null:null;const firstContact=hitBall?hitBall.number:null;return{ok:true,
cue,
balls:copy,
events:run.events,
elapsed:run.time,
settled:run.settled,
firstContact,
firstContactId,
contactIndex,
hitNumber:firstContact,
hitBall,};}
