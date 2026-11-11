/**
 * Card A (#706): Create step 1 (parts + mesh) is the one review screen's Setup mode. This composes the parts
 * workspace (`parts.ts`) into the rig workspace's existing regions instead of a separate page or frame:
 * left-sidebar tabs Parts · Flagged parts (n) · Source, the shared main and secondary toolbars, the main view,
 * bottom-panel tabs Producer flags · Mesh geometry · Comments (n) beside the rig's own tabs, the parts act bar
 * and status readouts. The rig's own regions are hidden by `html[data-setup-parts]` while Stage 1 is current.
 */
import {mountPartsWorkspace,type PanelOutput,type PartsHost,type PartsSource,type PartsWorkspaceHandle,type ViewData} from './parts.ts';
import {bottomPanelTab,mountActBar,type ActBar,type BottomPanel} from './inspector-blocks.ts';
import {actionButton,bindInspectorTabs,panelMake,type InspectorTabs} from './view-controls.ts';
import {onLanguageChange,t} from './i18n.ts';
import {parsePartsIssue,type PartsIssue} from '../src/parts-comment.ts';
import type {InstanceAccess} from './instance-access.ts';
import type {StagePartsState} from './stage-nav.ts';

/** Where the parts data comes from: the standalone parts server, or a review package's Stage 1 (joined draft or atlas). */
export type SetupPartsTransport =
  | {kind:'parts'}
  | {kind:'stage';side?:'a'|'b';build:()=>string};

export interface SetupPartsOptions {
  access:InstanceAccess;
  transport:SetupPartsTransport;
  /** Package revision shown on the Source tab when the screen has one. */
  revision?:()=>string|null;
  correction?:(request:{part:string;sourceHash:string;buildId:string;instrument:string})=>void;
  /** Called once the first view is painted (or refused). */
  ready?:(view:ViewData)=>void;
}

export interface SetupParts {
  /** Show or hide Stage 1. The first show mounts; a later show after a draft build change revalidates in place. */
  show(active:boolean,note?:string|null):void;
  /** Mount with a transport and start (once). */
  start(options:SetupPartsOptions):void;
  snapshot():StagePartsState|null;
  restore(saved:StagePartsState):Promise<void>;
  workspace():PartsWorkspaceHandle|null;
  dispose():void;
}

