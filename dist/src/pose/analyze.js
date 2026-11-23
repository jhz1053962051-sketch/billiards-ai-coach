import{vec,straightnessError,normalizePose}from'./landmarks.js';import{THRESHOLDS,
bandScore,
maxScore,
statusOf,
evaluateSetup,
detectHandedness,
applyReliability,
METRIC_NOISE,
noiseRatio,}from'./checks.js';import{compareAll,describeSummary,REFERENCE_NOTE,REFERENCE_DISCLAIMER}from'./reference.js';export const WEIGHTS={head_over_cue:3.0,
forearm_vertical:3.0,
stroke_straight:4.0,
head_still:2.0,
follow_through:2.0,
head_low:2.0,
bridge_arm_straight:1.5,
stance_width:1.5,
elbow_drop:1.5,
torso_lean:1.0,
knee_bend:1.0,
tempo:1.0,};const STROKE_LABELS={stroke_straight:'出杆直线度',
elbow_drop:'掉肘',
head_still:'头身稳定性',
follow_through:'送杆长度',
tempo:'出杆节奏',};function gripPath(frames,side){const pts=[];for(let i=0;i<frames.length;i++){const w=frames[i].pose.world?.[`${side}_wrist`];if(!w){pts.push(null);continue;}
pts.push({i,t:frames[i].t,x:w.x,y:w.y,z:w.z});}
return pts;}
function denseRuns(path){const runs=[];let cur=[];for(const p of path){if(p)cur.push(p);else{if(cur.length>=3)runs.push(cur);cur=[];}}
if(cur.length>=3)runs.push(cur);return runs;}
const MIN_STROKE_SPEED=0.05;export function segmentStroke(run){if(!run||run.length<5)return null;const speeds=[];const steps=[];for(let k=1;k<run.length;k++){const d=vec.dist(run[k],run[k-1]);const dt=Math.max(1e-6,run[k].t-run[k-1].t);speeds.push(d/dt);steps.push(d);}
if(!speeds.length)return null;let peak=0;for(let k=1;k<speeds.length;k++)if(speeds[k]>speeds[peak])peak=k;const sorted=[...speeds].sort((a,b)=>a-b);const medianSpeed=sorted[Math.floor(sorted.length/2)]||0;if(speeds[peak]<MIN_STROKE_SPEED||speeds[peak]<medianSpeed*2.2)return null;const iContact=peak+1;const forward=vec.norm(vec.sub(run[iContact],run[iContact-1]));if(vec.len(forward)<0.5)return null;const proj=(k)=>vec.dot(vec.sub(run[k],run[k-1]),forward);const sortedSteps=[...steps].sort((a,b)=>a-b);const medianStep=sortedSteps[Math.floor(sortedSteps.length/2)]||0;const thresh=Math.max(1e-6,medianStep*0.35);let iFwdStart=iContact-1;while(iFwdStart>0&&proj(iFwdStart)>thresh)iFwdStart--;let iFwdEnd=iContact;while(iFwdEnd<run.length-1&&proj(iFwdEnd+1)>thresh)iFwdEnd++;let iBackStart=iFwdStart;while(iBackStart>0&&proj(iBackStart)<-thresh)iBackStart--;if(iContact-iFwdStart<2)return null;return{run,iBackStart,iFwdStart,iContact,iFwdEnd,forward,medianSpeed,medianStep};}
export function evaluateStroke(frames,opts={}){const checks=[];const unknown=(id,detail,needs)=>({id,
label:STROKE_LABELS[id],
category:'stroke',
value:null,
unit:THRESHOLDS[id]?.unit??'',
score:null,
status:'unknown',
detail,
confidence:0,
needs:needs??[],});if(!frames||frames.length<6){return{checks:[
unknown('stroke_straight','序列太短（少于 6 帧），无法分析出杆。至少需要覆盖完整的一杆。'),
],
segmented:false,
reason:'too_short',};}
const handed=
opts.handedness==='left'||opts.handedness==='right'
?{bridge:opts.handedness==='right'?'left':'right',grip:opts.handedness}
:detectHandedness(frames[0].pose.world??{});const path=gripPath(frames,handed.grip);const runs=denseRuns(path);if(!runs.length){return{checks:[unknown('stroke_straight','整段视频里握杆手都被遮挡或检测不到，无法分析出杆。')],
segmented:false,
reason:'no_grip_track',};}
const run=runs.reduce((a,b)=>(b.length>a.length?b:a));const seg=segmentStroke(run);if(!seg){return{checks:[
unknown(
'stroke_straight',
'没能在握杆手轨迹里识别出一次明显的出杆（速度没有形成「后摆—加速前摆」的形态）。请拍完整的一杆，或让手保持在画面内。'
),
],
segmented:false,
reason:'no_stroke',};}
const{iBackStart,iFwdStart,iContact,iFwdEnd}=seg;const torsoLen=torsoLengthOf(frames[Math.floor((iFwdStart+iFwdEnd)/2)].pose.world);const shoulderW=shoulderWidthOf(frames[Math.floor((iFwdStart+iFwdEnd)/2)].pose.world);{const pts=run.slice(iFwdStart,iContact+1);const value=straightnessError(pts);const score=maxScore(value,THRESHOLDS.stroke_straight.goodMax,THRESHOLDS.stroke_straight.warnMax);checks.push({id:'stroke_straight',
label:STROKE_LABELS.stroke_straight,
category:'stroke',
value:Number.isFinite(value)?value:null,
unit:THRESHOLDS.stroke_straight.unit,
score,
status:statusOf(score),
confidence:Math.min(1,pts.length/12),
needs:[`${handed.grip}_wrist`],
detail:!Number.isFinite(value)
?'前摆轨迹点太少，量不出直线度。'
:value>THRESHOLDS.stroke_straight.goodMax
?`握杆手前摆偏离直线 ${(value * 100).toFixed(1)}%（行程的百分比）。出杆不直，杆头到击球点会有横向偏移——这是最常见也最影响准度的问题。慢速空杆练习，让手沿一条直线走。`
:`前摆偏离直线 ${(value * 100).toFixed(1)}%，出杆很直。`,});}
{const elbowA=frames[run[iFwdStart].i]?.pose.world?.[`${handed.grip}_elbow`];const elbowB=frames[run[iContact].i]?.pose.world?.[`${handed.grip}_elbow`];const drop=elbowA&&elbowB&&torsoLen>1e-3?(elbowB.y-elbowA.y)/torsoLen:NaN;const value=Number.isFinite(drop)?Math.max(0,drop):NaN;const score=maxScore(value,THRESHOLDS.elbow_drop.goodMax,THRESHOLDS.elbow_drop.warnMax);const conf=elbowA&&elbowB?0.8:0;checks.push({id:'elbow_drop',
label:STROKE_LABELS.elbow_drop,
category:'stroke',
value:Number.isFinite(value)?value:null,
unit:THRESHOLDS.elbow_drop.unit,
score,
status:statusOf(score),
confidence:conf,
needs:[`${handed.grip}_elbow`],
detail:!Number.isFinite(value)
?'量不到肘部轨迹，无法判断是否掉肘。'
:value>THRESHOLDS.elbow_drop.goodMax
?`前摆期间肘部下沉了 ${(value * 100).toFixed(0)}% 躯干长。掉肘会让杆头在击球瞬间上抬，是打厚/打薄的主要来源。保持上臂不动，只让前臂做钟摆。`
:`前摆期间肘部只下沉 ${(value * 100).toFixed(0)}% 躯干长，是干净的钟摆出杆。`,});}
{const a=frames[run[iBackStart].i]?.pose.world?.nose;const b=frames[run[iFwdEnd].i]?.pose.world?.nose;const value=a&&b&&shoulderW>1e-3?vec.dist(a,b)/shoulderW:NaN;const score=maxScore(value,THRESHOLDS.head_still.goodMax,THRESHOLDS.head_still.warnMax);checks.push({id:'head_still',
label:STROKE_LABELS.head_still,
category:'stroke',
value:Number.isFinite(value)?value:null,
unit:THRESHOLDS.head_still.unit,
score,
status:statusOf(score),
confidence:a&&b?0.85:0,
needs:['nose'],
detail:!Number.isFinite(value)
?'量不到头部轨迹，无法判断稳定性。'
:value>THRESHOLDS.head_still.goodMax
?`出杆过程中头部移动了 ${(value * 100).toFixed(0)}% 肩宽。头一动，视线基准就变了，瞄准再准也没用。出杆后保持趴住不动，直到球落袋。`
:`出杆过程中头部只移动 ${(value * 100).toFixed(0)}% 肩宽，稳定性好。`,});}
{const preLen=pathLength(run.slice(iFwdStart,iContact+1));const afterLen=pathLength(run.slice(iContact,iFwdEnd+1));const value=preLen>1e-4?afterLen/preLen:NaN;const score=bandScore(value,THRESHOLDS.follow_through.good,THRESHOLDS.follow_through.warn);checks.push({id:'follow_through',
label:STROKE_LABELS.follow_through,
category:'stroke',
value:Number.isFinite(value)?value:null,
unit:THRESHOLDS.follow_through.unit,
score,
status:statusOf(score),
confidence:Number.isFinite(value)?0.7:0,
needs:[`${handed.grip}_wrist`],
detail:!Number.isFinite(value)
?'前摆行程太短，量不出送杆比例。'
:value<THRESHOLDS.follow_through.good[0]
?`触球后手只继续走了击球前行程的 ${value.toFixed(2)} 倍。送杆不足通常意味着在触球瞬间就「掐住」了，杆速会掉。把动作做完，让杆头自然穿过球位。`
:value>THRESHOLDS.follow_through.good[1]
?`送杆是击球前行程的 ${value.toFixed(2)} 倍，偏长，可能在后段加了力。`
:`送杆是击球前行程的 ${value.toFixed(2)} 倍，动作完整。`,});}
{const backT=Math.max(1e-6,run[iFwdStart].t-run[iBackStart].t);const fwdT=Math.max(1e-6,run[iContact].t-run[iFwdStart].t);const value=backT/fwdT;const score=bandScore(value,THRESHOLDS.tempo.good,THRESHOLDS.tempo.warn);checks.push({id:'tempo',
label:STROKE_LABELS.tempo,
category:'stroke',
value:Number.isFinite(value)?value:null,
unit:THRESHOLDS.tempo.unit,
score,
status:statusOf(score),
confidence:0.6,
needs:[],
detail:!Number.isFinite(value)
?'量不出前后摆时长。'
:value<THRESHOLDS.tempo.good[0]
?`后摆只用了前摆的 ${value.toFixed(2)} 倍时间，后摆太急。慢速后摆、平滑过渡，是稳定出杆的前提。`
:value>THRESHOLDS.tempo.good[1]
?`后摆用了前摆的 ${value.toFixed(2)} 倍时间，后摆偏慢、节奏拖沓，容易在停顿里跑神。`
:`后摆是前摆的 ${value.toFixed(2)} 倍时长，节奏合理。`,});}
return{checks,segmented:true,handedness:handed,iBackStart,iContact};}
function pathLength(pts){let s=0;for(let i=1;i<pts.length;i++)s+=vec.dist(pts[i],pts[i-1]);return s;}
function torsoLengthOf(w){if(!w?.left_shoulder||!w?.left_hip)return NaN;return vec.dist(vec.mid(w.left_shoulder,w.right_shoulder),vec.mid(w.left_hip,w.right_hip));}
function shoulderWidthOf(w){if(!w?.left_shoulder||!w?.right_shoulder)return NaN;return vec.dist(w.left_shoulder,w.right_shoulder);}
function buildComparison(setup){const{items,summary}=compareAll(setup);return{note:REFERENCE_NOTE,
disclaimer:REFERENCE_DISCLAIMER,
items,
summary,
verdict:describeSummary(summary),};}
export function summarize({setup,stroke=[],mode,frameCount=1,averagedFrames=0}){const all=[...setup,...stroke];let num=0;let den=0;let totalWeight=0;for(const c of all){const w=WEIGHTS[c.id];if(!w)continue;totalWeight+=w;if(c.score===null||c.score===undefined)continue;num+=w*c.score;den+=w;}
const coverage=totalWeight>0?den/totalWeight:0;const enough=coverage>=0.45;const score=enough&&den>0?Math.round((num/den)*100):null;const measured=all.filter((c)=>c.score!==null);const confidence=measured.length
?measured.reduce((s,c)=>s+(c.confidence??0),0)/measured.length
:0;const issues=all
.filter((c)=>c.status==='bad'||c.status==='warn')
.map((c)=>({...c,
severity:c.status==='bad'?2:1,
weight:WEIGHTS[c.id]??1,}))
.sort((a,b)=>b.severity*b.weight-a.severity*a.weight);return{mode,
frameCount,
score,
grade:gradeOf(score,coverage),
coverage:Math.round(coverage*100)/100,
enough,
confidence:Math.round(confidence*100)/100,
averagedFrames,
weakMetrics:Object.keys(METRIC_NOISE).filter((id)=>noiseRatio(id)>0.5),
setup,
stroke,
checks:all,
issues,
unknown:all.filter((c)=>c.status==='unknown'),
comparison:buildComparison(setup),};}
export function gradeOf(score,coverage=1){if(score===null||score===undefined)return'无法评估';const partial=coverage<0.7;if(score>=88)return partial?'测到的部分很规范':'很规范';if(score>=74)return partial?'测到的部分基本规范':'基本规范';if(score>=58)return'有明显问题';return'需要从头改动作';}
export function averagePoses(poses){const usable=poses.filter((p)=>p&&p.hasWorld&&p.world&&Object.keys(p.world).length);if(!usable.length)return{pose:poses[0],n:0};const out={};const first=usable[0].world;for(const name of Object.keys(first)){let sx=0,sy=0,sz=0,sv=0,cnt=0;for(const p of usable){const q=p.world[name];if(!q)continue;sx+=q.x;sy+=q.y;sz+=q.z;sv+=q.visibility??0;cnt++;}
if(!cnt)continue;out[name]={x:sx/cnt,
y:sy/cnt,
z:sz/cnt,
visibility:sv/cnt,
presence:first[name].presence??0,};}
return{pose:{image:usable[0].image,world:out,hasWorld:true},n:usable.length};}
export function analyzeImage(poseResult,opts={}){const pose=(opts.normalize??normalizePose)(poseResult);const setup=applyReliability(evaluateSetup(pose,{handedness:opts.handedness}),1);return summarize({setup,mode:'image',frameCount:1});}
export function analyzeSequence(rawFrames,opts={}){const norm=opts.normalize??normalizePose;const frames=rawFrames.map((f)=>({t:f.t,pose:norm(f.poseResult)}));const stroke=evaluateStroke(frames,{handedness:opts.handedness});let window=frames;if(stroke.segmented&&stroke.iBackStart!==undefined){window=frames.slice(0,Math.max(1,stroke.iBackStart));}
if(window.length>12){const step=window.length/12;window=Array.from({length:12},(_,i)=>window[Math.floor(i*step)]);}
const avg=averagePoses(window.map((f)=>f.pose));const noiseScale=avg.n>1?1/Math.sqrt(avg.n):1;const setup=applyReliability(
evaluateSetup(avg.pose,{handedness:opts.handedness}),
noiseScale
);return summarize({setup,
stroke:stroke.checks,
mode:'video',
frameCount:frames.length,
averagedFrames:avg.n,});}
