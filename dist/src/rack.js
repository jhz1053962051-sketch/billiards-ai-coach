import{SNOOKER_SPOTS}from'./constants.js';const COLORS={1:'#f2c230',
2:'#1f4fd8',
3:'#d62b2b',
4:'#7b2fa8',
5:'#f07a1a',
6:'#1a8a44',
7:'#8e2323',
8:'#16181c',};export const CUE_NUMBER=0;export function ballStyle(number){if(number===0)return{number:0,color:'#f6f2e8',stripe:false,group:'cue'};if(number===8)return{number:8,color:COLORS[8],stripe:false,group:'eight'};const base=number>8?number-8:number;return{number,
color:COLORS[base]??'#8a8f98',
stripe:number>8,
group:number>8?'stripe':'solid',};}
export function groupOf(number){return ballStyle(number).group;}
export const RACK_NUMBERS=Array.from({length:15},(_,i)=>i+1);export const RACK_PATTERN=Object.freeze([
'S','S','T','T','8','S','S','S','T','T','S','T','T','S','T',
]);const SLOT_ROWS=(()=>{const out=[];for(let row=0;row<5;row++)for(let j=0;j<=row;j++)out.push({row,j});return out;})();export const RACK_ADJACENCY=(()=>{const at=new Map(SLOT_ROWS.map((p,i)=>[p.row+':'+p.j,i]));const pairs=[];for(let i=0;i<SLOT_ROWS.length;i++){const{row,j}=SLOT_ROWS[i];for(const[dr,dj]of[[0,1],[1,0],[1,1]]){const k=at.get(row+dr+':'+(j+dj));if(k!==undefined)pairs.push([i,k]);}}
return pairs;})();export function sameGroupEdges(groups){let n=0;for(const[i,j]of RACK_ADJACENCY)if(groups[i]===groups[j])n++;return n;}
function mulberry32(seed){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function shuffle(arr,rand){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
return a;}
export function rackLayout(table,numbers=RACK_NUMBERS,opts={}){const R=table.ballRadius;const rand=mulberry32(opts.seed??1);const footX=opts.footX??table.length*0.75;const cy=table.width/2;const rowGap=Math.sqrt(3)*R;const slots=[];for(let row=0;row<5;row++){for(let j=0;j<=row;j++){slots.push({x:footX+row*rowGap,y:cy+(j-row/2)*2*R});}}
let order;if(numbers.length===15){const solids=shuffle(
numbers.filter((n)=>n>=1&&n<=7),
rand
);const stripes=shuffle(
numbers.filter((n)=>n>=9&&n<=15),
rand
);const eight=numbers.find((n)=>n===8);const oneAt=solids.indexOf(1);if(oneAt>0){solids.splice(oneAt,1);solids.unshift(1);}
const mirror=rand()<0.5;const pattern=mirror
?RACK_PATTERN.map((_,i)=>{const{row,j}=SLOT_ROWS[i];return RACK_PATTERN[SLOT_ROWS.findIndex((p)=>p.row===row&&p.j===row-j)];})
:RACK_PATTERN;let si=0;let ti=0;order=pattern.map((g)=>{if(g==='8')return eight;if(g==='S')return solids[si++];return stripes[ti++];});}else{order=shuffle(numbers,rand);}
return order.slice(0,slots.length).map((number,i)=>({number,
x:slots[i].x,
y:slots[i].y,}));}
export function createStandardRack(table,opts={}){const layout=rackLayout(table,RACK_NUMBERS,opts);const balls=layout.map((p)=>{const s=ballStyle(p.number);return{id:'b'+p.number,number:p.number,x:p.x,y:p.y,color:s.color,stripe:s.stripe};});balls.unshift({id:'cue',
number:0,
x:table.length*0.24,
y:table.width/2,
color:ballStyle(0).color,
stripe:false,});return balls;}
export const NINE_NUMBERS=Array.from({length:9},(_,i)=>i+1);export const NINE_SLOT_ROWS=Object.freeze([
{row:0,j:0},
{row:1,j:0},{row:1,j:1},
{row:2,j:0},{row:2,j:1},{row:2,j:2},
{row:3,j:0},{row:3,j:1},
{row:4,j:0},
]);export const NINE_ADJACENCY=(()=>{const countOf=(row)=>(row<=2?row+1:4-row+1);const yIdx=NINE_SLOT_ROWS.map((p)=>p.j-(countOf(p.row)-1)/2);const pairs=[];for(let i=0;i<NINE_SLOT_ROWS.length;i++){for(let k=i+1;k<NINE_SLOT_ROWS.length;k++){if(Math.abs(NINE_SLOT_ROWS[i].row-NINE_SLOT_ROWS[k].row)!==1)continue;if(Math.abs(Math.abs(yIdx[i]-yIdx[k])-0.5)<1e-9)pairs.push([i,k]);}}
return pairs;})();export function nineBallSlots(table,opts={}){const R=table.ballRadius;const footX=opts.footX??table.length*0.75;const cy=table.width/2;const rowGap=Math.sqrt(3)*R;const countOf=(row)=>(row<=2?row+1:4-row+1);const apexX=footX-2*rowGap;const slots=[];for(let row=0;row<5;row++){const n=countOf(row);for(let j=0;j<n;j++){slots.push({x:apexX+row*rowGap,y:cy+(j-(n-1)/2)*2*R});}}
return slots;}
export function rackDiamondLayout(table,numbers=NINE_NUMBERS,opts={}){const rand=mulberry32(opts.seed??1);const slots=nineBallSlots(table,opts);let order;if(numbers.length===9&&numbers.includes(1)&&numbers.includes(9)){const rest=shuffle(numbers.filter((n)=>n!==1&&n!==9),rand);const CENTER_SLOT=4;order=[];let k=0;for(let i=0;i<slots.length;i++){if(i===0)order.push(1);else if(i===CENTER_SLOT)order.push(9);else order.push(rest[k++]);}}else{order=shuffle(numbers,rand);}
return order.slice(0,slots.length).map((number,i)=>({number,x:slots[i].x,y:slots[i].y}));}
export function createNineBallRack(table,opts={}){const layout=rackDiamondLayout(table,NINE_NUMBERS,opts);const balls=layout.map((p)=>{const s=ballStyle(p.number);return{id:'b'+p.number,number:p.number,x:p.x,y:p.y,color:s.color,stripe:s.stripe};});balls.unshift({id:'cue',
number:0,
x:table.length*0.24,
y:table.width/2,
color:ballStyle(0).color,
stripe:false,});return balls;}
export const GAME_KINDS=Object.freeze({eightball:{id:'eightball',label:'黑八',balls:15},
nineball:{id:'nineball',label:'九球',balls:9},
snooker:{id:'snooker',label:'斯诺克',balls:21},});export const SNOOKER_COLORS=Object.freeze({16:{hex:'#e8c227',cn:'黄球'},
17:{hex:'#127a3f',cn:'绿球'},
18:{hex:'#7a4a21',cn:'咖啡球'},
19:{hex:'#1f4fd8',cn:'蓝球'},
20:{hex:'#e87ba0',cn:'粉球'},
21:{hex:'#16181c',cn:'黑球'},});export const SNOOKER_RED_HEX='#c8281f';export function createSnookerRack(table,opts={}){const R=table.ballRadius;const L=table.length;const W=table.width;const cy=W/2;const baulkX=SNOOKER_SPOTS.baulkX;const dRadius=SNOOKER_SPOTS.dRadius;const pinkX=(L/2+L)/2;const rand=mulberry32(opts.seed??1);const order=shuffle(
Array.from({length:15},(_,i)=>i+1),
rand
);const balls=[];const apexX=pinkX+2*R+0.003;const rowGap=Math.sqrt(3)*R;let k=0;for(let row=0;row<5;row++){for(let j=0;j<=row;j++){const number=order[k++];balls.push({id:'b'+number,
number,
x:apexX+row*rowGap,
y:cy+(j-row/2)*2*R,
color:SNOOKER_RED_HEX,
stripe:false,});}}
const colors=[
[16,baulkX,cy-dRadius],
[17,baulkX,cy+dRadius],
[18,baulkX,cy],
[19,L/2,cy],
[20,pinkX,cy],
[21,L-SNOOKER_SPOTS.blackFromTop,cy],
];for(const[number,x,y]of colors){balls.push({id:'b'+number,
number,
x,
y,
color:SNOOKER_COLORS[number].hex,
stripe:false,});}
balls.unshift({id:'cue',
number:0,
x:baulkX-0.1,
y:cy,
color:ballStyle(0).color,
stripe:false,});return balls;}
export function createRack(kind,table,opts={}){const id=kind===undefined?'eightball':kind;if(!GAME_KINDS[id]){throw new Error(`不认识的玩法：${String(kind)}（支持 ${Object.keys(GAME_KINDS).join(' / ')}）`);}
return id==='nineball'
?createNineBallRack(table,opts)
:id==='snooker'
?createSnookerRack(table,opts)
:createStandardRack(table,opts);}
export function findFreeSpot(table,balls,R,from=null,accept=null){const start=from??{x:table.length*0.5,y:table.width*0.5};const minX=table.bounds.minX;const maxX=table.bounds.maxX;const minY=table.bounds.minY;const maxY=table.bounds.maxY;const clear=(x,y)=>
x>=minX&&x<=maxX&&y>=minY&&y<=maxY&&
(accept===null||accept(x,y))&&
!balls.some((b)=>!b.pocketed&&Math.hypot(b.x-x,b.y-y)<2*R+1e-4);if(clear(start.x,start.y))return{x:start.x,y:start.y};const step=R*0.7;for(let ring=1;ring<=40;ring++){const radius=ring*step;const samples=Math.max(8,Math.round(radius/step)*6);for(let i=0;i<samples;i++){const a=(i/samples)*Math.PI*2;const x=start.x+Math.cos(a)*radius;const y=start.y+Math.sin(a)*radius;if(clear(x,y))return{x,y};}}
return null;}
