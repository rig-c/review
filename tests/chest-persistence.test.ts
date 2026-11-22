import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {chestInputIds} from '../web/chest-regions-tool.ts';
import {LANDMARKS} from '../web/chest-editor.ts';
import {chestPartFields,chestSeed,chestStatusForPart,seedFields,seedLandmarks,noContourReason} from '../web/rebuild-client.ts';

async function chestPersistenceFixture(){
 const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const slice=(start:string,end:string)=>{const a=main.indexOf(start),b=main.indexOf(end,a);if(a<0||b<0)throw Error('CHEST_PERSISTENCE_SOURCE_MISSING');return main.slice(a,b);};
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync([
  slice('const navigationBookmark=', '/** Read the SELECTED reference'),
  slice('async function setupPersistence(', '/** Setup\'s Chest regions tool:'),
  slice('function chestField(', 'function chestEvaluation('),
  slice('let chestFormPart:', '/** The handoff line (#101):'),
  slice('async function openStageCorrection(', '\n\nreturn {dispose:'),
 ].join('\n'));
 const region=(name:string,cx:number)=>({name,shape:'circle',cx,cy:105,r:18,bone:name,spacing:8,band:8});
 const a=[region('A',90)],b=[region('B',330)];
 const status={available:true,inputs:{configHash:'source-config'},parts:[{name:'A',regions:a},{name:'B',regions:b}],contour:{A:{contour:{regions:a,bust:{apex_r:[90,105],apex_l:[150,105],cleavage:[120,105],alpha:.6,clearance:2,bone_r:'A',bone_l:'A'}}},B:{contour:{regions:b}}}};
 const factory=new Function('deps',`with(deps){
  class HTMLInputElement{constructor(id){this.id=id;this.value=id==='bust-mode'?'circles':'';this.defaultValue=this.value;this.checked=false;this.defaultChecked=false;this.type='text';this.options=[];}dispatchEvent(){}hasAttribute(){return false;}}
  class HTMLSelectElement extends HTMLInputElement{constructor(id){super(id);this.options=[];}}
  class HTMLTextAreaElement extends HTMLInputElement{}
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new HTMLInputElement(id));return nodes.get(id);};
  const document={getElementById:get},input=get,select=get,el=get;
  const LANDMARKS=deps.LANDMARKS,chestInputIds=deps.chestInputIds;
  let persistence=null,inspectionOpening=false,captured,selected=null,rebuildStatus=null;
  const parts={value:()=>selected?{slot:selected}:null},connectInspectionPersistence=async adapter=>{captured=adapter;return {restored:true};};
  const data={manifest:{id:'chests'},sourceHash:'source'},submittedBaseline={},session={feedback:[]},dirty=false;
  const inspectionBinding=()=>({}),inspectionBookmark=()=>({}),checkpointPair=null,host=null,bookmarkCameraKept=()=>true;
  let reportPage=0,selectedReportEvent,selectedReportTime,selectedReportTarget;
  const workspace=null,inspectorBlocks=null,activeBlocksUI=()=>({}),restoreActiveBlocksUI=()=>({});
  const renderReportEvents=()=>{},renderReportSelection=()=>{},renderFeedbackTargets=()=>{},renderFeedbackRange=()=>{},text=()=>{};
  const chestEditor={notify(){},noticeText:()=>'',rebind(){},unavailable(){}},api=async()=>structuredClone(deps.status),renderHandoff=()=>{},refreshPhysics=()=>{},renderDropNotices=()=>{},redrawOverlay=()=>{};
  const retargetPanel=null,bonesPanel=null,rigFieldsPanel=null,clothPanel=null,cutsPanel=null,meshPanel=null,animationPanel=null,inspectedModel={},stageDraftSelection=null,rebuildBusy=false;
  ${code}
  return {async init(){await setupPersistence();},load:()=>loadRebuildStatus(),select:async part=>{selected=part;await openStageCorrection({part,instrument:'selection'});},
   edit:(id,value)=>{get(id).value=value;},ui:()=>captured.ui(),inputs:()=>Object.fromEntries([...nodes].map(([id,node])=>[id,{value:node.value}])),
   async restore(ui,inputs,part){captured.restoreUI(ui);selected=part;await openStageCorrection({part,instrument:'selection'});for(const [id,field]of Object.entries(inputs))get(id).value=field.value;captured.afterInputs();await loadRebuildStatus();},
   state:()=>({part:chestFormPart,cx:get('chest-0-cx').value,mode:get('bust-mode').value,landmark:get('lm-apex_r-x').value})};
 }`);
 return ()=>factory({status,LANDMARKS,chestInputIds,chestPartFields,chestSeed,chestStatusForPart,seedFields,seedLandmarks,noContourReason});
}

for(const legacy of [false,true])for(const resume of [false,true])test(`#847 ${legacy?'legacy draft':'owned draft'} ${resume?'resume':'reopen'} edited B restores its form identity before status seeding and does not file B values under A`,async()=>{
 const open=await chestPersistenceFixture(),first=open();await first.init();await first.load();await first.select('B');first.edit('chest-0-cx','331');
 const saved={ui:structuredClone(first.ui()),inputs:structuredClone(first.inputs())};
 if(legacy)delete saved.ui.chestFormPart;
 const reopened=open();await reopened.init();if(resume)await reopened.load();await reopened.restore(saved.ui,saved.inputs,'B');
 const b=reopened.state();await reopened.select('A');const a=reopened.state();await reopened.select('B');
 expect({b,a,back:reopened.state()}).toEqual({b:{part:'B',cx:'331',mode:'circles',landmark:''},a:{part:'A',cx:'90',mode:resume?'circles':'landmarks',landmark:'90'},back:{part:'B',cx:'331',mode:'circles',landmark:''}});
});
