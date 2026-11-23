import{FilesetResolver,PoseLandmarker}from'../vendor/pose/vision_bundle.mjs';import{normalizePose,POSE_CONNECTIONS,LM_NAMES}from'../src/pose/landmarks.js';import{analyzeImage,analyzeSequence}from'../src/pose/analyze.js';import{THRESHOLDS}from'../src/pose/checks.js';const WASM_ROOT='../vendor/pose/wasm';const MODEL='../vendor/pose/pose_landmarker_lite.task';const SAMPLE_MS=50;const MAX_ANALYZE_MS=12000;const $=(id)=>document.getElementById(id);const canvas=$('view');const ctx=canvas.getContext('2d');const video=$('video');const statusEl=$('status');let imageMode=null;let frames=[];let currentReport=null;let reportSeq=0;let lastPose=null;let currentFrameIdx=0;let sourceWidth=0;let sourceHeight=0;let bitmap=null;let landmarkerPromise=null;function setStatus(text,kind=''){statusEl.textContent=text;statusEl.className=`status ${kind}`.trim();}
async function createLandmarker(runningMode){const fileset=await FilesetResolver.forVisionTasks(WASM_ROOT);const opts=(delegate)=>({baseOptions:{modelAssetPath:MODEL,delegate},
runningMode,
numPoses:1,
minPoseDetectionConfidence:0.5,
minPosePresenceConfidence:0.5,
minTrackingConfidence:0.5,
outputSegmentationMasks:false,});try{return await PoseLandmarker.createFromOptions(fileset,opts('GPU'));}catch{return await PoseLandmarker.createFromOptions(fileset,opts('CPU'));}}
function loadLandmarker(){if(landmarkerPromise)return landmarkerPromise;landmarkerPromise=(async()=>{setStatus('正在加载姿态模型…');const lm=await createLandmarker('IMAGE');setStatus('模型就绪。','ok');return lm;})().catch((err)=>{landmarkerPromise=null;setStatus(`模型加载失败：${err?.message ?? err}`,'err');throw err;});return landmarkerPromise;}
function fitCanvas(w,h){const stage=$('stage');const availW=Math.max(240,stage.clientWidth-36);const availH=Math.max(200,stage.clientHeight-36);const scale=Math.min(availW/w,availH/h,1);canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);canvas.style.width=`${canvas.width}px`;canvas.style.height=`${canvas.height}px`;}
function toPx(p){return{x:p.x*canvas.width,y:p.y*canvas.height};}
function drawSource(source){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);}
function drawSkeleton(pose){if(!pose)return;const line=(a,b)=>{if(!a||!b)return;const pa=toPx(a);const pb=toPx(b);ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke();};ctx.lineWidth=Math.max(2,canvas.width/320);ctx.strokeStyle='rgba(74, 222, 128, 0.85)';ctx.lineCap='round';for(const[i,j]of POSE_CONNECTIONS){line(pose[LM_NAMES[i]],pose[LM_NAMES[j]]);}
for(const name of LM_NAMES){const p=pose[name];if(!p)continue;const q=toPx(p);const vis=p.visibility??1;const r=Math.max(2.5,canvas.width/220);ctx.beginPath();ctx.arc(q.x,q.y,r,0,Math.PI*2);ctx.fillStyle=vis>=0.55?'#4ade80':'rgba(139, 152, 169, 0.5)';ctx.fill();}}
function scoreClass(report){if(report.score===null)return'none';if(report.score>=88)return'good';if(report.score>=74)return'warn';if(report.score>=58)return'warn';return'bad';}
function fmtValue(c){if(c.value===null||c.value===undefined)return'—';const v=c.value;switch(c.unit){case'°':
return`${v.toFixed(0)}°`;case'×肩宽':
case'×躯干长':
case'×击球前行程':
case'×后摆':
return`${v.toFixed(2)}${c.unit.slice(1)}`;case'偏差/行程':
return`${(v * 100).toFixed(1)}%`;default:
return v.toFixed(2);}}
const CATEGORY_LABEL={setup:'站姿',stroke:'出杆'};function renderChecks(report){const groups={setup:report.setup,stroke:report.stroke};const weak=new Set(report.weakMetrics??[]);const html=[];for(const key of['setup','stroke']){const list=groups[key];if(!list||!list.length)continue;const good=list.filter((c)=>c.status==='good').length;const measurable=list.filter((c)=>c.status!=='unknown').length;html.push(
`<div class="grp"><div class="gt"><span>${CATEGORY_LABEL[key]}</span><span>${measurable ? `${good}/${measurable} 项规范` : '无法测量'}</span></div>`
);for(const c of list){const tag=c.indeterminate
?'<span class="tag">测不准</span>'
:weak.has(c.id)
?'<span class="tag">单目易失真</span>'
:'';html.push(
`<div class="chk ${c.status}">`+
`<span class="dot"></span>`+
`<span class="n">${c.label}${tag}</span>`+
`<span class="v">${fmtValue(c)}</span>`+
`<span class="d">${c.detail}</span>`+
`</div>`
);}
html.push('</div>');}
$('checks').className='';$('checks').innerHTML=html.join('');}
function renderIssues(report){if(!report.issues.length){$('issues').className='empty';$('issues').textContent=report.score===null
?(report.enough===false
?`只测到 ${(report.coverage * 100).toFixed(0)}% 的项目，证据不足，不给总分。换一张能看清全身的照片。`
:'没有可测量的项，无法给出结论。')
:'所有能测的项目都在规范区间内。';return;}
$('issues').className='';$('issues').innerHTML=report.issues
.slice(0,5)
.map(
(c)=>
`<div class="issue ${c.status}"><div class="t">${c.label} · ${fmtValue(c)}</div>`+
`<div class="d">${c.detail}</div></div>`
)
.join('');}
const CMP_LABEL={good:'在区间内',near:'接近边界',off:'偏离',unknown:'不判'};const clampPct=(p)=>(p<1.5?1.5:p>98.5?98.5:p);function pctIn(v,lo,hi){const span=hi-lo;if(!(span>0))return 50;return clampPct(((v-lo)/span)*100);}
function renderComparison(report){const cmp=report.comparison;if(!cmp)return;$('cmpSummary').textContent=cmp.verdict;const rows=cmp.items.map((it)=>{const band=it.band;let bars='';let mark='';if(band){const span=band.near[1]-band.near[0];const pad=span>0?span*0.35:Math.abs(band.ideal[1]-band.ideal[0])||0.5;const dLo=band.near[0]-pad;const dHi=band.near[1]+pad;const seg=(a,b)=>
`left:${pctIn(a, dLo, dHi).toFixed(2)}%;width:${Math.max(
          0.6,
          pctIn(b, dLo, dHi) - pctIn(a, dLo, dHi)
        ).toFixed(2)}%`;bars=
`<span class="cmp-near" style="${seg(band.near[0], band.near[1])}"></span>`+
`<span class="cmp-ideal" style="${seg(band.ideal[0], band.ideal[1])}"></span>`;if(Number.isFinite(it.value)){mark=`<span class="cmp-mark" style="left:${pctIn(it.value, dLo, dHi).toFixed(2)}%"></span>`;}}
return(
`<div class="cmp ${it.status}">`+
`<div class="cmp-top"><span class="cmp-name">${it.label || it.id}</span>`+
`<span class="cmp-val">${fmtValue(it)}</span></div>`+
`<div class="cmp-bar">${bars}${mark}</div>`+
`<div class="cmp-foot"><span class="cmp-st">${CMP_LABEL[it.status] ?? '不判'}</span>`+
`<span class="cmp-adv">${it.advice}</span></div>`+
`</div>`
);});const box=$('comparison');box.className=rows.length?'':'empty';box.innerHTML=rows.length?rows.join(''):'没有可对照的指标。';const basis=cmp.items
.filter((it)=>it.basis)
.map((it)=>`<p class="cmp-b"><b>${it.label || it.id}</b>：${it.basis}</p>`)
.join('');$('cmpBasis').innerHTML=basis||'<p class="hint">没有可用的区间依据。</p>';}
function renderReport(report){currentReport=report;reportSeq++;const cls=scoreClass(report);$('score').className=`s-${cls}`;$('grade').className=`s-${cls}`;$('score').textContent=report.score===null?'—':String(report.score);$('grade').textContent=report.grade;const measured=report.checks.filter((c)=>c.status!=='unknown').length;const parts=[`共 ${report.checks.length} 项，测到 ${measured} 项`];parts.push(`证据覆盖 ${(report.coverage * 100).toFixed(0)}%`);parts.push(`置信度 ${(report.confidence * 100).toFixed(0)}%`);if(report.mode==='video'){parts.push(`${report.frameCount} 帧`);if(report.averagedFrames>1)parts.push(`站姿取 ${report.averagedFrames} 帧平均`);}
$('conf').textContent=parts.join(' · ');renderIssues(report);renderChecks(report);renderComparison(report);}
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp']);const VIDEO_TYPES=new Set(['video/mp4','video/webm','video/quicktime']);function typeRejected(file,allowed,hint){const type=(file.type||'').toLowerCase();if(allowed.has(type))return null;const kind=type?type.replace(/^image\/|^video\//,'').toUpperCase():'没有扩展名信息';return`这个格式（${kind}）读不了。${hint}`;}
async function handleImage(file){const rejected=typeRejected(
file,
IMAGE_TYPES,
'请用 PNG / JPEG / WebP；iPhone 的 HEIC 要先在相册里「导出」或截图成 JPEG。'
);if(rejected){setStatus(rejected,'err');return;}
imageMode='image';frames=[];$('scrubCard').hidden=true;$('empty').hidden=true;const lm=await loadLandmarker();setStatus('正在读取图片…');bitmap=await createImageBitmap(file);sourceWidth=bitmap.width;sourceHeight=bitmap.height;fitCanvas(sourceWidth,sourceHeight);drawSource(bitmap);setStatus('正在识别姿态…');const result=lm.detect(bitmap);const pose=normalizePose(result);if(!result.landmarks?.length){setStatus('图片里没有检测到人。换一张能看到全身的正面/侧面照片。','err');ctx.clearRect(0,0,canvas.width,canvas.height);return;}
drawSkeleton(pose.image);lastPose=pose;const report=analyzeImage(result,{normalize:normalizePose});renderReport(report);setStatus('分析完成。','ok');}
function seekTo(t){return new Promise((resolve)=>{let done=false;const finish=()=>{if(done)return;done=true;video.removeEventListener('seeked',finish);resolve();};video.addEventListener('seeked',finish);const dur=video.duration;const cap=Number.isFinite(dur)?Math.max(0,dur-0.001):t;video.currentTime=Math.min(t,cap);setTimeout(finish,3000);});}
async function handleVideo(file){const rejected=typeRejected(
file,
VIDEO_TYPES,
'请用 MP4 / WebM / MOV；手机录的原片一般可以直接用，转码后再试也行。'
);if(rejected){setStatus(rejected,'err');return;}
imageMode='video';frames=[];bitmap=null;$('empty').hidden=true;setStatus('正在准备视频…');const videoLm=await createLandmarker('VIDEO');video.src=URL.createObjectURL(file);await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('视频无法解码'));});if(!Number.isFinite(video.duration)){await new Promise((resolve)=>{const done=()=>{video.removeEventListener('durationchange',done);resolve();};video.addEventListener('durationchange',done);video.currentTime=1e101;setTimeout(done,2000);});video.currentTime=0;}
sourceWidth=video.videoWidth;sourceHeight=video.videoHeight;if(!sourceWidth||!sourceHeight){setStatus('这个视频没有可用的画面（可能是纯音频或编码不支持）。','err');return;}
fitCanvas(sourceWidth,sourceHeight);const dur=video.duration;const usable=Number.isFinite(dur)?dur:MAX_ANALYZE_MS/1000;const analyzeSpan=Math.min(usable,MAX_ANALYZE_MS/1000);const startAt=Number.isFinite(dur)?Math.max(0,(dur-analyzeSpan)/2):0;const count=Math.max(2,Math.floor((analyzeSpan*1000)/SAMPLE_MS));for(let i=0;i<count;i++){const t=startAt+(i*analyzeSpan)/count;await seekTo(t);const ts=Math.round(i*SAMPLE_MS);const result=videoLm.detectForVideo(video,ts);frames.push({t,poseResult:result});if(i%5===0||i===count-1){setStatus(`正在逐帧分析… ${i + 1}/${count}`);drawSource(video);const p=normalizePose(result);if(result.landmarks?.length)drawSkeleton(p.image);await new Promise((r)=>setTimeout(r,0));}}
const detected=frames.filter((f)=>f.poseResult.landmarks?.length).length;if(detected===0){setStatus('整段视频里都没检测到人。请确认画面里有完整的人，且光线足够。','err');return;}
const report=analyzeSequence(frames,{normalize:normalizePose});renderReport(report);$('scrubCard').hidden=false;$('scrub').max=String(frames.length-1);$('scrub').value='0';currentFrameIdx=0;showFrame(0);setStatus(`分析完成：${frames.length} 帧中 ${detected} 帧检测到人。`,'ok');}
function showFrame(idx){const f=frames[idx];if(!f)return;currentFrameIdx=idx;const pose=normalizePose(f.poseResult);drawSource(video);if(f.poseResult.landmarks?.length)drawSkeleton(pose.image);$('scrubInfo').textContent=`第 ${idx + 1} / ${frames.length} 帧 · t = ${f.t.toFixed(2)} s`+
(f.poseResult.landmarks?.length?'':' · 这一帧没有检测到人');}
$('pickImage').addEventListener('change',(e)=>{const f=e.target.files?.[0];if(!f)return;handleImage(f).catch((err)=>setStatus(`分析失败：${err?.message ?? err}`,'err'));e.target.value='';});$('pickVideo').addEventListener('change',(e)=>{const f=e.target.files?.[0];if(!f)return;handleVideo(f).catch((err)=>setStatus(`分析失败：${err?.message ?? err}`,'err'));e.target.value='';});$('scrub').addEventListener('input',(e)=>{showFrame(Number(e.target.value));});window.addEventListener('resize',()=>{if(!sourceWidth)return;fitCanvas(sourceWidth,sourceHeight);if(imageMode==='image'&&bitmap){drawSource(bitmap);if(currentReport){}}else if(imageMode==='video'&&frames.length){showFrame(currentFrameIdx);}});window.__pose={get report(){return currentReport;},
get seq(){return reportSeq;},
get frames(){return frames.length;},
get mode(){return imageMode;},
get lastPose(){return lastPose;},
thresholds:THRESHOLDS,};
