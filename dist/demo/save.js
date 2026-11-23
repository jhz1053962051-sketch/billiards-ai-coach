import{createTable}from'../src/table.js';import{GAME_KINDS}from'../src/rules.js';import{packHistory}from'./state.js';const KEY='pool-ai-coach/game/v1';const MAX_NUMBER=21;function isFiniteNumber(v){return typeof v==='number'&&Number.isFinite(v);}
function readLog(raw){if(!Array.isArray(raw))return[];const out=[];for(const e of raw){if(Array.isArray(e)){out.push({shot:isFiniteNumber(e[0])?e[0]:out.length+1,
shooter:e[1]===1?1:0,
summary:typeof e[2]==='string'?e[2]:'',
fouls:Array.isArray(e[3])?e[3].filter((c)=>typeof c==='string'):[],});}else if(e&&typeof e==='object'){out.push({shot:isFiniteNumber(e.shot)?e.shot:out.length+1,
shooter:e.shooter===1?1:0,
summary:typeof e.summary==='string'?e.summary:'',
fouls:Array.isArray(e.fouls)?e.fouls.filter((c)=>typeof c==='string'):[],});}}
return out;}
function readHistory(raw){if(!raw||typeof raw!=='object')return null;const ids=Array.isArray(raw.b)?raw.b.filter((id)=>typeof id==='string'):null;if(!ids||ids.length===0||!Array.isArray(raw.s))return null;const num=(v,fallback=0)=>(isFiniteNumber(v)?v:fallback);const pair=(v)=>(Array.isArray(v)?[num(v[0]),num(v[1])]:[0,0]);const steps=[];for(const step of raw.s){if(!step||typeof step!=='object'||!Array.isArray(step.x))continue;const x=step.x;if(x.length!==ids.length*3||!x.every(isFiniteNumber))continue;const compact={s:num(step.s),
t:step.t===1?1:0,
k:step.k?1:0,
o:step.o?1:0,
h:num(step.h),
r:step.r?1:0,
e:step.e?1:0,
w:num(step.w,-1),
g:pair(step.g),
f:pair(step.f),
n:pair(step.n),
l:num(step.l),
x:x.slice(),};if(Array.isArray(step.c))compact.c=[num(step.c[0]),num(step.c[1]),num(step.c[2]),num(step.c[3])];steps.push(compact);}
if(steps.length===0)return null;return{b:ids,s:steps,d:isFiniteNumber(raw.d)?Math.max(0,Math.floor(raw.d)):0};}
export function sanitize(raw){if(!raw||typeof raw!=='object')return null;const t=raw.table;if(!t||typeof t.id!=='string')return null;let table;try{table=createTable(t.id);}catch{return null;}
const{minX,maxX,minY,maxY}=table.bounds;if(!Array.isArray(raw.balls)||raw.balls.length<1)return null;const seen=new Set();const balls=[];for(const b of raw.balls){if(!b||typeof b.id!=='string')return null;if(!isFiniteNumber(b.x)||!isFiniteNumber(b.y))return null;if(!isFiniteNumber(b.number)||b.number<0||b.number>MAX_NUMBER)return null;if(!b.pocketed&&(b.x<minX||b.x>maxX||b.y<minY||b.y>maxY))return null;if(b.number!==0){if(seen.has(b.number))return null;seen.add(b.number);}
balls.push({id:b.id,
number:b.number,
x:b.x,
y:b.y,
color:typeof b.color==='string'?b.color:undefined,
stripe:Boolean(b.stripe),
pocketed:Boolean(b.pocketed),
pocket:b.pocketed&&typeof b.pocket==='string'?b.pocket:undefined,});}
if(!balls.some((b)=>b.number===0&&!b.pocketed))return null;const players=Array.isArray(raw.players)&&raw.players.length===2?raw.players:null;if(!players)return null;const kind=raw.kind===undefined?'eightball':GAME_KINDS[raw.kind]?raw.kind:null;if(!kind)return null;const zone=
raw.ballInHand&&
(raw.ballInHand.zone==='kitchen'||
raw.ballInHand.zone==='anywhere'||
raw.ballInHand.zone==='d')
?raw.ballInHand.zone
:null;let snooker=null;if(kind==='snooker'){const s=raw.snooker;const scores=Array.isArray(s?.scores)&&s.scores.length===2?s.scores:null;if(!scores||!scores.every((v)=>isFiniteNumber(v)&&v>=0))return null;const on=s?.ballOn;const ballOn=
on==='red'||on==='color'
?on
:isFiniteNumber(on)&&on>=16&&on<=21
?on
:null;if(ballOn===null)return null;snooker={scores:[Math.floor(scores[0]),Math.floor(scores[1])],
ballOn,
reds:isFiniteNumber(s?.reds)?Math.max(0,Math.floor(s.reds)):0,};}
return{table:{id:t.id},
balls,
kind,
players:players.map((p)=>({name:typeof p?.name==='string'?p.name:'玩家',
group:p?.group==='solid'||p?.group==='stripe'?p.group:null,
fouls:isFiniteNumber(p?.fouls)?Math.max(0,Math.floor(p.fouls)):0,
warned:Boolean(p?.warned),})),
turn:raw.turn===1?1:0,
breakShot:Boolean(raw.breakShot),
open:Boolean(raw.open),
ballInHand:zone?{zone}:null,
requiresRerack:Boolean(raw.requiresRerack),
phase:raw.phase==='ended'?'ended':'playing',
winner:raw.winner===0||raw.winner===1?raw.winner:null,
shots:isFiniteNumber(raw.shots)?Math.max(0,Math.floor(raw.shots)):0,
snooker,
log:readLog(raw.log),
history:readHistory(raw.history),
savedAt:isFiniteNumber(raw.savedAt)?raw.savedAt:0,};}
export function serialize(game,now=Date.now(),history=[]){const log=Array.isArray(game.log)?game.log:[];const packed=packHistory(history);const out={v:SAVE_VERSION,
savedAt:now,
table:{id:game.table.preset},
balls:game.balls.map((b)=>({id:b.id,
number:b.number,
x:b.x,
y:b.y,
color:b.color,
stripe:b.stripe,
pocketed:b.pocketed,
pocket:b.pocket,})),
players:game.players.map((p)=>({name:p.name,
group:p.group,
fouls:p.fouls,
warned:p.warned,})),
kind:game.kind??'eightball',
turn:game.turn,
breakShot:game.breakShot,
open:game.open,
ballInHand:game.ballInHand?{zone:game.ballInHand.zone}:null,
requiresRerack:game.requiresRerack,
phase:game.phase,
winner:game.winner,
shots:game.shots,
snooker:game.snooker
?{scores:game.snooker.scores.slice(),ballOn:game.snooker.ballOn,reds:game.snooker.reds}
:null,};if(log.length>0)out.log=log.map((e)=>[e.shot,e.shooter,e.summary,e.fouls??[]]);if(packed.s.length>0)out.history=packed;return out;}
function defaultStore(){try{if(typeof localStorage!=='undefined')return localStorage;}catch{}
return null;}
export function writeSave(
game,
store=defaultStore(),
{now=Date.now(),history=[],session=null}={}){if(!store)return false;try{const payload=serialize(game,now,history);if(typeof session==='string'&&session)payload.session=session;store.setItem(KEY,JSON.stringify(payload));return true;}catch{return false;}}
export function saveFailureKind(store=defaultStore()){if(!store)return'blocked';try{store.getItem(KEY);}catch{return'blocked';}
return'quota';}
export function readSaveMeta(store=defaultStore()){if(!store)return null;let text=null;try{text=store.getItem(KEY);}catch{return null;}
if(!text)return null;try{const raw=JSON.parse(text);return{stamp:typeof raw?.savedAt==='number'&&Number.isFinite(raw.savedAt)?raw.savedAt:0,
session:typeof raw?.session==='string'&&raw.session?raw.session:null,};}catch{return null;}}
export function readSaveStamp(store=defaultStore()){const meta=readSaveMeta(store);return meta?meta.stamp:null;}
export const SAVE_VERSION=2;function inspectSave(store){if(!store)return{status:'unavailable',saved:null};let text=null;try{text=store.getItem(KEY);}catch{return{status:'unavailable',saved:null};}
if(!text)return{status:'empty',saved:null};let raw=null;try{raw=JSON.parse(text);}catch{return{status:'corrupt',saved:null};}
if(raw&&typeof raw==='object'&&isFiniteNumber(raw.v)&&raw.v>SAVE_VERSION){return{status:'newer',saved:null};}
const saved=sanitize(raw);return saved?{status:'ok',saved}:{status:'corrupt',saved:null};}
export function loadSave(store=defaultStore()){const{status,saved}=inspectSave(store);if(status!=='corrupt')return{status,saved,discarded:false};let discarded=false;try{store.removeItem(KEY);discarded=true;}catch{discarded=false;}
return{status,saved:null,discarded};}
export function readSave(store=defaultStore()){return inspectSave(store).saved;}
export function clearSave(store=defaultStore()){if(!store)return false;try{store.removeItem(KEY);return true;}catch{return false;}}
export function describeSave(store=defaultStore()){const saved=readSave(store);if(!saved)return null;const onTable=saved.balls.filter((b)=>!b.pocketed&&b.number!==0).length;return{shots:saved.shots,
onTable,
tableId:saved.table.id,
turn:saved.turn,
ended:saved.phase==='ended',};}
export const SAVE_KEY=KEY;export const MATCH_KEY='dsh-billiards-matches';export const MATCH_VERSION=1;export const MATCH_LIMIT=50;function sanitizeMatch(raw){if(!raw||typeof raw!=='object')return null;const kind=typeof raw.kind==='string'&&GAME_KINDS[raw.kind]?raw.kind:null;if(!kind)return null;const result=
raw.result==='win'||raw.result==='loss'||raw.result==='undecided'
?raw.result
:'undecided';const count=(v)=>(isFiniteNumber(v)&&v>0?Math.min(1e6,Math.floor(v)):0);return{ts:isFiniteNumber(raw.ts)&&raw.ts>0?raw.ts:0,
kind,
result,
shots:count(raw.shots),
potRate:isFiniteNumber(raw.potRate)?Math.min(1,Math.max(0,raw.potRate)):null,
longestRun:count(raw.longestRun),
fouls:count(raw.fouls),};}
function dropMatches(store){try{store.removeItem(MATCH_KEY);return true;}catch{return false;}}
export function readMatches(store=defaultStore()){if(!store)return[];let text=null;try{text=store.getItem(MATCH_KEY);}catch{return[];}
if(!text)return[];let raw=null;try{raw=JSON.parse(text);}catch{dropMatches(store);return[];}
const newer=raw&&typeof raw==='object'&&!Array.isArray(raw)&&isFiniteNumber(raw.v)&&raw.v>MATCH_VERSION;const items=Array.isArray(raw)?raw:Array.isArray(raw?.items)?raw.items:null;if(!items){if(!newer)dropMatches(store);return[];}
const out=[];for(const one of items){const clean=sanitizeMatch(one);if(clean)out.push(clean);}
return out.slice(-MATCH_LIMIT);}
export function appendMatch(entry,store=defaultStore(),{now=Date.now()}={}){const src=entry&&typeof entry==='object'?entry:{};const clean=sanitizeMatch({...src,
ts:isFiniteNumber(src.ts)&&src.ts>0?src.ts:now,});const kept=readMatches(store);if(!clean)return{ok:false,matches:kept};kept.push(clean);const trimmed=kept.slice(-MATCH_LIMIT);if(!store)return{ok:false,matches:trimmed};try{store.setItem(MATCH_KEY,JSON.stringify({v:MATCH_VERSION,items:trimmed}));return{ok:true,matches:trimmed};}catch{return{ok:false,matches:trimmed};}}
export function clearMatches(store=defaultStore()){if(!store)return false;return dropMatches(store);}
