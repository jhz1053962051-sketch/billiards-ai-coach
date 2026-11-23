export const LM={NOSE:0,
LEFT_EYE_INNER:1,
LEFT_EYE:2,
LEFT_EYE_OUTER:3,
RIGHT_EYE_INNER:4,
RIGHT_EYE:5,
RIGHT_EYE_OUTER:6,
LEFT_EAR:7,
RIGHT_EAR:8,
MOUTH_LEFT:9,
MOUTH_RIGHT:10,
LEFT_SHOULDER:11,
RIGHT_SHOULDER:12,
LEFT_ELBOW:13,
RIGHT_ELBOW:14,
LEFT_WRIST:15,
RIGHT_WRIST:16,
LEFT_PINKY:17,
RIGHT_PINKY:18,
LEFT_INDEX:19,
RIGHT_INDEX:20,
LEFT_THUMB:21,
RIGHT_THUMB:22,
LEFT_HIP:23,
RIGHT_HIP:24,
LEFT_KNEE:25,
RIGHT_KNEE:26,
LEFT_ANKLE:27,
RIGHT_ANKLE:28,
LEFT_HEEL:29,
RIGHT_HEEL:30,
LEFT_FOOT_INDEX:31,
RIGHT_FOOT_INDEX:32,};export const LM_NAMES=[
'nose',
'left_eye_inner','left_eye','left_eye_outer',
'right_eye_inner','right_eye','right_eye_outer',
'left_ear','right_ear',
'mouth_left','mouth_right',
'left_shoulder','right_shoulder',
'left_elbow','right_elbow',
'left_wrist','right_wrist',
'left_pinky','right_pinky',
'left_index','right_index',
'left_thumb','right_thumb',
'left_hip','right_hip',
'left_knee','right_knee',
'left_ankle','right_ankle',
'left_heel','right_heel',
'left_foot_index','right_foot_index',
];export const POSE_CONNECTIONS=[
[0,1],[1,2],[2,3],[3,7],
[0,4],[4,5],[5,6],[6,8],
[9,10],
[11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
[12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
[11,23],[12,24],[23,24],
[23,25],[25,27],[27,29],[27,31],[29,31],
[24,26],[26,28],[28,30],[28,32],[30,32],
];export const UP={x:0,y:-1,z:0};export const DOWN={x:0,y:1,z:0};export const vec={add:(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z}),
sub:(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),
scale:(a,k)=>({x:a.x*k,y:a.y*k,z:a.z*k}),
dot:(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,
cross:(a,b)=>({x:a.y*b.z-a.z*b.y,
y:a.z*b.x-a.x*b.z,
z:a.x*b.y-a.y*b.x,}),
len:(a)=>Math.hypot(a.x,a.y,a.z),
dist:(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),
mid:(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2}),
norm:(a)=>{const l=Math.hypot(a.x,a.y,a.z)||1;return{x:a.x/l,y:a.y/l,z:a.z/l};},};export const DEG=180/Math.PI;export function angleAt(a,b,c){if(!a||!b||!c)return NaN;const ba=vec.sub(a,b);const bc=vec.sub(c,b);const la=vec.len(ba);const lc=vec.len(bc);if(la<1e-9||lc<1e-9)return NaN;let cos=vec.dot(ba,bc)/(la*lc);cos=cos<-1?-1:cos>1?1:cos;return Math.acos(cos)*DEG;}
export function angleFromUp(v){if(!v)return NaN;const l=vec.len(v);if(l<1e-9)return NaN;let cos=vec.dot(v,UP)/l;cos=cos<-1?-1:cos>1?1:cos;return Math.acos(cos)*DEG;}
export function angleFromDown(v){if(!v)return NaN;const l=vec.len(v);if(l<1e-9)return NaN;let cos=vec.dot(v,DOWN)/l;cos=cos<-1?-1:cos>1?1:cos;return Math.acos(cos)*DEG;}
export function pointLineDistance(p,a,d){const dn=vec.norm(d);const ap=vec.sub(p,a);const proj=vec.scale(dn,vec.dot(ap,dn));return vec.len(vec.sub(ap,proj));}
export function straightnessError(points){const n=points.length;if(n<3)return NaN;const c={x:0,y:0,z:0};for(const p of points){c.x+=p.x/n;c.y+=p.y/n;c.z+=p.z/n;}
let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;for(const p of points){const dx=p.x-c.x,dy=p.y-c.y,dz=p.z-c.z;xx+=dx*dx;xy+=dx*dy;xz+=dx*dz;yy+=dy*dy;yz+=dy*dz;zz+=dz*dz;}
let dir=vec.norm(vec.sub(points[n-1],points[0]));if(vec.len(dir)<1e-9)dir={x:1,y:0,z:0};for(let i=0;i<24;i++){const nx=xx*dir.x+xy*dir.y+xz*dir.z;const ny=xy*dir.x+yy*dir.y+yz*dir.z;const nz=xz*dir.x+yz*dir.y+zz*dir.z;const l=Math.hypot(nx,ny,nz);if(l<1e-12)break;dir={x:nx/l,y:ny/l,z:nz/l};}
let tMin=Infinity;let tMax=-Infinity;const ts=[];for(const p of points){const t=vec.dot(vec.sub(p,c),dir);ts.push(t);if(t<tMin)tMin=t;if(t>tMax)tMax=t;}
const span=tMax-tMin;if(span<1e-9)return NaN;let maxDev=0;for(let i=0;i<n;i++){const p=points[i];const t=ts[i];const onLine=vec.add(c,vec.scale(dir,t));const d=vec.dist(p,onLine);if(d>maxDev)maxDev=d;}
return maxDev/span;}
export function normalizePose(result){const toMap=(arr)=>{const m={};if(!arr)return m;for(let i=0;i<arr.length&&i<LM_NAMES.length;i++){const p=arr[i];m[LM_NAMES[i]]={x:p.x,y:p.y,z:p.z,
visibility:p.visibility??1,
presence:p.presence??1,};}
return m;};const worldArr=result?.worldLandmarks?.[0]??null;return{image:toMap(result?.landmarks?.[0]??null),
world:toMap(worldArr),
hasWorld:!!worldArr,};}
export function minVisibility(pose,names){let v=1;for(const n of names){const p=pose[n];if(!p)return 0;v=Math.min(v,p.visibility??1);}
return v;}
export function frameInset(pose,names){let m=Infinity;for(const n of names){const p=pose[n];if(!p)return-1;m=Math.min(m,p.x,1-p.x,p.y,1-p.y);}
return Number.isFinite(m)?m:-1;}
