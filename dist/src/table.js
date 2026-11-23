import{TABLE_PRESETS}from'./constants.js';export function createTable(preset='pool9'){const cfg=typeof preset==='string'?TABLE_PRESETS[preset]:preset;if(!cfg)throw new Error(`未知球台预设: ${preset}`);const{length:L,width:W,ballRadius:R,cornerJaw,middleJaw}=cfg;const dims=[
['length',L],
['width',W],
['ballRadius',R],
['cornerJaw',cornerJaw],
['middleJaw',middleJaw],
];for(const[name,v]of dims){if(!Number.isFinite(v)||v<=0){throw new Error(`球台参数非法：${name} 必须是正的有限数（收到 ${String(v)}）`);}}
if(!(cornerJaw>R&&middleJaw>R)){throw new Error('球台参数非法：袋口必须比球大');}
const halfL=L/2;if(!(L>2*R&&W>2*R)){throw new Error(`球台参数非法：台面 ${L}×${W} 装不下直径 ${2 * R} 的球`);}
if(!(cornerJaw<W/2)){throw new Error(
`球台参数非法：cornerJaw ${cornerJaw} 不小于台宽的一半 ${W / 2}，短库边段会反向`
);}
if(!(halfL-middleJaw>cornerJaw)){throw new Error(
`球台参数非法：halfL - middleJaw (${halfL - middleJaw}) 必须大于 cornerJaw (${cornerJaw})，`+
'否则长库左段反向、角袋与中袋捕获圆相交'
);}
if(!(W>2*middleJaw)){throw new Error(
`球台参数非法：middleJaw ${middleJaw} 不小于台宽的一半 ${W / 2}，上下中袋捕获圆相交`
);}
const pockets=[
{id:'c-bl',kind:'corner',x:0,y:0,captureR:cornerJaw,captureRSq:cornerJaw*cornerJaw},
{id:'c-br',kind:'corner',x:L,y:0,captureR:cornerJaw,captureRSq:cornerJaw*cornerJaw},
{id:'c-tl',kind:'corner',x:0,y:W,captureR:cornerJaw,captureRSq:cornerJaw*cornerJaw},
{id:'c-tr',kind:'corner',x:L,y:W,captureR:cornerJaw,captureRSq:cornerJaw*cornerJaw},
{id:'m-b',kind:'middle',x:L/2,y:0,captureR:middleJaw,captureRSq:middleJaw*middleJaw},
{id:'m-t',kind:'middle',x:L/2,y:W,captureR:middleJaw,captureRSq:middleJaw*middleJaw},
];const cushions=[
{id:'rail-b-l',axis:'y',pos:0,from:cornerJaw,to:halfL-middleJaw,normal:{x:0,y:1}},
{id:'rail-b-r',axis:'y',pos:0,from:halfL+middleJaw,to:L-cornerJaw,normal:{x:0,y:1}},
{id:'rail-t-l',axis:'y',pos:W,from:cornerJaw,to:halfL-middleJaw,normal:{x:0,y:-1}},
{id:'rail-t-r',axis:'y',pos:W,from:halfL+middleJaw,to:L-cornerJaw,normal:{x:0,y:-1}},
{id:'rail-l',axis:'x',pos:0,from:cornerJaw,to:W-cornerJaw,normal:{x:1,y:0}},
{id:'rail-r',axis:'x',pos:L,from:cornerJaw,to:W-cornerJaw,normal:{x:-1,y:0}},
];return{preset:cfg.id,
label:cfg.label,
length:L,
width:W,
ballRadius:R,
ballMass:cfg.ballMass,
pockets,
cushions,
bounds:{minX:R,maxX:L-R,minY:R,maxY:W-R},
pocketAt(x,y){for(let i=0;i<pockets.length;i++){const p=pockets[i];const dx=x-p.x;const dy=y-p.y;if(dx>p.captureR||dx<-p.captureR||dy>p.captureR||dy<-p.captureR)continue;if(dx*dx+dy*dy<=p.captureRSq)return p;}
return null;},
insideBounds(x,y,tol=0){return(
x>=R-tol&&x<=L-R+tol&&y>=R-tol&&y<=W-R+tol
);},};}