/** Build Setup's step-1 hosts inside the rig workspace once, before the shell binds (`bindWorkspaceUI`). */
export function composeSetupParts(doc:Document,bottom:BottomPanel):SetupParts {
  const left=doc.querySelector<HTMLElement>('.left-panel')!,main=doc.querySelector<HTMLElement>('.workspace-main-toolbar')!;
  const secondaryBar=doc.querySelector<HTMLElement>('.workspace-secondary-toolbar')!,stageLayout=doc.getElementById('stage-layout')!;
  const inspector=doc.querySelector<HTMLElement>('.inspector')!,body=inspector.querySelector<HTMLElement>('.inspector-body')!;
  const readouts=doc.querySelector<HTMLElement>('.status-readouts')!;

  // Left sidebar: Parts · Flagged parts (n) · Source. None of them depends on another tab's selection.
  const leftHost=panelMake('section',{className:'setup-parts-left'});leftHost.setAttribute('aria-label',t('Parts'));
  const row={nav:panelMake('div',{className:'workspace-bottom-tabs'})};row.nav.classList.add('setup-parts-tabs');row.nav.setAttribute('role','tablist');row.nav.setAttribute('aria-label',t('Parts'));
  const leftPanels={parts:panelMake('div',{id:'setup-left-parts'}),legacy:panelMake('div',{id:'setup-left-legacy'}),source:panelMake('div',{id:'setup-left-source'})};
  let busy=false,disposed=false,commentCount=0,legacyCount=0,active=false,mountedBuild='inspected';
  const leftLabels:Record<keyof typeof leftPanels,()=>string>={parts:()=>t('Parts'),legacy:()=>t('Flagged parts ({0})',[legacyCount]),source:()=>t('Source')};
  const leftTabs=(Object.keys(leftPanels) as (keyof typeof leftPanels)[]).map((id,index)=>{
    const button=actionButton(leftLabels[id](),null);button.id='setup-left-tab-'+id;button.setAttribute('role','tab');button.setAttribute('aria-controls',leftPanels[id].id);
    button.setAttribute('aria-selected',String(index===0));button.tabIndex=index===0?0:-1;leftPanels[id].setAttribute('role','tabpanel');leftPanels[id].setAttribute('aria-labelledby',button.id);
    row.nav.append(button);return {id,button,panels:[leftPanels[id]],attribute:'aria-selected' as const};
  });
  leftHost.append(row.nav,...Object.values(leftPanels));
  const header=[...left.children].find(node=>node.classList.contains('left-header'));
  if(header)header.after(leftHost);else left.prepend(leftHost);

  // Toolbars and the main view: hosts beside the rig's own, shown only while Stage 1 is current.
  const toolbar=panelMake('div',{className:'setup-parts-toolbar'}),secondary=panelMake('div',{className:'setup-parts-secondary'});
  main.append(toolbar);secondaryBar.append(secondary);
  const stage=panelMake('div',{className:'setup-parts-stage'});stage.dataset.workspaceStage='';stageLayout.after(stage);

  // Bottom panel: the rig's own tabs unchanged, plus three tabs whose content follows the Parts selection.
  const bottomPanels={flags:panelMake('section',{id:'inspector-setup-flags',className:'setup-parts-panel'}),mesh:panelMake('section',{id:'inspector-setup-mesh',className:'setup-parts-panel'}),comments:panelMake('section',{id:'inspector-setup-comments',className:'setup-parts-panel'})};
  const bottomLabels:Record<keyof typeof bottomPanels,()=>string>={flags:()=>t('Producer flags'),mesh:()=>t('Mesh geometry'),comments:()=>t('Comments ({0})',[commentCount])};
  const bottomTabs=(Object.keys(bottomPanels) as (keyof typeof bottomPanels)[]).map(id=>{
    const panel=bottomPanels[id];panel.dataset.inspectorPanel='setup-'+id;panel.hidden=true;body.append(panel);
    const tab=bottomPanelTab('setup-'+id,bottomLabels[id](),panel);tab.button.dataset.setupTab='';bottom.strip.append(tab.button);
    bottom.row.tabs.push(tab);bottom.row.panels.push(panel);return {id,button:tab.button};
  });

  // Act bar (C10) and status readouts (C11).
  const submit=actionButton('',null);submit.id='parts-submit';submit.className='primary';
  const actState=panelMake('span',{id:'parts-act-state',className:'hint'});
  let output:PanelOutput|null=null,options:SetupPartsOptions|null=null,current:ViewData|null=null,mounted:PartsWorkspaceHandle|null=null;
  const objectUrls=new Set<string>(),pendingImages=new Set<()=>void>(),disposers:(()=>void)[]=[];
  const exportVerdict=(format:'json'|'issue')=>{void exportFile(format);};
  const actBar:ActBar=mountActBar({id:'parts-act',submit,saveState:actState,
    submitLabel:()=>commentCount?t('job.partsRequestFixes',[commentCount]):t('job.partsApprove'),
    overflow:[{id:'parts-export-json',label:'Export JSON',handler:()=>exportVerdict('json')},{id:'parts-export-issue',label:'Export issue',handler:()=>exportVerdict('issue')}]});
  actBar.element.classList.add('setup-parts-act');(inspector.querySelector<HTMLElement>('.inspector-heading')??inspector).append(actBar.element);
  const status=panelMake('span',{className:'setup-parts-status'});readouts.append(status);
  const hosts=[leftHost,toolbar,secondary,stage,actBar.element,status];
  const setHidden=(hidden:boolean)=>{for(const node of hosts)node.hidden=hidden;for(const tab of bottomTabs)tab.button.hidden=hidden;};
  setHidden(true);

  const leftRow=bindInspectorTabs(()=>{},()=>{},{tabs:leftTabs,panels:Object.values(leftPanels),root:row.nav,initialize:true});
  const relabel=()=>{
    for(const tab of leftTabs)tab.button.textContent=leftLabels[tab.id]();
    for(const tab of bottomTabs)tab.button.textContent=bottomLabels[tab.id as keyof typeof bottomPanels]();
    leftHost.setAttribute('aria-label',t('Parts'));row.nav.setAttribute('aria-label',t('Parts'));renderSource();actBar.refresh();
  };
  disposers.push(onLanguageChange(relabel),()=>leftRow.dispose(),()=>actBar.dispose());
  const legacyTab=leftTabs.find(tab=>tab.id==='legacy')!.button;legacyTab.hidden=true;

  const headers=(extra:Record<string,string>={})=>options!.access.headers(options!.transport.kind==='stage'?{'X-Review-Stage-Build':options!.transport.build(),...extra}:extra);
  const partsApi=()=>{const transport=options!.transport;return transport.kind==='parts'?'/api/parts':transport.side?`/api/compare/${transport.side}/stage-parts`:'/api/stage-parts';};
  const embedded=()=>options?.transport.kind==='stage';
  const request=async(path:string):Promise<Response>=>{
    const response=await fetch(options!.access.route(path),{headers:headers()});
    if(!response.ok){const value=await response.json() as {error?:string};throw new Error(value.error??'PARTS_PAINT_FAILED');}
    return response;
  };
  const image=async(path:string):Promise<HTMLImageElement>=>{
    const response=await request(path);if(disposed)throw new Error('PARTS_PAINT_FAILED');
    const blob=await response.blob();if(disposed)throw new Error('PARTS_PAINT_FAILED');
    return new Promise((resolve,reject)=>{
      const node=doc.createElement('img'),objectUrl=URL.createObjectURL(blob);objectUrls.add(objectUrl);
      const cleanup=()=>{node.onload=null;node.onerror=null;URL.revokeObjectURL(objectUrl);objectUrls.delete(objectUrl);pendingImages.delete(cancel);};
      const cancel=()=>{cleanup();node.removeAttribute('src');reject(new Error('PARTS_PAINT_FAILED'));};
      pendingImages.add(cancel);node.onload=()=>{cleanup();resolve(node);};node.onerror=()=>{cleanup();reject(new Error('PARTS_PAINT_FAILED'));};node.src=objectUrl;
    });
  };
  const source:PartsSource={
    async view(){
      if(disposed)throw new Error('PARTS_PAINT_FAILED');
      const requested=options!.transport.kind==='stage'?options!.transport.build():'inspected';
      const data=await (await request(partsApi())).json() as ViewData;
      if(disposed)throw new Error('PARTS_PAINT_FAILED');
      if(options!.transport.kind==='stage'&&requested!==options!.transport.build())throw new Error('STAGE_DRAFT_CHANGED');
      current=data;renderSource();syncActions();options!.ready?.(data);return data;
    },
    image:index=>image(`${partsApi()}/image/${index}`),
    page:index=>image(`${partsApi()}/page/${index}`),
    painting:()=>current?.painting?image('/api/parts/painting'):null,
    difference:(index,threshold,footprints)=>request(`${partsApi()}/difference/${index}?threshold=${threshold}&footprints=${footprints}`),
    async crop(issue){
      if(embedded())throw new Error('PARTS_JOINED_ISSUE_UNSUPPORTED');
      const response=await fetch(options!.access.route('/api/parts/comment'),{method:'POST',headers:options!.access.headers({'Content-Type':'application/json'}),body:JSON.stringify(issue)});
      const value=await response.json() as {comment:unknown;error?:string};
      if(!response.ok)throw new Error(value.error??'PARTS_COMMENT_UNAVAILABLE: original part image required');
      return parsePartsIssue(value.comment,true,true,false);
    },
  };
  const host:PartsHost={
    initial:()=>current?.verdict?.issues??current?.legacyVerdict?.issues??(current?.verdict?.comments??[]).map(issue=>parsePartsIssue(issue,true,true,false)),
    changed(){syncActions();},
    register(value){output=value;},
    locked:()=>busy||current?.legacyVerdict?.readOnly||embedded()&&(!current?.joinedVerdictBinding||!options!.access.capability||headers().get('X-Review-Stage-Build')!=='inspected')?'sent':'open',
  };
  const setStatus=(kind:'saved'|'failed'|'read-only'|'unsaved'|'saving',text:string)=>actBar.setSaveState({kind,text});
  const save=async()=>{
    if(!current||!output||host.locked()!=='open')return;
    busy=true;syncActions();setStatus('saving','Saving…');
    try{
      const value=output.value();
      if(!('issues' in value)||!('verdict' in value))throw new Error('PARTS_VERDICT_INVALID');
      if(embedded()&&value.issues.length>0){setStatus('failed','PARTS_JOINED_ISSUE_UNSUPPORTED');return;}
      const body={status:value.verdict,issues:value.issues,...(embedded()?{binding:current.joinedVerdictBinding}:{})};
      const response=await fetch(options!.access.route(`${partsApi()}/verdict`),{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify(body)});
      const result=await response.json() as {error?:string;verdict?:{source:{sha256:string}}};
      if(disposed)return;
      if(response.ok)setStatus('saved',t('Saved {file}: source {hash}.',{file:current.verdictFile,hash:result.verdict!.source.sha256.slice(0,12)}));
      else setStatus('failed',result.error??'Save failed.');
    }catch{if(!disposed)setStatus('failed','Save failed.');}
    finally{busy=false;if(!disposed)syncActions();}
  };
  submit.onclick=()=>{void save();};
  const exportFile=async(format:'json'|'issue')=>{
    const data=current;if(!data)return;
    try{
      const response=await request(embedded()?`${partsApi()}/export/${format}`:`/api/parts/export?format=${format}`);
      const value=await response.text();if(disposed)return;
      const objectUrl=URL.createObjectURL(new Blob([value],{type:format==='json'?'application/json':'text/markdown'}));objectUrls.add(objectUrl);
      const anchor=doc.createElement('a');anchor.href=objectUrl;
      anchor.download=embedded()?(format==='json'?data.verdictFile:data.verdictFile.replace(/\.json$/,'.md')):format==='json'?'parts-review-export.json':'parts-review-export.md';
      anchor.click();
      const timer=setTimeout(()=>{URL.revokeObjectURL(objectUrl);objectUrls.delete(objectUrl);},1000);disposers.push(()=>clearTimeout(timer));
    }catch(error){if(!disposed)setStatus('failed',error instanceof Error?error.message:'Save failed.');}
  };
  function syncActions():void {
    actBar.element.hidden=!active||embedded()&&!current?.joinedVerdictBinding;
    submit.disabled=host.locked()!=='open';
    submit.title=embedded()&&!options?.access.capability?t('Read-only view: reopen with rig-review open to edit.'):'';
    actBar.refresh();
  }
  function renderSource():void {
    const panel=leftPanels.source,data=current;panel.replaceChildren();
    const section=panelMake('section',{className:'provenance'});section.setAttribute('aria-label',t('Reviewed source'));
    const rowOf=(label:string,value:string,code=false)=>{const out=panelMake('div',{className:'provenance-row'});out.append(panelMake('span',{textContent:label}),panelMake(code?'code':'strong',{textContent:value}));return out;};
    section.append(panelMake('div',{className:'eyebrow',textContent:t('REVIEWED SOURCE')}));
    const revision=options?.revision?.()??null;
    if(revision)section.append(rowOf(t('Package revision'),revision));
    if(data){
      section.append(rowOf(t('Source SHA-256'),data.sourceHash,true));
      if(data.inspectionSourceHash&&data.inspectionSourceHash!==data.sourceHash)section.append(rowOf(t('Inspection source SHA-256'),data.inspectionSourceHash,true));
      const full=panelMake('details');full.append(panelMake('summary',{textContent:t('Full provenance')}),panelMake('pre',{textContent:JSON.stringify({title:data.title,mode:data.mode,sourceHash:data.sourceHash,...data.inspectionSourceHash?{inspectionSourceHash:data.inspectionSourceHash}:{},verdictFile:data.verdictFile,...data.draft?{draft:{label:data.draft.label,buildId:data.draft.buildId}}:{}},null,2)}));
      section.append(full);
    }
    section.append(panelMake('p',{className:'hint',textContent:t('No job source binding: this package was opened directly, so there is no source history.')}));
    panel.append(section);
  }
  renderSource();

  const regions={left:leftPanels.parts,stage,toolbar,secondary,flags:bottomPanels.flags,mesh:bottomPanels.mesh,comments:bottomPanels.comments,legacy:leftPanels.legacy,status,
    legacyCount(count:number){legacyCount=count;legacyTab.hidden=count===0;legacyTab.textContent=leftLabels.legacy();},
    commentCount(count:number){commentCount=count;bottomTabs.find(tab=>tab.id==='comments')!.button.textContent=bottomLabels.comments();syncActions();},
    correction(request:{part:string;sourceHash:string;buildId:string;instrument:string}){options?.correction?.(request);}};

  const mount=()=>{
    if(mounted||!options)return;
    mountedBuild=options.transport.kind==='stage'?options.transport.build():'inspected';
    mounted=mountPartsWorkspace(regions,source,host,{defaultView:'item',embedded:embedded()});
    void mounted.ready.then(()=>{if(!disposed){syncActions();doc.body.dataset.ready='true';}},error=>{
      if(disposed)return;const load=status.querySelector<HTMLElement>('#pv-load');
      if(load){load.dataset.result='refused';load.textContent=t(error instanceof Error?error.message:'PARTS_PAINT_FAILED');}
    });
  };
  return {
    start(value){if(options)return;options=value;if(active)mount();renderSource();},
    show(next,note){
      active=next;setHidden(!next);syncActions();
      if(next&&!mounted)mount();
      else if(next&&mounted){
        const build=options?.transport.kind==='stage'?options.transport.build():'inspected';
        if(build!==mountedBuild){const saved=mounted.snapshot();mountedBuild=build;void mounted.revalidate(saved).then(syncActions);}
      }
      const noteNode=status.querySelector<HTMLElement>('#pv-stage-note')??status.appendChild(panelMake('span',{id:'pv-stage-note',className:'hint'}));
      noteNode.textContent=note?t(note):'';
    },
    snapshot:()=>mounted?.snapshot()??null,
    restore:saved=>mounted?mounted.restore(saved):Promise.resolve(),
    workspace:()=>mounted,
    dispose(){
      if(disposed)return;disposed=true;mounted?.dispose();
      for(const dispose of disposers.splice(0))dispose();for(const cancel of pendingImages)cancel();
      for(const objectUrl of objectUrls)URL.revokeObjectURL(objectUrl);objectUrls.clear();
    },
  };
}
