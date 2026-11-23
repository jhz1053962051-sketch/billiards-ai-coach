import{THRESHOLDS}from'./checks.js';export const REFERENCE_NOTE='参考区间（教练经验值）';export const REFERENCE_DISCLAIMER=
'这些区间来自公开教练检查表的条目和生物力学推理，再加上明确的工程余量，'+
'没有用选手录像做过统计标定。落在区间外只表示「和通行做法不一样」，'+
'不等于这一杆一定打不进；它给的是方向和优先级，不是判决。';const BASIS={stance_width:
'双脚的横向间距决定侧向支撑面有多宽：上身俯到击球高度后，重力线要从髋落进两脚之间的支撑面里，'+
'站距越窄这个面越接近一条线，出杆时身体前后左右的晃动就没有落脚点。用肩宽做分母，是因为它随身高和机位缩放，'+
'比绝对厘米数稳定。下限 1.0 对应公开教练检查表里「双脚至少与肩同宽」这条通行要求；上限 2.2 是工程余量——'+
'再开下去两腿几乎横分，重心横向转移变慢，前脚还容易挡住出杆通道。',
forearm_vertical:
'钟摆出杆时握杆手的小臂绕肘做单摆。击球瞬间小臂越接近竖直，腕部的速度方向就越接近水平（也就是沿瞄准线）：'+
'小臂与竖直成 θ 角时，腕速里垂直于瞄准线的分量约为 sinθ，15° 就已经有约 26% 的速度走在上下方向，'+
'杆头会在击球段上下漂。所以上限取 15°，而不是「越直越好」——人手不可能绝对竖直，得留余量。'+
'这个角由肩—肘—腕三点直接算出，是几何量，不是拟合参数。',
bridge_arm_straight:
'架桥臂伸直（肘角接近 180°）时肩到腕的跨度最大，人能在离球足够远的位置趴下来，架桥高度由前臂和手腕的骨性结构承担；'+
'肘一弯，手就得靠肌肉悬着，出杆一发力就会被压塌，杆头跟着上下走。152° 相当于允许 28° 的自然放松（180−152），'+
'再弯下去就从「骨架架着」变成「肌肉架着」了。教练检查表把手臂伸直列在 hand bridge 条目下。',
head_low:
'视线越低，眼睛离球杆越近，看到的球、杆、目标三点越接近同一条线，视差越小；站直时眼睛比球杆高出一整个躯干长，'+
'那时靠的是估而不是看。分母取躯干长是为了随身高缩放。0.02 表示头基本压到肩线高度——不压下去就还是站着看球；'+
'0.55 是上限：再低就得靠低头而不是靠屈髋把视线降下来，脖子和腰会先累。',
torso_lean:
'上身越趴，肩（握杆手摆动的悬挂点）就越接近球杆所在的水平面，钟摆的摆动方向才接近水平——'+
'这是「出杆沿瞄准线」的几何前提。38° 是「明显俯身」的下限，小于它基本还在站着打；78° 接近水平，'+
'再往前重心会越过前脚、腰背要额外吃力。区间端点就是「肩—髋连线与竖直方向的夹角」，不含拟合参数。',
knee_bend:
'屈膝有两个作用：把重心降下来让髋低于肩线，上身才能在不塌腰的前提下趴平；以及给腿一个缓冲，出杆时身体不前后晃。'+
'142°–174° 相当于膝弯 6°–38°：接近伸直（>174°）时腿没有缓冲、重心偏高，上身只能靠腰背去压；'+
'蹲太深（<142°）时大腿前侧持续发力，几十秒的准备过程里腿会开始抖。膝角由髋—膝—踝三点算出。',
head_over_cue:
'主视眼压在球杆正上方时，球杆在视野里和球的一条线重合，不需要靠经验补角度；头一偏，近端（架桥手）和远端（目标球）'+
'之间就有视差，偏得越多越靠估。这里量的是鼻到「架桥腕—握杆腕」连线的水平距离（去掉竖直分量，否则头比杆高 20 cm '+
'会被算成 20 cm 偏差），再除以肩宽做尺度归一。0.38 个肩宽在成人身上约 15 cm，已经是明显偏头；'+
'0.72 是「再偏就看不清杆线」的外沿。教练检查表写作 head over the cue / 下巴压杆。',};const NO_DATA='教练经验值，未做统计验证。';const DIRECTIONS={stance_width:{low:'too_narrow',high:'too_wide'},
forearm_vertical:{low:null,high:'too_tilted'},
bridge_arm_straight:{low:'too_bent',high:null},
head_low:{low:'too_high',high:'too_low'},
torso_lean:{low:'too_upright',high:'too_deep'},
knee_bend:{low:'too_deep',high:'too_straight'},
head_over_cue:{low:null,high:'off_cue_line'},};const PHRASE={stance_width:{too_narrow:{word:'比推荐下限窄',
fix:'双脚几乎踩在一条线上，上身俯下去后侧向没有支撑，出杆时身体会跟着晃。把前脚往外开一点，间距接近一又半个肩宽就够。',},
too_wide:{word:'比推荐上限宽',
fix:'两腿分得太开，重心横向转移变慢，前脚还容易挡住出杆通道。站距收回来一点。',},},
forearm_vertical:{too_tilted:{word:'偏离竖直',
fix:'小臂不竖直，腕部速度就会分出一部分到上下方向，杆头在击球段会画弧。把肘稍微收回来，让肘落在腕的正上方。',},},
bridge_arm_straight:{too_bent:{word:'比推荐下限小',
fix:'架桥臂弯着，手是靠肌肉悬着的，出杆发力时会被压塌，架桥高度也稳不住。前臂尽量伸直。',},},
head_low:{too_high:{word:'离推荐下限还差',
fix:'上身还没压下去，眼睛离球杆太远，只能靠估。用屈髋（而不是只低头）把下巴降到接近球杆。',},
too_low:{word:'比推荐上限高',
fix:'头压到肩线以下太多，脖子和腰会吃力，出杆空间也变小。抬一点，视线够低就行，不必把脸贴到杆上。',},},
torso_lean:{too_upright:{word:'比推荐下限小',
fix:'上身太直，眼睛离球太远，悬挂点（肩）也离球杆所在的平面太远，钟摆方向不水平。屈髋把上身压下去。',},
too_deep:{word:'比推荐上限大',
fix:'压得过低，重心跑到前脚外面，腰背和脖子会先累，出杆空间也变小。抬一点。',},},
knee_bend:{too_deep:{word:'比推荐下限小',
fix:'蹲得太深，大腿前侧要持续发力，准备阶段几十秒里腿会开始抖。站高一点。',},
too_straight:{word:'比推荐上限大',
fix:'腿接近伸直，没有缓冲，重心偏高，上身只能靠腰背去压。轻微屈膝让身体更稳。',},},
head_over_cue:{off_cue_line:{word:'偏离球杆',
fix:'视线不在杆的正上方，看到的角度得自己补，容易看偏。把下巴对到球杆上。',},},};const FALLBACK_PHRASE={word:'偏离推荐区间',
fix:'这一侧没有单独的形容，按对应指标的常规做法调回去即可。',};const IDS=[
{id:'stance_width'},
{id:'forearm_vertical'},
{id:'bridge_arm_straight'},
{id:'head_low'},
{id:'torso_lean'},
{id:'knee_bend'},
{id:'head_over_cue'},
];export const REFERENCE=Object.freeze(
IDS.map(({id})=>{const t=THRESHOLDS[id];const lo=t.good[0];const hi=t.good[1];return{id,
ideal:([lo,hi]),
tolerance:([
Math.max(0,lo-t.warn[0]),
Math.max(0,t.warn[1]-hi),
]),
direction:{...DIRECTIONS[id]},
basis:`${BASIS[id]}${NO_DATA}`,};})
);export const REFERENCE_BY_ID=Object.freeze(
REFERENCE.reduce((acc,r)=>{acc[r.id]=r;return acc;},({}))
);function fmtNum(v,unit){if(!Number.isFinite(v))return'—';return unit==='°'?String(Math.round(v)):v.toFixed(2);}
function unitSuffix(unit){if(unit==='°')return'°';if(unit==='×肩宽')return' 个肩宽';if(unit==='×躯干长')return' 个躯干长';return unit?` ${unit}`:'';}
function fmtWithUnit(v,unit){return`${fmtNum(v, unit)}${unitSuffix(unit)}`;}
export function compareMetric(check){const id=check&&typeof check.id==='string'?check.id:'';const unit=check&&typeof check.unit==='string'?check.unit:'';const ref=id?REFERENCE_BY_ID[id]:undefined;if(!ref){return{status:'unknown',
deviation:null,
direction:null,
band:null,
advice:'这一项没有参考区间，只报测量值，不做好坏判断。',};}
const[lo,hi]=ref.ideal;const band={ideal:([lo,hi]),
near:([lo-ref.tolerance[0],hi+ref.tolerance[1]]),};const value=check.value;if(check.status==='unknown'||!Number.isFinite(value)){const missing=Array.isArray(check.missing)?check.missing:[];let advice;if(missing.length){advice=`缺少关键点 ${missing.join('、')}，这一项这次比不了。`;}else if(check.indeterminate){advice='量到的值离推荐边界还不如单目相机的波动大，这一项不判——先别拿它当结论。';}else{advice='这次没量到这个值（被遮挡或不够可信），不做对照。';}
return{status:'unknown',deviation:null,direction:null,band,advice};}
let side=null;if(value>hi)side='high';else if(value<lo)side='low';const deviation=side==='high'?value-hi:side==='low'?value-lo:0;const direction=side?ref.direction[side]:null;const status=side===null
?'good'
:value>=band.near[0]&&value<=band.near[1]
?'near'
:'off';const label=typeof check.label==='string'&&check.label?check.label:id;const shown=fmtWithUnit(value,unit);const range=`${fmtNum(lo, unit)}–${fmtNum(hi, unit)}${unitSuffix(unit)}`;if(status==='good'){return{status,
deviation,
direction,
band,
advice:`${label} ${shown}，在参考区间（${range}）内，保持住。`,};}
const phrase=(direction&&PHRASE[id]?.[direction])||FALLBACK_PHRASE;const gap=fmtWithUnit(Math.abs(deviation),unit);const tail=status==='near'?'刚出推荐区间，还在容差带里':'已经出了容差带';return{status,
deviation,
direction,
band,
advice:`${label} ${shown}，${phrase.word} ${gap}，${tail}——${phrase.fix}`,};}
export function compareAll(checks){const list=Array.isArray(checks)?checks:[];const items=list.map((c)=>{const cmp=compareMetric(c);const id=c&&typeof c.id==='string'?c.id:'unknown';const ref=REFERENCE_BY_ID[id];return{id,
label:c&&typeof c.label==='string'?c.label:'',
value:c&&Number.isFinite(c.value)?c.value:null,
unit:c&&typeof c.unit==='string'?c.unit:'',
basis:ref?ref.basis:'',
...cmp,};});const summary={good:0,near:0,off:0,unknown:0};for(const it of items){const k=it.status;if(k==='good'||k==='near'||k==='off')summary[k]+=1;else summary.unknown+=1;}
return{items,summary};}
export function describeSummary(summary){const s=summary??{};const good=Number.isFinite(s.good)?s.good:0;const near=Number.isFinite(s.near)?s.near:0;const off=Number.isFinite(s.off)?s.off:0;const unknown=Number.isFinite(s.unknown)?s.unknown:0;const measured=good+near+off;if(measured+unknown===0)return'没有可对照的指标。';if(measured===0)return`${unknown} 项都没测到，这次没法和参考区间对照。`;const parts=[`${measured} 项里 ${good} 项在参考区间内`];if(near)parts.push(`${near} 项接近边界`);if(off)parts.push(`${off} 项偏离`);let text=`${parts.join('，')}。`;if(unknown)text+=`另有 ${unknown} 项测不到，没参与对照。`;return text;}
