import{LM,
LM_NAMES,
vec,
DEG,
angleAt,
angleFromUp,
minVisibility,
frameInset,}from'./landmarks.js';export const THRESHOLDS={stance_width:{good:[1.0,2.2],warn:[0.75,2.7],unit:'×肩宽'},
forearm_vertical:{good:[0,15],warn:[0,30],unit:'°'},
bridge_arm_straight:{good:[152,180],warn:[130,180],unit:'°'},
torso_lean:{good:[38,78],warn:[22,88],unit:'°'},
knee_bend:{good:[142,174],warn:[120,179],unit:'°'},
head_low:{good:[0.02,0.55],warn:[-0.18,0.8],unit:'×躯干长'},
head_over_cue:{good:[0,0.38],warn:[0,0.72],unit:'×肩宽'},
stroke_straight:{goodMax:0.02,warnMax:0.055,unit:'偏差/行程'},
elbow_drop:{goodMax:0.075,warnMax:0.17,unit:'×躯干长'},
head_still:{goodMax:0.14,warnMax:0.3,unit:'×肩宽'},
follow_through:{good:[0.3,1.5],warn:[0.1,2.6],unit:'×击球前行程'},
tempo:{good:[1.3,4.2],warn:[0.85,6.5],unit:'后摆:前摆'},};const VIS_FLOOR=0.55;export function hasUsableWorld(pose){if(!pose||!pose.hasWorld||!pose.world)return false;for(const name of LM_NAMES){if(pose.world[name])return true;}
return false;}
export function missingLandmarks(world,names){const w=world??{};return names.filter((n)=>!w[n]);}
function missingHint(missing){return`缺少关键点 ${missing.join('、')}（模型这次没给出这几个点），这一项测不了。`;}
export const METRIC_NOISE={stance_width:0.223,
forearm_vertical:19.48,
bridge_arm_straight:13.894,
head_low:0.032,
torso_lean:5.179,
knee_bend:10.002,
head_over_cue:0.186,};export function bandWidth(t){if(t.good)return t.good[1]-t.good[0];return t.warnMax-t.goodMax;}
export function noiseRatio(id){const t=THRESHOLDS[id];const n=METRIC_NOISE[id];if(!t||n===undefined)return 0;const w=bandWidth(t);return w>0?n/w:Infinity;}
export function bandScore(value,good,warn){if(!Number.isFinite(value))return null;if(value>=good[0]&&value<=good[1])return 1;if(value<good[0]){const span=good[0]-warn[0];if(span<=1e-9)return value<=warn[0]?0:1;if(value<=warn[0])return 0;return(value-warn[0])/span;}
const span=warn[1]-good[1];if(span<=1e-9)return value>=warn[1]?0:1;if(value>=warn[1])return 0;return(warn[1]-value)/span;}
export function measuredScore(value,id,opts={}){const t=THRESHOLDS[id];const k=opts.k??2;const noise=(METRIC_NOISE[id]??0)*(opts.noiseScale??1);const need=k*noise;const score=t.good
?bandScore(value,t.good,t.warn)
:maxScore(value,t.goodMax,t.warnMax);if(score===null)return{score:null,indeterminate:false,gap:NaN,need};if(score===1)return{score,indeterminate:false,gap:0,need};const gap=t.good
?(value<t.good[0]?t.good[0]-value:value-t.good[1])
:value-t.goodMax;if(gap<need)return{score:null,indeterminate:true,gap,need};return{score,indeterminate:false,gap,need};}
export function applyReliability(checks,noiseScale=1){return checks.map((c)=>{if(c.score===null||c.score===undefined)return c;if(!THRESHOLDS[c.id])return c;const m=measuredScore(c.value,c.id,{noiseScale});if(!m.indeterminate)return{...c,gapToBand:m.gap,deadZone:m.need};return{...c,
score:null,
status:'unknown',
indeterminate:true,
gapToBand:m.gap,
deadZone:m.need,
detail:
`量到 ${formatValue(c)}，离参考区间只差 ${m.gap.toFixed(2)}${c.unit === '°' ? '°' : ''}，`+
`而这一项在单目相机下的实测波动有 ±${(m.need / 2).toFixed(2)}。`+
`差得还没噪声大，这一项不判。`,};});}
function formatValue(c){if(!Number.isFinite(c.value))return'—';const digits=c.unit==='°'?0:2;return`${c.value.toFixed(digits)}${c.unit === '°' ? '°' : ''}`;}
export function maxScore(value,goodMax,warnMax){if(!Number.isFinite(value))return null;if(value<=goodMax)return 1;if(value>=warnMax)return 0;return(warnMax-value)/(warnMax-goodMax);}
export function statusOf(score){if(score===null||score===undefined)return'unknown';if(score>=0.85)return'good';if(score>=0.45)return'warn';return'bad';}
export const FRAME_EDGE_MARGIN=0.005;export function clippedByFrame(pose,names){return frameInset(pose,names)<FRAME_EDGE_MARGIN;}
const CLIPPED_HINT='有肢体被画面裁掉了，模型只能靠外推补坐标，这一项不判。把全身（含双脚）拍进画面再试。';export function horizontalDistanceToLine(p,a,b){const ax=a.x,az=a.z;const bx=b.x-ax,bz=b.z-az;const denom=bx*bx+bz*bz;if(denom<1e-12)return Math.hypot(p.x-ax,p.z-az);let t=((p.x-ax)*bx+(p.z-az)*bz)/denom;t=t<0?0:t>1?1:t;return Math.hypot(p.x-(ax+bx*t),p.z-(az+bz*t));}
export function detectHandedness(pose){const spanL=distOr(pose.left_shoulder,pose.left_wrist);const spanR=distOr(pose.right_shoulder,pose.right_wrist);if(Number.isFinite(spanL)&&Number.isFinite(spanR)&&spanL>1e-6&&spanR>1e-6){const margin=Math.abs(spanL-spanR)/Math.max(spanL,spanR);if(margin>=0.05){const leftIsBridge=spanL>spanR;return{bridge:leftIsBridge?'left':'right',
grip:leftIsBridge?'right':'left',
method:'span',
margin,};}}
const elbowL=angleAt(pose.left_shoulder,pose.left_elbow,pose.left_wrist);const elbowR=angleAt(pose.right_shoulder,pose.right_elbow,pose.right_wrist);if(Number.isFinite(elbowL)&&Number.isFinite(elbowR)&&Math.abs(elbowL-elbowR)>4){const leftIsBridge=elbowL>elbowR;return{bridge:leftIsBridge?'left':'right',
grip:leftIsBridge?'right':'left',
method:'angle',
margin:Math.abs(elbowL-elbowR),};}
return{bridge:'left',grip:'right',method:'default',margin:0};}
function distOr(a,b){if(!a||!b)return NaN;return vec.dist(a,b);}
function midOrNull(a,b){if(!a||!b)return null;return vec.mid(a,b);}
function sideOf(pose,side){return{shoulder:pose[`${side}_shoulder`],
elbow:pose[`${side}_elbow`],
wrist:pose[`${side}_wrist`],
hip:pose[`${side}_hip`],
knee:pose[`${side}_knee`],
ankle:pose[`${side}_ankle`],
heel:pose[`${side}_heel`],
foot:pose[`${side}_foot_index`],};}
function makeResult(id,label,category,opts){const{value,score,unit,detail,confidence,needs,missing}=opts;const result={id,
label,
category,
value:Number.isFinite(value)?value:null,
unit,
score,
status:statusOf(score),
detail,
confidence,
needs,};if(missing&&missing.length)result.missing=[...missing];return result;}
function setupContext(pose,opts={}){const p=pose.world;const shoulderMid=midOrNull(p.left_shoulder,p.right_shoulder);const hipMid=midOrNull(p.left_hip,p.right_hip);const shoulderWidth=distOr(p.left_shoulder,p.right_shoulder);const torsoLen=shoulderMid&&hipMid?vec.dist(shoulderMid,hipMid):NaN;const scaleOk=shoulderWidth>1e-3&&torsoLen>1e-3;const handed=
opts.handedness==='left'||opts.handedness==='right'
?{bridge:opts.handedness==='right'?'left':'right',grip:opts.handedness,method:'manual',margin:0}
:detectHandedness(p);return{p,
image:pose.image,
shoulderMid,
hipMid,
shoulderWidth,
torsoLen,
scaleOk,
handed,
grip:sideOf(p,handed.grip),
bridge:sideOf(p,handed.bridge),};}
function checkStanceWidth(ctx){const{p,image,shoulderWidth,scaleOk}=ctx;const required=['left_foot_index','right_foot_index','left_shoulder','right_shoulder'];const missing=missingLandmarks(p,required);const footGap=missing.length?NaN:vec.dist(p.left_foot_index,p.right_foot_index);const value=scaleOk?footGap/shoulderWidth:NaN;const needs=['left_foot_index','right_foot_index','left_shoulder','right_shoulder'];const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||conf<VIS_FLOOR||clipped
?null
:bandScore(value,THRESHOLDS.stance_width.good,THRESHOLDS.stance_width.warn);return makeResult('stance_width','站姿宽度','setup',{value,score,unit:THRESHOLDS.stance_width.unit,
confidence:conf,
needs:['left_foot_index','right_foot_index'],
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(value)
?'量不到双脚位置，站姿宽度无法判定。'
:clipped
?CLIPPED_HINT
:score===null
?'双脚关键点被遮挡，这次测量不可信。'
:value<THRESHOLDS.stance_width.good[0]
?`双脚间距只有肩宽的 ${value.toFixed(2)} 倍，站位偏窄，侧向稳定性不足。把前脚再往外开一点。`
:value>THRESHOLDS.stance_width.good[1]
?`双脚间距是肩宽的 ${value.toFixed(2)} 倍，站得太开，重心转换会变慢。收一点。`
:`双脚间距是肩宽的 ${value.toFixed(2)} 倍，站姿宽度合适。`,});}
function checkForearmVertical(ctx){const{p,image,handed,grip}=ctx;const required=[`${handed.grip}_elbow`,`${handed.grip}_wrist`,`${handed.grip}_shoulder`];const missing=missingLandmarks(p,required);const value=missing.length?NaN:angleFromUp(vec.sub(grip.wrist,grip.elbow));const tilt=Number.isFinite(value)?Math.abs(180-value):NaN;const needs=[`${handed.grip}_elbow`,`${handed.grip}_wrist`];const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,[...needs,`${handed.grip}_shoulder`]);const ARM_CHAIN_TOL=0.02;const chainOk=
!missing.length&&
Number.isFinite(grip.shoulder?.y)&&
grip.shoulder.y<=grip.elbow.y+ARM_CHAIN_TOL&&
grip.elbow.y<=grip.wrist.y+ARM_CHAIN_TOL;const score=
missing.length||conf<VIS_FLOOR||!chainOk||clipped
?null
:bandScore(tilt,THRESHOLDS.forearm_vertical.good,THRESHOLDS.forearm_vertical.warn);return makeResult('forearm_vertical','后手前臂垂直','setup',{value:chainOk&&!clipped?tilt:NaN,score,unit:THRESHOLDS.forearm_vertical.unit,
confidence:conf,
needs:[`${handed.grip}_shoulder`,`${handed.grip}_elbow`,`${handed.grip}_wrist`],
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(tilt)
?'量不到握杆手的小臂，无法判定前臂是否垂直。'
:clipped
?CLIPPED_HINT
:!chainOk
?'握杆手的肩—肘—腕不在一条自上而下的链上（常见于单目深度误差，或人根本没俯身击球）。这一项这次不判。'
:score===null
?'握杆手被遮挡，这次测量不可信。'
:tilt>THRESHOLDS.forearm_vertical.good[1]
?`前臂偏离竖直 ${tilt.toFixed(0)}°。击球瞬间前臂应接近垂直，否则出杆会画弧、杆头不直。调整握杆手的前后位置。`
:`前臂偏离竖直 ${tilt.toFixed(0)}°，符合钟摆出杆的要求。`,});}
function checkBridgeArmStraight(ctx){const{p,image,handed,bridge}=ctx;const needs=[`${handed.bridge}_shoulder`,`${handed.bridge}_elbow`,`${handed.bridge}_wrist`];const missing=missingLandmarks(p,needs);const value=missing.length?NaN:angleAt(bridge.shoulder,bridge.elbow,bridge.wrist);const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||conf<VIS_FLOOR||clipped
?null
:bandScore(value,THRESHOLDS.bridge_arm_straight.good,THRESHOLDS.bridge_arm_straight.warn);return makeResult('bridge_arm_straight','架桥臂伸展','setup',{value,score,unit:THRESHOLDS.bridge_arm_straight.unit,
confidence:conf,
needs,
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(value)
?'量不到架桥手的手臂，无法判定伸展度。'
:clipped
?CLIPPED_HINT
:score===null
?'架桥手被遮挡，这次测量不可信。'
:value<THRESHOLDS.bridge_arm_straight.good[0]
?`架桥臂肘角只有 ${value.toFixed(0)}°，明显弯着。前臂要尽量伸直，架桥才稳、才够长。`
:`架桥臂肘角 ${value.toFixed(0)}°，伸展充分。`,});}
function checkHeadLow(ctx){const{p,image,shoulderMid,torsoLen,scaleOk}=ctx;const needs=['nose','left_shoulder','right_shoulder'];const required=[...needs,'left_hip','right_hip'];const missing=missingLandmarks(p,required);const drop=missing.length?NaN:(p.nose.y-shoulderMid.y)/torsoLen;const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||!scaleOk||conf<VIS_FLOOR||clipped
?null
:bandScore(drop,THRESHOLDS.head_low.good,THRESHOLDS.head_low.warn);return makeResult('head_low','头部高度','setup',{value:drop,score,unit:THRESHOLDS.head_low.unit,
confidence:conf,
needs,
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(drop)
?'量不到头部与肩的相对位置。'
:clipped
?CLIPPED_HINT
:score===null
?'头部或肩部被遮挡，这次测量不可信。'
:drop<THRESHOLDS.head_low.good[0]
?`头还在肩线上方 ${Math.abs(drop).toFixed(2)} 个躯干长，说明上身没压下去。视线越低越容易看准，试着弯腰或屈膝把下巴降到接近球杆。`
:`头部比肩线低 ${drop.toFixed(2)} 个躯干长，视线高度到位。`,});}
function checkTorsoLean(ctx){const{p,image,shoulderMid,hipMid,scaleOk}=ctx;const needs=['left_shoulder','right_shoulder','left_hip','right_hip'];const missing=missingLandmarks(p,needs);const value=missing.length?NaN:angleFromUp(vec.sub(shoulderMid,hipMid));const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||!scaleOk||conf<VIS_FLOOR||clipped
?null
:bandScore(value,THRESHOLDS.torso_lean.good,THRESHOLDS.torso_lean.warn);return makeResult('torso_lean','躯干前倾','setup',{value,score,unit:THRESHOLDS.torso_lean.unit,
confidence:conf,
needs,
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(value)
?'量不到躯干轴线，无法判定前倾角。'
:clipped
?CLIPPED_HINT
:score===null
?'肩或髋被遮挡，这次测量不可信。'
:value<THRESHOLDS.torso_lean.good[0]
?`躯干只前倾 ${value.toFixed(0)}°，站得太直，眼睛离球太远。上身再压下去一些。`
:value>THRESHOLDS.torso_lean.good[1]
?`躯干前倾 ${value.toFixed(0)}°，压得过低，腰背和脖子会吃力，出杆空间也变小。`
:`躯干前倾 ${value.toFixed(0)}°，重心和视线高度平衡得不错。`,});}
function checkKneeBend(ctx){const{p,image}=ctx;const needs=['left_hip','left_knee','left_ankle','right_hip','right_knee','right_ankle'];const missing=missingLandmarks(p,needs);const kneeL=missing.length?NaN:angleAt(p.left_hip,p.left_knee,p.left_ankle);const kneeR=missing.length?NaN:angleAt(p.right_hip,p.right_knee,p.right_ankle);const value=Number.isFinite(kneeL)&&Number.isFinite(kneeR)
?(kneeL+kneeR)/2
:Number.isFinite(kneeL)?kneeL:kneeR;const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||conf<VIS_FLOOR||clipped
?null
:bandScore(value,THRESHOLDS.knee_bend.good,THRESHOLDS.knee_bend.warn);return makeResult('knee_bend','屈膝程度','setup',{value,score,unit:THRESHOLDS.knee_bend.unit,
confidence:conf,
needs:['left_knee','right_knee','left_ankle','right_ankle'],
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(value)
?'量不到膝关节，无法判定屈膝。'
:clipped
?CLIPPED_HINT
:score===null
?'下肢关键点被遮挡（常见于只拍到上半身的照片），这次测量不可信。'
:value>THRESHOLDS.knee_bend.good[1]
?`膝关节接近伸直（${value.toFixed(0)}°），腿部没有缓冲，重心偏高。轻微屈膝让身体更稳。`
:value<THRESHOLDS.knee_bend.good[0]
?`膝关节只有 ${value.toFixed(0)}°，蹲得太深，重心低但不容易保持稳定。`
:`膝关节 ${value.toFixed(0)}°，屈膝程度合适。`,});}
function checkHeadOverCue(ctx){const{p,image,handed,bridge,grip,shoulderWidth,scaleOk}=ctx;const needs=['nose',`${handed.bridge}_wrist`,`${handed.grip}_wrist`,'left_shoulder','right_shoulder'];const missing=missingLandmarks(p,needs);const value=
scaleOk&&!missing.length
?horizontalDistanceToLine(p.nose,bridge.wrist,grip.wrist)/shoulderWidth
:NaN;const conf=minVisibility(p,needs);const clipped=missing.length?false:clippedByFrame(image,needs);const score=
missing.length||conf<VIS_FLOOR||clipped
?null
:bandScore(value,THRESHOLDS.head_over_cue.good,THRESHOLDS.head_over_cue.warn);return makeResult('head_over_cue','头在球杆上方','setup',{value,score,unit:THRESHOLDS.head_over_cue.unit,
confidence:conf,
needs:['nose',`${handed.bridge}_wrist`,`${handed.grip}_wrist`],
missing,
detail:missing.length
?missingHint(missing)
:!Number.isFinite(value)
?'量不到双手位置，无法判定头是否在球杆上方。'
:clipped
?CLIPPED_HINT
:score===null
?'手部或头部被遮挡，这次测量不可信。'
:value>THRESHOLDS.head_over_cue.good[1]
?`头部偏离球杆 ${value.toFixed(2)} 个肩宽，视线不在杆的正上方，容易看偏。把下巴对到球杆上。`
:`头部偏离球杆 ${value.toFixed(2)} 个肩宽，视线基本压在杆上。`,});}
export function evaluateSetup(pose,opts={}){if(!hasUsableWorld(pose)){return[
makeResult('no_world','姿态坐标','setup',{value:NaN,
score:null,
unit:'',
detail:'没有拿到世界坐标，无法做角度判定。',
confidence:0,
needs:[],}),
];}
const ctx=setupContext(pose,opts);return[
checkStanceWidth(ctx),
checkForearmVertical(ctx),
checkBridgeArmStraight(ctx),
checkHeadLow(ctx),
checkTorsoLean(ctx),
checkKneeBend(ctx),
checkHeadOverCue(ctx),
];}
export{DEG,LM};
