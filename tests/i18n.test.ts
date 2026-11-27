import {setSourceText} from '../web/i18n.ts';
import {rigWorkspaceMarkup,rigReviewDialogMarkup,rigLayerControlsMarkup,sharedViewToolsMarkup,sharedCommentMarkup,legacyCompareHeaderContent} from '../src/compare-html.ts';
import {entryHtml} from '../src/build.ts';
import {compareWorkspaceMarkup} from '../web/compare-markup.ts';
import {expect,test} from 'bun:test';
import {readdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {feedbackItemComments,feedbackTimingLabel,hasStageComment,projectComments,timeOnlyBasis} from '../src/stage-comment.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {interviewPicksRecord} from '../web/interview-panel.ts';
import {jobSubmissionRefusal} from '../web/job-session.ts';
import {joinProject} from '../src/joined-project.ts';
import {digest} from '../src/interview-project.ts';
import {savePicks} from '../src/interview-picks.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {
 WEB_STRING_EXEMPTIONS,
 applyDomI18n,
 assertCatalogParity,
 checkKoreanDomI18n,
 checkWebHardcodedStrings,
 classifyKoreanDomString,
 getLanguage,
 getLanguagePreference,
 getLinkLanguage,
 languageFromSearch,
 resolveLanguage,
 setLanguagePreference,
 setSourceAttribute,
 setLinkLanguage,
 sourceTextContent,
 t,
 tr,
} from '../web/i18n.ts';
import {loadReferencedReview} from '../src/reference.ts';
import {freshSession,saveSession,readSession,sessionFile} from '../src/session.ts';
import {readFeedbackSession} from '../src/session-history.ts';
import {commentCropPaths} from '../src/comment-crops.ts';
import {feedbackWithCommentGroups,formatFeedbackIssues} from '../src/feedback-export.ts';
import {bindStageComments} from '../web/stage-comments.ts';

test('#839 Korean saved readback aliases use the requested conversational ending',()=>{
 for(const key of ['Human action saved.','job.saved']){
  expect(koCatalog[key]).toBe('사용자 작업을 저장했어요.');
  expect(enCatalog[key]).toBe('Human action saved.');
 }
});

test('#788 Setup and historical still refusals retain paired EN/KO messages without exemptions',()=>{
 for(const code of ['JOB_STILL_CAMERA_NOT_FIXED','JOB_STILL_VIEW_UNSUPPORTED','JOB_STILL_BINDING_MISMATCH','JOB_ACT_NOTHING_TO_SUBMIT','Record checkpoint notes and outcomes.','PARTS_VERDICT_READ_ONLY: a pending parts review and an explicit verdict output directory are required.'])for(const catalog of [enCatalog,koCatalog]) {
  expect(catalog[code]).toBeUndefined();
 }
 for(const code of ['job.submit.JOB_STILL_BINDING_MISMATCH','job.submit.JOB_ACT_NOTHING_TO_SUBMIT'])for(const catalog of [enCatalog,koCatalog]) {
  expect(catalog[code]).toBeUndefined();
 }
 expect(enCatalog['job.refusal.JOB_MODEL_MISSING']).toBe('This request has no compiled model.');
 expect(koCatalog['job.refusal.JOB_MODEL_MISSING']).toBe('이 요청에는 컴파일된 모델이 없어요.');
 expect(legacyCompareHeaderContent.actions).toContain('<button id="submit" class="primary" disabled>Send comments</button>');
 for(const code of ['JOB_STILL_CAPTURE_FAILED',
  'JOB_STILL_UNAVAILABLE','JOB_STILL_OUTPUT_FAILED']) {
  expect(enCatalog[code]).toBeDefined();expect(koCatalog[code]).toBeDefined();
  expect(enCatalog[code]!.startsWith(code+' · ')).toBe(true);
  expect(koCatalog[code]!.startsWith(code+' · ')).toBe(true);
  expect(t(code,undefined,'en')).toBe(enCatalog[code]);
  expect(t(code,undefined,'ko')).toBe(koCatalog[code]);
  expect(koCatalog[code]).toMatch(/[가-힣]/);
 }
 expect(WEB_STRING_EXEMPTIONS.some(row=>row.file==='web/job-rig-capture.ts')).toBe(false);
});

for(const [language,catalog] of [['en',enCatalog],['ko',koCatalog]] as const){
 test(`#1166 historical still refusal codes retain specific ${language} copy`,()=>{
  const previous=getLanguagePreference();
  try{
   setLanguagePreference(language);
   const codes=['JOB_STILL_CAMERA_NOT_FIXED','JOB_STILL_VIEW_UNSUPPORTED'];
   expect(codes.map(code=>jobSubmissionRefusal(new Error(code)).text)).toEqual(codes.map(code=>
    catalog['Review was not submitted: {0}']!.replace('{0}',catalog['job.submit.'+code]??code)));
   expect(jobSubmissionRefusal(new Error('JOB_ACT_NOTHING_TO_SUBMIT'))).toMatchObject({
    code:'JOB_ACT_NOTHING_TO_SUBMIT',
    text:catalog['Review was not submitted: {0}']!.replace('{0}',catalog['No comments yet.']!),
   });
  }finally{setLanguagePreference(previous);}
 });
}

test('Korean catalogue calls a comment 코멘트 everywhere and never 댓글',()=>{
 expect(Object.values(koCatalog).filter(value=>value.includes('댓글'))).toEqual([]);
 expect(Object.values({...koCatalog,planted:'이 댓글'}).filter(value=>value.includes('댓글'))).toEqual(['이 댓글']);
});

test('Bar 1: English and Korean catalogues hold the exact same key and placeholder set, and a planted missing key fails it',()=>{
 expect(()=>assertCatalogParity(enCatalog,koCatalog)).not.toThrow();
 expect(Object.keys(enCatalog).length).toBe(Object.keys(koCatalog).length);

 // Planted missing key in Korean catalogue must fail the parity check.
 const missingKo={...koCatalog} as Record<string,string>;
 delete missingKo['Write review'];
 expect(()=>assertCatalogParity(enCatalog,missingKo)).toThrow('CATALOG_MISSING_KEY: koCatalog is missing key "Write review"');

 // Planted extra key in Korean catalogue must fail the parity check.
 const extraKo={...koCatalog,'Planted extra key':'심어진 추가 키'};
 expect(()=>assertCatalogParity(enCatalog,extraKo)).toThrow('CATALOG_EXTRA_KEY: koCatalog has key absent from enCatalog: "Planted extra key"');

 // Planted placeholder mismatch must fail the parity check.
 const brokenPlaceholderKo={...koCatalog,'Resize {0}':'크기 조절'};
 expect(()=>assertCatalogParity(enCatalog,brokenPlaceholderKo)).toThrow('CATALOG_PLACEHOLDER_MISMATCH: key "Resize {0}"');
});

test('Bar 2: checkWebHardcodedStrings passes on web/, lists every exemption with its reason, and catches planted hardcoded strings',async()=>{
 const webDir=new URL('../web/',import.meta.url);
 const entries=await readdir(webDir);
 const files:Array<{path:string;content:string}>=[];
 const compareHtmlPath='web/compare-markup.ts#inline.html';
 for(const name of entries.sort()){
  if(name==='compare-markup.ts'){
   const entry=await entryHtml('compare');
   files.push({path:compareHtmlPath,content:entry.replace('</body>',()=>compareWorkspaceMarkup+'</body>')});
  }else if(name.endsWith('.html')||name.endsWith('.ts')){
   files.push({path:`web/${name}`,content:await readFile(new URL(name,webDir),'utf8')+(name==='index.html'?rigWorkspaceMarkup+rigReviewDialogMarkup+rigLayerControlsMarkup+sharedViewToolsMarkup+sharedCommentMarkup:'')});
  }
 }
 const clean=checkWebHardcodedStrings(files);
 expect(clean.ok).toBe(true);
 expect(clean.violations).toEqual([]);

 // Every exemption has a non-empty reason, and the temporary #276 stage-comments exemptions are removed.
 expect(WEB_STRING_EXEMPTIONS.length).toBeGreaterThan(0);
 for(const exemption of WEB_STRING_EXEMPTIONS){
  expect(exemption.reason.trim().length).toBeGreaterThan(10);
 }
 expect(WEB_STRING_EXEMPTIONS.some(e=>e.file==='web/stage-comments.ts')).toBe(false);
 expect(WEB_STRING_EXEMPTIONS.some(e=>e.match.includes('Comment'))).toBe(false);

 // An exemption without a reason is refused.
 expect(()=>checkWebHardcodedStrings(files,{exemptions:[...WEB_STRING_EXEMPTIONS,{file:'web/main.ts',match:'foo',reason:'   '}]})).toThrow('I18N_EXEMPTION_REASON_REQUIRED');

 // Planted control 1: hardcoded visible text in HTML fails.
 const plantedHtml=files.map(f=>f.path==='web/index.html'?{...f,content:f.content.replace('</body>','<button type="button">Planted hardcoded button label</button></body>')}:f);
 const resHtml=checkWebHardcodedStrings(plantedHtml);
 expect(resHtml.ok).toBe(false);
 expect(resHtml.violations.some(v=>v.file==='web/index.html'&&v.kind==='html-text'&&v.text==='Planted hardcoded button label')).toBe(true);

 // Planted control 2: hardcoded visible attribute in the Compare markup fails.
 const plantedAttr=files.map(f=>f.path===compareHtmlPath?{...f,content:f.content.replace('</footer>','</footer><input aria-label="Planted hardcoded aria label">')}:f);
 const resAttr=checkWebHardcodedStrings(plantedAttr);
 expect(resAttr.ok).toBe(false);
 expect(resAttr.violations.some(v=>v.file===compareHtmlPath&&v.kind==='html-attr'&&v.text==='Planted hardcoded aria label')).toBe(true);

 // Planted control 3: hardcoded visible string literal in TypeScript fails.
 const plantedTs=files.map(f=>f.path==='web/main.ts'?{...f,content:f.content+'\nconst plantedVisibleWarning = "Planted hardcoded status message";\nvoid plantedVisibleWarning;\n'}:f);
 const resTs=checkWebHardcodedStrings(plantedTs);
 expect(resTs.ok).toBe(false);
 expect(resTs.violations.some(v=>v.file==='web/main.ts'&&v.kind==='ts-string'&&v.text==='Planted hardcoded status message')).toBe(true);
});

test('Bar 2 entity decoding: &amp;lt; decodes once to &lt;, while &lt; decodes to < and &amp; to &',()=>{
 const res=checkWebHardcodedStrings([
  {
   path:'web/planted.html',
   content:'<button type="button">Double &amp;lt; escaped</button><button type="button">Single &lt; tag</button><button type="button">Bare &amp; sign</button>',
  },
 ],{catalog:{},exemptions:[]});
 expect(res.ok).toBe(false);
 expect(res.violations.map(v=>v.text)).toEqual([
  'Double &lt; escaped',
  'Single < tag',
  'Bare & sign',
 ]);
});

test('first-visit browser language resolution picks ko for ko* and en for everything else, while explicit preference wins',()=>{
 expect(resolveLanguage('system',{languages:['ko-KR','en-US'],language:'ko-KR'})).toBe('ko');
 expect(resolveLanguage('system',{languages:['ko'],language:'ko'})).toBe('ko');
 expect(resolveLanguage('system',{languages:[],language:'ko-KP'})).toBe('ko');
 expect(resolveLanguage('system',{languages:['en-US','ko-KR'],language:'en-US'})).toBe('en');
 expect(resolveLanguage('system',{languages:['ja-JP'],language:'ja-JP'})).toBe('en');
 expect(resolveLanguage('system',null)).toBe('en');
 expect(resolveLanguage('en',{languages:['ko-KR'],language:'ko-KR'})).toBe('en');
 expect(resolveLanguage('ko',{languages:['en-US'],language:'en-US'})).toBe('ko');
});

test('Bar 4: live language switching updates DOM text, rich hints, attributes, and error details while preserving rig names, comments, edits, selection, and playhead',()=>{
 try{
  setLanguagePreference('en');
  expect(getLanguage()).toBe('en');

  // Error code stays unchanged beside translated detail.
  expect(tr('PREFERENCES_LANGUAGE: expected system, en or ko','ko'))
   .toBe('PREFERENCES_LANGUAGE: system, en 또는 ko여야 해요');
  expect(tr('ANIMATION_BONE_NO_TRACK: unknown bone "root"','ko'))
   .toBe('ANIMATION_BONE_NO_TRACK: 알 수 없는 본 "root"');

  // Stage-comments strings (#276) translate cleanly while keeping error codes intact.
  expect(tr('Comment · C (0)','ko')).toBe('코멘트 · C (0)');
  expect(tr('Comment · C (3)','ko')).toBe('코멘트 · C (3)');
  expect(tr('Read only · Escape closes','ko')).toBe('읽기 전용 · Escape로 닫기');
  expect(tr('Enter saves · Escape cancels','ko')).toBe('Enter로 저장 · Escape로 취소');
  expect(tr('COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build','ko'))
   .toBe('COMMENT_APPLIED_BUILD_UNSUPPORTED: 적용된 임시 빌드에 코멘트를 남기려면 먼저 점검 중인 소스로 돌아가세요');

  // Dynamic templates translate prose while keeping rig bone/slot/animation identifiers intact.
  expect(tr('Select bone root','ko')).toBe('본 root 선택');
  expect(tr('Select bone hair_front','ko')).toBe('본 hair_front 선택');
  expect(tr('Remeshed hair_front: 40 → 42 (remesh.json) · Reset returns to the inspected build','ko'))
   .toBe('hair_front 리메시됨: 40 → 42 (remesh.json) · 초기화 시 점검 중인 빌드로 돌아가요');

  // Build a minimal DOM tree exercising plain text, attributes, rich hint HTML, rig identifiers, reviewer comment, and active controls.
  const attrs=new Map<string,string>([
   ['aria-label','Find slot'],
   ['placeholder','Exact slot name or text'],
   ['title','Zoom out'],
  ]);
  const textNode={nodeType:3,nodeValue:'Write review',parentElement:{tagName:'BUTTON',getAttribute:()=>null}};
  const statusNode={
   nodeType:3,
   nodeValue:'Remeshed hair_front: 40 → 42 (remesh.json) · Reset returns to the inspected build',
   parentElement:{tagName:'SPAN',getAttribute:()=>null},
  };
  const boneOptionNode={
   nodeType:3,
   nodeValue:'root',
   parentElement:{tagName:'OPTION',getAttribute:(n:string)=>n==='value'?'root':null},
  };
  const labelRootNode={
   nodeType:3,
   nodeValue:'root',
   parentElement:{tagName:'LABEL',getAttribute:()=>null},
  };
  const reviewerCommentNode={
   nodeType:3,
   nodeValue:'Keep the clavicle arc softer around frame 14 on the root bone.',
   parentElement:{tagName:'P',getAttribute:()=>null},
  };
  const richHintSource="The selected slot's mesh at the setup pose, each vertex coloured by the weight the compiled model document stores for the picked bone (0 → 1), or by its dominant bone under <strong>Max influence</strong>. An unweighted mesh is its slot's bone at 1.0. Hover a vertex for its stored values. Nothing here edits, applies or records a weight.";
  const richHintEl={
   tagName:'P',
   classList:{contains:(c:string)=>c==='hint'},
   children:[{}],
   innerHTML:richHintSource,
   getAttribute:(n:string)=>n==='class'?'hint':null,
   setAttribute:()=>{},
  };
  const controlEl={
   tagName:'INPUT',
   innerHTML:'',
   value:'customreviewer note in progress',
   selectionStart:4,
   playheadTime:0.625,
   selectedPart:'hair_front',
   getAttribute:(n:string)=>attrs.get(n)??null,
   setAttribute:(n:string,v:string)=>{attrs.set(n,v);},
  };
  const statusEl={
   get textContent(){return statusNode.nodeValue;},
   firstChild:statusNode,
   childNodes:[statusNode],
  };

  const nodes=[textNode,statusNode,boneOptionNode,labelRootNode,reviewerCommentNode];
  const elements=[richHintEl,controlEl];
  const fakeDoc:Record<string,unknown>={
   createTreeWalker:()=>{
    let idx=-1;
    return {
     nextNode:()=>idx+1<nodes.length?nodes[++idx]!:null,
    };
   },
  };
  fakeDoc.documentElement={
   lang:'en',
   ownerDocument:fakeDoc,
   getAttribute:()=>null,
   querySelectorAll:()=>elements,
  };

  setLanguagePreference('ko');
  applyDomI18n(fakeDoc as unknown as Document);

  expect((fakeDoc.documentElement as {lang:string}).lang).toBe('ko');
  expect(textNode.nodeValue).toBe('리뷰 작성');
  expect(statusNode.nodeValue).toBe('hair_front 리메시됨: 40 → 42 (remesh.json) · 초기화 시 점검 중인 빌드로 돌아가요');
  // Rig bone identifier in <option value="root"> stays 'root', while <label>root</label> translates.
  expect(boneOptionNode.nodeValue).toBe('root');
  expect(labelRootNode.nodeValue).toBe('루트');
  // Reviewer's own comment stays untouched.
  expect(reviewerCommentNode.nodeValue).toBe('Keep the clavicle arc softer around frame 14 on the root bone.');
  // Rich hint HTML translates.
  expect(richHintEl.innerHTML).toContain('<strong>최대 영향</strong>');
  // Attributes translate.
  expect(attrs.get('aria-label')).toBe('슬롯 찾기');
  expect(attrs.get('placeholder')).toBe('정확한 슬롯 이름 또는 텍스트');
  expect(attrs.get('title')).toBe('축소');
  // Source text recovery still returns the canonical English status string for reconciliation.
  expect(sourceTextContent(statusEl as unknown as Element)).toBe('Remeshed hair_front: 40 → 42 (remesh.json) · Reset returns to the inspected build');
  // Edit state, selection, and playhead remain untouched.
  expect(controlEl.value).toBe('customreviewer note in progress');
  expect(controlEl.selectionStart).toBe(4);
  expect(controlEl.playheadTime).toBe(0.625);
  expect(controlEl.selectedPart).toBe('hair_front');

  // Switching back to English restores every English string without reload.
  setLanguagePreference('en');
  applyDomI18n(fakeDoc as unknown as Document);
  expect((fakeDoc.documentElement as {lang:string}).lang).toBe('en');
  expect(textNode.nodeValue).toBe('Write review');
  expect(statusNode.nodeValue).toBe('Remeshed hair_front: 40 → 42 (remesh.json) · Reset returns to the inspected build');
  expect(boneOptionNode.nodeValue).toBe('root');
  expect(labelRootNode.nodeValue).toBe('root');
  expect(richHintEl.innerHTML).toBe(richHintSource);
  expect(attrs.get('aria-label')).toBe('Find slot');
  expect(attrs.get('placeholder')).toBe('Exact slot name or text');
  expect(attrs.get('title')).toBe('Zoom out');
 }finally{
  setLanguagePreference('system');
 }
});

test('Bar 6: feedback output (JSON and Issue Markdown) for one reviewed build is byte-identical in en and ko',async()=>{
 const pkg=await loadReferencedReview('examples/demo/review.json');
 const dirEn=await mkdtemp(join(tmpdir(),'rig-review-i18n-en-'));
 const dirKo=await mkdtemp(join(tmpdir(),'rig-review-i18n-ko-'));
 try{
  const buildSession=()=>({
   ...freshSession(pkg),
   status:'changes-requested' as const,
   checkpoints:{
    silhouette:{outcome:'fail' as const,note:'Hanging ring proportion needs refinement.'},
    joints:{outcome:'pass' as const,note:''},
   },
   feedback:[
    {
     id:'fb-1',
     category:'defect' as const,
     summary:'Top ring hinge drifts 2px left of vertical axis.',
     target:{kind:'rig' as const,name:pkg.feedbackCatalog.rig},
     frameStart:0,
     frameEnd:4,
    },
   ],
  });

  const fixedTimestamp='2026-11-02T00:00:00.000Z';

  setLanguagePreference('en');
  const savedEnSession=await saveSession(pkg,buildSession(),dirEn);
  await writeFile(sessionFile(pkg,dirEn),JSON.stringify({...savedEnSession,updatedAt:fixedTimestamp},null,2)+'\n');
  const savedEn=commentCropPaths(await readFeedbackSession(pkg,dirEn),dirEn);
  const jsonEn=JSON.stringify(feedbackWithCommentGroups(savedEn),null,2);
  const issueEn=formatFeedbackIssues(savedEn).trimEnd();

  setLanguagePreference('ko');
  const savedKoSession=await saveSession(pkg,buildSession(),dirKo);
  await writeFile(sessionFile(pkg,dirKo),JSON.stringify({...savedKoSession,updatedAt:fixedTimestamp},null,2)+'\n');
  const savedKo=commentCropPaths(await readFeedbackSession(pkg,dirKo),dirKo);
  const jsonKo=JSON.stringify(feedbackWithCommentGroups(savedKo),null,2);
  const issueKo=formatFeedbackIssues(savedKo).trimEnd();

  expect(jsonKo).toBe(jsonEn);
  expect(issueKo).toBe(issueEn);
  expect(await readSession(pkg,dirKo)).toEqual(await readSession(pkg,dirEn));
 }finally{
  setLanguagePreference('system');
  await rm(dirEn,{recursive:true,force:true});
  await rm(dirKo,{recursive:true,force:true});
 }
});

test('stage comments (#276) switch live between en and ko including hints, refusal note, and toolbar count while preserving open draft and reviewer summary',async()=>{
 class Node {
  children:Node[]=[];parent:Node|null=null;style:any={};dataset:Record<string,string>={};className='';id='';textContent='';title='Comment · C';value='';placeholder='';type='';maxLength=0;hidden=false;disabled=false;readOnly=false;clientWidth=100;clientHeight=100;clientLeft=0;clientTop=0;captured=new Set<number>();attributes=new Map<string,string>();listeners=new Map<string,Function[]>();onclick:Function|null=null;onsubmit:Function|null=null;onkeydown:Function|null=null;
  classList={toggle:()=>{}};
  append(...nodes:Node[]){for(const n of nodes){n.parent=this;this.children.push(n);}}after(...nodes:Node[]){for(const n of nodes){n.parent=this.parent;this.parent?.children.push(n);}}replaceChildren(...nodes:Node[]){this.children=[];this.append(...nodes);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}setAttribute(k:string,v:string){this.attributes.set(k,v);}getAttribute(k:string){return this.attributes.get(k)??null;}closest(){return null;}focus(){}getBoundingClientRect(){return {left:0,top:0};}
  addEventListener(k:string,f:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),f]);}removeEventListener(k:string,f:Function){this.listeners.set(k,(this.listeners.get(k)??[]).filter(fn=>fn!==f));}dispatch(k:string,e:any={}){for(const f of this.listeners.get(k)??[])f(e);}async emit(k:string,e:any={}){await Promise.all((this.listeners.get(k)??[]).map(f=>f(e)));}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);this.dispatch('lostpointercapture',{pointerId:id});}
 }
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
 const sha='a'.repeat(64);
 const camera={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
 const bookmark={schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:sha,rigs:[null]},time:0,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'playback'}};
 const commentRecord={schema:'rig-review-comment/1',mode:'animate',viewport:'rig',frame:{index:0,basis:'producer'},time:0,animation:'idle',sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:50,y:50,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark};
 // Use "Reset" as the reviewer's own summary to prove it is never translated even when matching a catalogue word.
 const feedbackRows:any[]=[{id:'c-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'probe'},category:'defect',summary:'Reset',context:{animation:'idle',time:0,frame:0,comment:commentRecord}}];
 const lockedIds=new Set<string>();
 let refusalReason:string|null=null;
 const toggle=new Node(),toolbar=new Node(),workspace=new Node(),pane=new Node(),doc=new Node() as any,win=new Node(),saved=new Map<string,any>();
 toolbar.append(toggle);
 toolbar.closest=((selector:string)=>selector==='main'?workspace:null) as any;
 doc.createElement=()=>new Node();
 doc.getElementById=(id:string)=>id==='stage-comment'?toggle:null;
 doc.documentElement=new Node();
 for(const [k,v]of Object.entries({document:doc,window:win,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}})){saved.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;}
 setLanguagePreference('en');
 const tool=bindStageComments({
  toolbar:toolbar as any,
  viewports:{rig:pane as any},
  pose:()=>({mode:'animate',camera,frame:{index:0,basis:'producer'},time:0,animation:'idle',turn:null,sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,rig:'probe'}),
  pause:async()=>{},
  bookmark:()=>bookmark,
  restore:async()=>{},
  feedback:()=>feedbackRows,
  locked:id=>lockedIds.has(id),
  add:f=>feedbackRows.push(f),
  changed:()=>{},
  error:()=>{},
  refusal:()=>refusalReason,
  blocked:()=>false,
 });
 try{
  const list=workspace.children.find(n=>n.id==='stage-comment-list')!;
  const refusalNote=toolbar.children.find(n=>n.id==='stage-comment-refusal')!;
  expect(toggle.textContent).toBe('Comment · C (1)');
  expect(toggle.title).toBe('Comment · C');

  // Open existing comment in composer and type an in-progress draft edit.
  const rowBtn=list.children.find(n=>n.className==='stage-comment-item')!.children[0]!;
  expect(rowBtn.textContent).toContain('· Reset');
  await rowBtn.onclick!();
  const composer=pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  expect(composer.children[1]!.textContent).toBe('Enter saves · Escape cancels');
  expect(composer.children.find(n=>n.className==='stage-comment-delete')!.textContent).toBe('Delete');
  composer.children[0]!.value='In-progress draft note';

  // Switch live to Korean: composer stays open, draft text is untouched, UI chrome and pin aria-label translate, while reviewer summary "Reset" stays untouched.
  setLanguagePreference('ko');
  expect(toggle.textContent).toBe('코멘트 · C (1)');
  expect(toggle.title).toBe('코멘트 · C');
  expect(list.getAttribute('aria-label')).toBe('코멘트');
  expect(list.children[0]!.textContent).toBe('코멘트');
  expect(composer.getAttribute('aria-label')).toBe('코멘트 작성기');
  expect(composer.children[0]!.getAttribute('aria-label')).toBe('코멘트 내용');
  expect(composer.children[0]!.placeholder).toBe('이 지점에 대해 설명하세요…');
  expect(composer.children[0]!.value).toBe('In-progress draft note');
  expect(composer.children[1]!.textContent).toBe('Enter로 저장 · Escape로 취소');
  expect(composer.children.find(n=>n.className==='stage-comment-delete')!.textContent).toBe('삭제');
  const koRowBtn=list.children.find(n=>n.className==='stage-comment-item')!.children[0]!;
  expect(koRowBtn.textContent).toEndWith('· Reset');
  const pin=pane.children[0]!.children[1]!;
  expect(pin.getAttribute('aria-label')).toBe('코멘트 1: Reset');
  expect(pin.title).toBe('Reset');

  // Lock comment and trigger refusal note: verify read-only hint and refusal note translate between ko and en.
  lockedIds.add('c-1');
  refusalReason='COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build';
  await koRowBtn.onclick!();
  const roComposer=pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  expect(roComposer.children[1]!.textContent).toBe('읽기 전용 · Escape로 닫기');
  expect(refusalNote.textContent).toBe('COMMENT_APPLIED_BUILD_UNSUPPORTED: 적용된 임시 빌드에 코멘트를 남기려면 먼저 점검 중인 소스로 돌아가세요');
  expect(list.children.find(n=>n.className==='stage-comment-refusal-note')!.textContent)
   .toBe('COMMENT_APPLIED_BUILD_UNSUPPORTED: 적용된 임시 빌드에 코멘트를 남기려면 먼저 점검 중인 소스로 돌아가세요');
  expect(list.children.find(n=>n.className==='stage-comment-item')!.children[1]!.textContent).toBe('제출됨');

  setLanguagePreference('en');
  expect(roComposer.children[1]!.textContent).toBe('Read only · Escape closes');
  expect(refusalNote.textContent).toBe('COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build');
  expect(list.children.find(n=>n.className==='stage-comment-item')!.children[1]!.textContent).toBe('Submitted');
 }finally{
  tool.dispose();
  setLanguagePreference('system');
  for(const [k,v]of saved)(globalThis as any)[k]=v;
 }
});

// Minimal DOM tree supporting applyDomI18n (querySelectorAll('*') + createTreeWalker(root, 4)).
class TestTextNode {
 nodeType=3;
 nodeValue:string;
 parentElement:TestElement|null=null;
 constructor(val:string){this.nodeValue=val;}
}
class TestElement {
 nodeType=1;
 tagName:string;
 id='';
 className='';
 hidden=false;
 disabled=false;
 readOnly=false;
 type='';
 value='';
 maxLength=0;
 clientWidth=100;
 clientHeight=100;
 clientLeft=0;
 clientTop=0;
 parentElement:TestElement|null=null;
 ownerDocument:any=null;
 children:TestElement[]=[];
 childNodes:(TestElement|TestTextNode)[]=[];
 attrs=new Map<string,string>();
 style:Record<string,string>={};
 dataset:Record<string,string>={};
 onclick:Function|null=null;
 onsubmit:Function|null=null;
 onkeydown:Function|null=null;
 classList={
  contains:(c:string)=>this.className.split(/\s+/).includes(c),
  toggle:()=>{},
 };
 constructor(tag:string,ownerDoc?:any){
  this.tagName=tag.toUpperCase();
  this.ownerDocument=ownerDoc??null;
 }
 get title():string{return this.attrs.get('title')??'';}
 set title(v:string){if(v)this.attrs.set('title',v);else this.attrs.delete('title');}
 get placeholder():string{return this.attrs.get('placeholder')??'';}
 set placeholder(v:string){if(v)this.attrs.set('placeholder',v);else this.attrs.delete('placeholder');}
 get textContent():string{
  return this.childNodes.map(n=>n.nodeType===3?(n as TestTextNode).nodeValue:(n as TestElement).textContent).join('');
 }
 set textContent(v:string){
  this.children=[];
  this.childNodes=[];
  if(v!==''){
   const tn=new TestTextNode(v);
   tn.parentElement=this;
   this.childNodes.push(tn);
  }
 }
 getAttribute(k:string):string|null{return this.attrs.get(k)??null;}
 setAttribute(k:string,v:string):void{this.attrs.set(k,v);}
 removeAttribute(k:string):void{this.attrs.delete(k);}
 append(...nodes:(TestElement|TestTextNode|string)[]):void{
  for(const raw of nodes){
   const n=typeof raw==='string'?new TestTextNode(raw):raw;
   n.parentElement=this;
   this.childNodes.push(n);
   if(n.nodeType===1)this.children.push(n as TestElement);
  }
 }
 after(...nodes:TestElement[]):void{
  if(!this.parentElement)return;
  this.parentElement.append(...nodes);
 }
 replaceChildren(...nodes:(TestElement|TestTextNode|string)[]):void{
  this.children=[];
  this.childNodes=[];
  this.append(...nodes);
 }
 remove():void{
  if(!this.parentElement)return;
  this.parentElement.children=this.parentElement.children.filter(c=>c!==this);
  this.parentElement.childNodes=this.parentElement.childNodes.filter(c=>c!==this);
 }
 closest(selector:string):TestElement|null{
  const tags=selector.split(',').map(s=>s.trim().toUpperCase());
  let cur:TestElement|null=this;
  while(cur){
   if(tags.includes(cur.tagName))return cur;
   if(selector==='p.hint'&&cur.tagName==='P'&&cur.classList.contains('hint'))return cur;
   if(selector==='main'&&cur.tagName==='MAIN')return cur;
   cur=cur.parentElement;
  }
  return null;
 }
 querySelectorAll(sel:string):TestElement[]{
  const out:TestElement[]=[];
  const walk=(el:TestElement)=>{
   for(const c of el.children){
    if(sel==='*'||c.classList.contains(sel.replace(/^\./,''))||c.tagName===sel.toUpperCase())out.push(c);
    walk(c);
   }
  };
  walk(this);
  return out;
 }
 prepend(...nodes:(TestElement|TestTextNode|string)[]):void{const existing=[...this.childNodes];this.replaceChildren(...nodes,...existing);}
 dispatchEvent(event:Event):boolean{return true;}
 focus():void{}
 getBoundingClientRect(){return {left:0,top:0};}
 addEventListener():void{}
 removeEventListener():void{}
}
function makeTestDoc(){
 const doc:any={};
 const root=new TestElement('HTML',doc);
 doc.documentElement=root;
 doc.createElement=(tag:string)=>new TestElement(tag,doc);
 doc.addEventListener=()=>{};
 doc.removeEventListener=()=>{};
 doc.getElementById=(id:string)=>{
  if(root.id===id)return root;
  return root.querySelectorAll('*').find((e:TestElement)=>e.id===id)??null;
 };
 doc.createTreeWalker=(start:TestElement)=>{
  const textNodes:TestTextNode[]=[];
  const collect=(el:TestElement)=>{
   for(const n of el.childNodes){
    if(n.nodeType===3)textNodes.push(n as TestTextNode);
    else collect(n as TestElement);
   }
  };
  collect(start);
  let idx=-1;
  return {nextNode:()=>idx+1<textNodes.length?textNodes[++idx]!:null};
 };
 return {doc,root};
}

test('Bar 6 reviewer-text surfaces: renderProposals, renderFeedback, stage-comments, checkpoint notes, and finding inputs keep catalogue-matching reviewer text byte-identical in ko while old-code controls fail',async()=>{
 const mainSource=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const compareSource=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const controls=(await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8')).split('export type ThemePreference')[0]!.replaceAll('export const','const');

 // Extract the real renderProposals() from web/main.ts and renderFeedback() from web/compare.ts.
 const rpStart=mainSource.indexOf('function renderProposals(): void {');
 const rpEnd=mainSource.indexOf('\nfunction download(',rpStart);
 expect(rpStart).toBeGreaterThan(0);
 expect(rpEnd).toBeGreaterThan(rpStart);
 const rpSource=mainSource.slice(rpStart,rpEnd).replace('function renderProposals(): void {','function renderProposals() {');

 const rfStart=compareSource.indexOf('function renderFeedback(): void {');
 const rfEnd=compareSource.indexOf('\nfunction download(',rfStart);
 expect(rfStart).toBeGreaterThan(0);
 expect(rfEnd).toBeGreaterThan(rfStart);
 const rfSource=compareSource.slice(rfStart,rfEnd).replace('function renderFeedback(): void {','function renderFeedback() {');

 // Catalogue string that translates to '현재 포즈에서 그려지지 않음' in ko when unexempted.
 const catalogSummary='Not drawn at current pose';
 expect(tr(catalogSummary,'ko')).toBe('현재 포즈에서 그려지지 않음');
 const compoundCatalogSummary='Check · Not drawn at current pose · end';
 expect(tr(compoundCatalogSummary,'ko')).toBe('검사 · 현재 포즈에서 그려지지 않음 · end');
 const catalogTargetName='Idle preview unavailable';
 expect(tr(`defect · slot:${catalogTargetName} · F0–F12`,'ko')).toBe('defect · slot:Idle preview 사용 불가 · F0–F12');

 try{
  setLanguagePreference('ko');

  // --- Surface 1: Single-package renderProposals() in web/main.ts ---
  const runProposalSurface=(fnSource:string,timed=false,lang:'en'|'ko'='ko')=>{
   setLanguagePreference(lang);
   const {doc,root}=makeTestDoc();
   const proposalList=doc.createElement('div');proposalList.id='proposal-list';
   const warnings=doc.createElement('p');warnings.id='feedback-warnings';
   const appliedCheck=doc.createElement('p');appliedCheck.id='feedback-applied-check';
   root.append(proposalList,warnings,appliedCheck);
   const feedbackEntry={
    id:'fb-single-1',
    category:'defect',
    target:{kind:'slot',name:catalogTargetName},
    frameStart:timed?null:0,
    frameEnd:timed?null:12,
    summary:catalogSummary,
    context:{note:compoundCatalogSummary,...(timed?{comment:{frame:null,time:.25,timeBasis:timeOnlyBasis}}:{})},
   };
   const session={feedback:[feedbackEntry],feedbackWarnings:[]};
   const jsSource=new Bun.Transpiler({loader:'ts'}).transformSync(`${controls}\n${fnSource}`);
   const run=new Function('scope',`with(scope){${jsSource}; renderProposals();}`);
   run({
    host:null,
    comments:null,
    rigInspector:{comments:{button:doc.createElement('button')}},setSourceText,
    el:(id:string)=>doc.getElementById(id),
    text:(id:string,v:string)=>{const n=doc.getElementById(id);if(n)n.textContent=v;},
    session,
    appliedCheckRefusal:()=>null,
    document:doc,
    feedbackTimingLabel,hasStageComment,
    submittedBaseline:null,
    markDirty:()=>{},
    updateSavedState:()=>{},
   });
   applyDomI18n(doc as unknown as Document);
   const item=proposalList.children[0]!;
   const heading=item.children[0]!;
   const summarySpan=item.children[1]!;
   const details=item.children[2]!;
   const detailsSummary=details.children[0]!;
   const jsonPre=details.children[1]!;
   const deleteBtn=item.children[3]!;
   return {
    headingText:heading.textContent,
    summaryText:summarySpan.textContent,
    jsonText:jsonPre.textContent,
    expectedJson:JSON.stringify(feedbackEntry,null,2),
    detailsHeadingText:detailsSummary.textContent,
    deleteBtnText:deleteBtn.textContent,
   };
  };

  const actualSingle=runProposalSurface(rpSource);
  expect(actualSingle.summaryText).toBe(catalogSummary);
  expect(actualSingle.headingText).toBe(`defect · slot:${catalogTargetName} · F0–12`);
  expect(actualSingle.jsonText).toBe(actualSingle.expectedJson);
  expect(actualSingle.detailsHeadingText).toBe('저장된 피드백 및 점검 컨텍스트');
  expect(actualSingle.deleteBtnText).toBe('삭제');

  const timingText = {
   en: '0.250 s (seconds basis) · frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)',
   ko: '0.250초 (초 기준) · 프레임을 사용할 수 없음: 현재 시간에 명시적 프로듀서 프레임 인덱스가 없어요 (COMMENT_FRAME_UNAVAILABLE)',
  };
  for(const lang of ['en','ko'] as const){
   const row=runProposalSurface(rpSource,true,lang);
   expect(row.headingText).toBe(`defect · slot:${catalogTargetName} · ${timingText[lang]}`);
   expect(row.summaryText).toBe(catalogSummary);
   expect(row.jsonText).toBe(row.expectedJson);
  }

  // Planted old-code control for Surface 1: unclassed <span> and <strong> as before the fix.
  const oldRpSource=rpSource
   .replace("title.className = 'feedback-heading'; ",'')
   .replace("description.className = 'feedback-summary'; ",'');
  expect(oldRpSource).not.toBe(rpSource);
  const oldSingle=runProposalSurface(oldRpSource);
  expect(oldSingle.summaryText).toBe('현재 포즈에서 그려지지 않음');
  expect(oldSingle.headingText).toBe('defect · slot:Idle preview 사용 불가 · F0–12');

  // --- Surface 2: Compare renderFeedback() in web/compare.ts ---
  const runCompareFeedbackSurface=(fnSource:string)=>{
   const {doc,root}=makeTestDoc();
   const feedbackList=doc.createElement('div');feedbackList.id='feedback-list';
   const warnings=doc.createElement('p');warnings.id='feedback-warnings';
   const appliedCheck=doc.createElement('p');appliedCheck.id='feedback-applied-check';
   root.append(feedbackList,warnings,appliedCheck);
   const feedbackEntry={
    id:'fb-compare-1',
    side:'a',
    category:'defect',
    target:{kind:'slot',name:catalogTargetName},
    frameStart:0,
    frameEnd:12,
    summary:catalogSummary,
    context:{note:compoundCatalogSummary},
   };
   const session={feedback:[feedbackEntry],feedbackWarnings:[]};
   const jsSource=new Bun.Transpiler({loader:'ts'}).transformSync(`${controls}\n${fnSource}`);
   const run=new Function('scope',`with(scope){${jsSource}; renderFeedback();}`);
   run({
    comments:null,
    el:(id:string)=>doc.getElementById(id),
    session,
    appliedCheckRefusal:()=>null,
    document:doc,
    submittedBaseline:null,
    markDirty:()=>{},
    savedState:()=>{},
   });
   applyDomI18n(doc as unknown as Document);
   const row=feedbackList.children[0]!;
   const heading=row.children[0]!;
   const summarySpan=row.children[1]!;
   const details=row.children[2]!;
   const detailsHeading=details.children[0]!;
   const jsonPre=details.children[1]!;
   const deleteBtn=row.children[3]!;
   return {
    headingText:heading.textContent,
    summaryText:summarySpan.textContent,
    jsonText:jsonPre.textContent,
    expectedJson:JSON.stringify(feedbackEntry,null,2),
    detailsHeadingText:detailsHeading.textContent,
    deleteBtnText:deleteBtn.textContent,
   };
  };

  const actualCompare=runCompareFeedbackSurface(rfSource);
  expect(actualCompare.summaryText).toBe(catalogSummary);
  expect(actualCompare.headingText).toBe(`A · defect · slot:${catalogTargetName} · F0–12`);
  expect(actualCompare.jsonText).toBe(actualCompare.expectedJson);
  expect(actualCompare.detailsHeadingText).toBe('저장된 피드백 및 점검 컨텍스트');
  expect(actualCompare.deleteBtnText).toBe('삭제');

  // Planted old-code control for Surface 2: unclassed <span> and <strong> as before the fix.
  const oldRfSource=rfSource
   .replace("title.className = 'feedback-heading'; ",'')
   .replace("summary.className = 'feedback-summary'; ",'');
  expect(oldRfSource).not.toBe(rfSource);
  const oldCompare=runCompareFeedbackSurface(oldRfSource);
  expect(oldCompare.summaryText).toBe('현재 포즈에서 그려지지 않음');
  expect(oldCompare.headingText).toBe('A · defect · slot:Idle preview 사용 불가 · F0–12');

  // --- Surfaces 3, 4, 5: Stage comments drawer row button, pin title/aria-label, and composer input ---
  {
   const {doc,root}=makeTestDoc();
   const main=doc.createElement('main');
   const toolbar=doc.createElement('div');
   const toggle=doc.createElement('button');toggle.id='stage-comment';toggle.title='Comment · C';
   toolbar.append(toggle);
   const pane=doc.createElement('div');pane.clientWidth=100;pane.clientHeight=100;
   main.append(toolbar,pane);
   root.append(main);

   const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
   const sha='b'.repeat(64);
   const camera={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
   const bookmark={schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:sha,rigs:[null]},time:0,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'playback'}};
   const commentRecord={schema:'rig-review-comment/1',mode:'animate' as const,viewport:'rig' as const,frame:{index:0,basis:'producer' as const},time:0,animation:'idle',sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:40,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark};
   const feedbackRows:any[]=[{id:'sc-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'probe'},category:'defect',summary:catalogSummary,context:{animation:'idle',time:0,frame:0,comment:commentRecord}}];

   const savedGlobals=new Map<string,any>();
   for(const [k,v]of Object.entries({document:doc,window:root,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}})){
    savedGlobals.set(k,(globalThis as any)[k]);
    (globalThis as any)[k]=v;
   }
   const tool=bindStageComments({
    toolbar:toolbar as any,
    viewports:{rig:pane as any},
    pose:()=>({mode:'animate',camera,frame:{index:0,basis:'producer'},time:0,animation:'idle',turn:null,sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,rig:'probe'}),
    pause:async()=>{},
    bookmark:()=>bookmark,
    restore:async()=>{},
    feedback:()=>feedbackRows,
    locked:()=>false,
    add:f=>feedbackRows.push(f),
    changed:()=>{},
    error:()=>{},
    refusal:()=>null,
    blocked:()=>false,
   });
   try{
    const list=main.children.find((n:TestElement)=>n.id==='stage-comment-list')!;
    const item=list.children.find((n:TestElement)=>n.className==='stage-comment-item')!;
    const rowBtn=item.children[0]!;
    await rowBtn.onclick!();
    applyDomI18n(doc as unknown as Document);

    // Surface 3: Stage comment drawer row button preserves catalogue-matching summary in ko while localizing the frame basis label (#1026).
    const koItem=list.children.find((n:TestElement)=>n.className==='stage-comment-item')!;
    const koRowBtn=koItem.children[0]!;
    expect(koRowBtn.className).toBe('stage-comment-summary');
    expect(koRowBtn.textContent).toBe(`1 · 애니메이트 · 리그 · F0 (프로듀서) · ${catalogSummary}`);

    // Planted old-code control for Surface 3: unexempt row button gets its trailing summary translated by ' · ' splitting.
    const unexemptRowBtn=doc.createElement('button');
    unexemptRowBtn.textContent=`1 · ANIMATE · RIG · F0 (producer) · ${catalogSummary}`;
    root.append(unexemptRowBtn);
    applyDomI18n(doc as unknown as Document);
    expect(unexemptRowBtn.textContent).toBe('1 · ANIMATE · RIG · F0 (프로듀서) · 현재 포즈에서 그려지지 않음');

    // Surface 4: Stage comment pin title and aria-label preserve catalogue-matching summary in ko.
    const layer=pane.children.find((n:TestElement)=>n.className==='stage-comment-layer')!;
    const pin=layer.children.find((n:TestElement)=>n.className.includes('stage-comment-pin'))!;
    expect(pin.title).toBe(catalogSummary);
    expect(pin.getAttribute('aria-label')).toBe(`코멘트 1: ${catalogSummary}`);

    // Planted old-code control for Surface 4: pin without 'stage-comment-pin' exemption has its title rewritten in ko.
    const unexemptPin=doc.createElement('button');
    unexemptPin.className='stage-comment-ui';
    unexemptPin.title=catalogSummary;
    root.append(unexemptPin);
    applyDomI18n(doc as unknown as Document);
    expect(unexemptPin.title).toBe('현재 포즈에서 그려지지 않음');

    // Surface 5: Stage comment composer input keeps catalogue-matching summary in .value while localizing placeholder/aria-label.
    const composer=pane.children.find((n:TestElement)=>n.className.includes('stage-comment-composer'))!;
    const composerInput=composer.children[0]!;
    expect(composerInput.value).toBe(catalogSummary);
    expect(composerInput.placeholder).toBe('이 지점에 대해 설명하세요…');
    expect(composerInput.getAttribute('aria-label')).toBe('코멘트 내용');

    // Planted old-code control for Surface 5: passing composer summary through tr() in ko rewrites reviewer words.
    expect(tr(composerInput.value,'ko')).toBe('현재 포즈에서 그려지지 않음');
   }finally{
    tool.dispose();
    for(const [k,v]of savedGlobals)(globalThis as any)[k]=v;
   }
  }

  // --- Surface 6: Checkpoint review notes (<textarea id="checkpoint-note">) ---
  {
   const {doc,root}=makeTestDoc();
   const noteArea=doc.createElement('textarea');
   noteArea.id='checkpoint-note';
   noteArea.placeholder='Describe the part, conditions and what looks wrong.';
   noteArea.value=catalogSummary;
   noteArea.textContent=catalogSummary;
   root.append(noteArea);

   applyDomI18n(doc as unknown as Document);
   expect(noteArea.value).toBe(catalogSummary);
   expect(noteArea.textContent).toBe(catalogSummary);
   expect(noteArea.placeholder).toBe('파츠, 조건 및 무엇이 잘못되었는지 설명하세요.');

   // Planted old-code control for Surface 6: an unexempt element holding the same text node is rewritten to ko.
   const unexemptNote=doc.createElement('div');
   unexemptNote.textContent=catalogSummary;
   root.append(unexemptNote);
   applyDomI18n(doc as unknown as Document);
   expect(unexemptNote.textContent).toBe('현재 포즈에서 그려지지 않음');
  }

  // --- Surface 7: Finding form inputs (#feedback-summary, #feedback-target-name, #summary, #target-name) ---
  {
   const {doc,root}=makeTestDoc();
   const singleSummary=doc.createElement('input');singleSummary.id='feedback-summary';singleSummary.placeholder='e.g. The left wrist moves outside the sleeve';singleSummary.value=catalogSummary;
   const singleTarget=doc.createElement('input');singleTarget.id='feedback-target-name';singleTarget.placeholder='Actual bone or slot name';singleTarget.value=catalogSummary;
   const compareSummary=doc.createElement('input');compareSummary.id='summary';compareSummary.placeholder='One-line summary';compareSummary.value=catalogSummary;
   const compareTarget=doc.createElement('input');compareTarget.id='target-name';compareTarget.placeholder='Exact bone, slot or rig name';compareTarget.value=catalogSummary;
   root.append(singleSummary,singleTarget,compareSummary,compareTarget);

   applyDomI18n(doc as unknown as Document);
   expect(singleSummary.value).toBe(catalogSummary);
   expect(singleTarget.value).toBe(catalogSummary);
   expect(compareSummary.value).toBe(catalogSummary);
   expect(compareTarget.value).toBe(catalogSummary);
   expect(singleSummary.placeholder).toBe('예: 왼쪽 손목이 소매 밖으로 벗어남');
   expect(singleTarget.placeholder).toBe('실제 본 또는 슬롯 이름');
   expect(compareSummary.placeholder).toBe('한 줄 요약');
   expect(compareTarget.placeholder).toBe('정확한 본, 슬롯 또는 리그 이름');
  }
 }finally{
  setLanguagePreference('system');
 }
});

test('#294: dynamic compound strings, optional-suffix templates, and cloth/eye-row/idle/rig controls translate cleanly in ko, round-trip to en, and checkKoreanDomI18n catches planted half-translated and untranslated controls',()=>{
 const {doc,root}=makeTestDoc();

 // 1. Eye-row still handle & rig-fields panel
 const rigFields=doc.createElement('section');rigFields.id='rig-fields';
 const rigFieldsState=doc.createElement('p');rigFieldsState.id='rig-fields-state';
 rigFieldsState.textContent='15 regions · blink (0 still rows) · 0 stops · 0 of 23 bones state inherit · turn (0 depths)';
 const regionSelect=doc.createElement('select');regionSelect.id='rig-fields-region';regionSelect.setAttribute('aria-label','regions.brow_l bone');
 const regionOptAll=doc.createElement('option');regionOptAll.value='';regionOptAll.textContent='Pick a rigid part (or select it on the stage)';
 const regionOptShoes=doc.createElement('option');regionOptShoes.value='shoes';regionOptShoes.textContent='shoes · root';
 regionSelect.append(regionOptAll,regionOptShoes);
 const stillSelect=doc.createElement('select');stillSelect.id='rig-fields-still';
 const stillOptEye=doc.createElement('option');stillOptEye.value='eyewhite_l';stillOptEye.textContent='eyewhite_l · no still row';
 stillSelect.append(stillOptEye);
 const inheritSelect=doc.createElement('select');inheritSelect.id='rig-fields-inherit';
 const inheritOptChain=doc.createElement('option');inheritOptChain.value='hairback_r0_';inheritOptChain.textContent='hairback_r0_ (chain) · normal';
 inheritSelect.append(inheritOptChain);
 const eyeHandle=doc.createElement('div');eyeHandle.className='rig-fields-handle';
 eyeHandle.title='eyewhite_l · no still row';
 const eyeLabel=doc.createElement('span');eyeLabel.textContent='eyewhite_l · no still row';
 eyeHandle.append(eyeLabel);
 rigFields.append(rigFieldsState,regionSelect,stillSelect,inheritSelect,eyeHandle);

 // 2. Cloth panel state, tag picker, and all 15 multi-word recipe field labels + 6 single-word field identifiers
 const clothPanel=doc.createElement('section');clothPanel.id='cloth-panel';
 const clothState=doc.createElement('p');clothState.id='cloth-panel-state';
 clothState.textContent='3 tag(s) the installed reader accepts · bottomwear: 0 part(s) (none), 0 chain(s) in the config · built by rig --config · Apply: CLOTH_KEYPOINTS_UNDECLARED: a cloth recipe Apply runs rig-parts propose, which places the body bones from the figure\'s keypoints; without them the draft moves the body bones the config states — declare the keypoint file with rig-review open <dir> --config <path> --keypoints <file> or the review.json "producer" block\'s "keypoints"';
 const clothStateDecl=doc.createElement('p');clothStateDecl.id='cloth-panel-state-declared';
 clothStateDecl.textContent='3 tag(s) the installed reader accepts · back hair: 1 part(s) (hair_back), 2 chain(s) in the config · built by rig --config';
 const clothTag=doc.createElement('select');clothTag.id='cloth-tag';
 const clothTagOpt=doc.createElement('option');clothTagOpt.value='bottomwear';clothTagOpt.textContent='bottomwear (no recipe)';
 clothTag.append(clothTagOpt);
 const clothFields=doc.createElement('div');clothFields.id='cloth-fields';
 const multiWordClothLabels=[
  ['split at','bottomwear 분할 지점(split at)','분할 지점(split at)'],
  ['split into','bottomwear 분할 개수(split into)','분할 개수(split into)'],
  ['hold tip','bottomwear 팁 고정(hold tip)','팁 고정(hold tip)'],
  ['length ratio','bottomwear 길이 비율','길이 비율'],
  ['strength trunk','bottomwear 줄기 강도(strength trunk)','줄기 강도(strength trunk)'],
  ['strength branch','bottomwear 가지 강도(strength branch)','가지 강도(strength branch)'],
  ['strength edge','bottomwear 가장자리 강도(strength edge)','가장자리 강도(strength edge)'],
  ['alternate damping','bottomwear 교차 감쇠(alternate damping)','교차 감쇠(alternate damping)'],
  ['wind [root, tip]','bottomwear 바람 [루트, 팁]','바람 [루트, 팁] *'],
  ['gravity [root, tip]','bottomwear 중력 [루트, 팁]','중력 [루트, 팁] *'],
  ['swing scales','bottomwear 스윙 배율(swing scales)','스윙 배율(swing scales)'],
  ['influence across','bottomwear 가로 영향력(influence across)','가로 영향력(influence across)'],
  ['influence max','bottomwear 최대 영향력(influence max)','최대 영향력(influence max)'],
  ['influence shape','bottomwear 영향 형태(influence shape)','영향 형태(influence shape)'],
  ['influence radius','bottomwear 영향 반경(influence radius)','영향 반경(influence radius)'],
 ] as const;
 const clothFieldNodes:Array<{span:TestElement;ctrl:TestElement;enLabel:string;enSpan:string;koAria:string;koSpan:string}>=[];
 for(const [enLabel,koAria,koSpan]of multiWordClothLabels){
  const lbl=doc.createElement('label');lbl.className='cloth-field';
  const sp=doc.createElement('span');
  const enSpan=enLabel==='wind [root, tip]'||enLabel==='gravity [root, tip]'?`${enLabel} *`:enLabel;
  sp.textContent=enSpan;
  const isSelect=enLabel==='hold tip'||enLabel==='influence across'||enLabel==='influence shape';
  const ctrl=doc.createElement(isSelect?'select':'input');
  ctrl.setAttribute('aria-label',`bottomwear ${enLabel}`);
  lbl.append(sp,ctrl);
  clothFields.append(lbl);
  clothFieldNodes.push({span:sp,ctrl,enLabel,enSpan,koAria,koSpan});
 }
 for(const singleField of ['chains','links','damping','translate','part','parts']){
  const lbl=doc.createElement('label');lbl.className='cloth-field';
  const sp=doc.createElement('span');sp.textContent=singleField==='links'?'links *':singleField;
  const ctrl=doc.createElement('input');ctrl.setAttribute('aria-label',`bottomwear ${singleField}`);
  lbl.append(sp,ctrl);
  clothFields.append(lbl);
 }
 clothPanel.append(clothState,clothStateDecl,clothTag,clothFields);

 // 3. Idle panel blink marker, chain links, and state
 const idlePanel=doc.createElement('section');idlePanel.id='idle-tracks';
 const blinkMarker=doc.createElement('button');blinkMarker.id='idle-blink-marker';
 blinkMarker.title='blink t 2.3 s · drag to move';
 blinkMarker.setAttribute('aria-label','blink t 2.3 s · drag to move');
 const idleState=doc.createElement('p');idleState.id='idle-tracks-state';
 idleState.textContent='4 idle tracks from the handoff config (4 single, 0 chain) · duration 3.33333 s · blink · periods offered: duration / 1…12';
 const idleChainOpt=doc.createElement('option');idleChainOpt.textContent='hairback_r0_ (3 links)';
 const idleChainKeyedOpt=doc.createElement('option');idleChainKeyedOpt.textContent='hairback_r (3 links) · keyed';
 idlePanel.append(blinkMarker,idleState,idleChainOpt,idleChainKeyedOpt);

 // 4. Additional dynamic surfaces across the workspace
 const misc=doc.createElement('section');misc.id='misc-surfaces';
 const reqState=doc.createElement('p');reqState.id='requirements-state';
 reqState.textContent='Rig spec: 42 bones, 19 slots, 6 mesh slot(s), 0 ik/transform constraint(s), 7 animation(s).';
 const handoffLine=doc.createElement('p');handoffLine.id='handoff-line';
 handoffLine.textContent='Handoff declared (open --config): ../../config.json sha256 afa4e7b240c6… · parts .. · baseline: not run — rig-parts rig exited 1 without a named refusal (0.1 s)';
 const lmPrompt=doc.createElement('span');lmPrompt.id='reference-label';
 lmPrompt.textContent='Click the part to place right apex → left apex → cleavage, in that order; drag a marker to move it';
 const turnPadBtn=doc.createElement('button');turnPadBtn.id='turn-pad-body';
 turnPadBtn.title='model slider body_dial → bone body_dial, rotate, animation body_turn (compiled body_turn binding)';
 const selectedPartMeta=doc.createElement('p');selectedPartMeta.id='selected-part';
 selectedPartMeta.textContent='Resolved public attachment: default / hair_back. Declared: default / hair_back (mesh). Drawn page: skeleton.png · sequence 0';
 const boneEditorTitle=doc.createElement('p');boneEditorTitle.id='bones-anchor-editor';
 const boneStrong=doc.createElement('strong');boneStrong.textContent='hip';
 boneEditorTitle.append(boneStrong,' · bone · parent root · bones[0]');
 const physEditorTitle=doc.createElement('p');physEditorTitle.id='physics-row-editor';
 const physStrong=doc.createElement('strong');physStrong.textContent='hairback_r0_phys';
 physEditorTitle.append(physStrong,' · physics · bone hairback_r0 · /constraints/0');
 const cpSpan=doc.createElement('span');cpSpan.id='checkpoints';cpSpan.textContent='Inspect contact.png';
 const refOpt=doc.createElement('option');refOpt.id='reference-select';refOpt.textContent='contact.png · image';
 const refInfo=doc.createElement('div');refInfo.id='reference-info';refInfo.textContent='image · contact.png';
 const rigTimeLabel=doc.createElement('span');rigTimeLabel.id='rig-label';rigTimeLabel.textContent='Generated rig · idle · 0.600 s';
 const timeLabel=doc.createElement('output');timeLabel.id='time-label';timeLabel.textContent='0.0000 / 2.2100 s';
 const meshMaxInf=doc.createElement('input');meshMaxInf.id='mesh-params';meshMaxInf.setAttribute('aria-label','maxInfluences (influences) value');meshMaxInf.placeholder='absent';
 const cutsAdd=doc.createElement('select');cutsAdd.id='cuts-add';
 const cutsFront=doc.createElement('option');cutsFront.value='front';cutsFront.textContent='front';
 const cutsBack=doc.createElement('option');cutsBack.value='back';cutsBack.textContent='back';
 cutsAdd.append(cutsFront,cutsBack);
 const retargetErr=doc.createElement('p');retargetErr.id='retarget-status';
 retargetErr.textContent='RETARGET_PRODUCER_NOT_INSTALLED: @rig-c/pose is not installed beside the package or beside review, and review does not install it — bun add -d @rig-c/pose';
 const chestErr=doc.createElement('p');chestErr.id='chest-status';
 chestErr.textContent='CHEST_REGION_VALUE_INVALID contour tolerance';
 misc.append(reqState,handoffLine,lmPrompt,turnPadBtn,selectedPartMeta,boneEditorTitle,physEditorTitle,cpSpan,refOpt,refInfo,rigTimeLabel,timeLabel,meshMaxInf,cutsAdd,retargetErr,chestErr);

 root.append(rigFields,clothPanel,idlePanel,misc);

 try{
  setLanguagePreference('ko');
  applyDomI18n(doc as unknown as Document);

  // Verify #294 Row 1: eye-row still option & handle
  expect(stillOptEye.textContent).toBe('eyewhite_l · 고정 행 없음');
  expect(eyeHandle.title).toBe('eyewhite_l · 고정 행 없음');
  expect(eyeLabel.textContent).toBe('eyewhite_l · 고정 행 없음');
  expect(rigFieldsState.textContent).toBe('영역 15개 · 눈 깜빡임 (고정 행 0개) · 스톱 0개 · 본 23개 중 0개에 상속 선언됨 · 회전 (깊이 0개)');
  expect(regionOptAll.textContent).toBe('강체 파츠 선택 (또는 스테이지에서 선택)');
  expect(regionOptShoes.textContent).toBe('shoes · root');
  expect(inheritOptChain.textContent).toBe('hairback_r0_ (체인) · normal');

  // Verify #294 Row 2: cloth panel state line
  expect(clothState.textContent).toBe('설치된 리더가 허용하는 태그 3개 · bottomwear: 설정에 파츠 0개 (없음), 체인 0개 · 빌드 방식: rig --config · 적용: CLOTH_KEYPOINTS_UNDECLARED: 천 레시피 적용은 인물의 키포인트로부터 신체 본을 배치하는 rig-parts propose를 실행해요. 키포인트가 없으면 초안이 설정의 신체 본을 이동시키므로 rig-review open <dir> --config <path> --keypoints <file> 또는 review.json "producer" 블록의 "keypoints"로 키포인트 파일을 선언하세요');
  expect(clothStateDecl.textContent).toBe('설치된 리더가 허용하는 태그 3개 · back hair: 설정에 파츠 1개 (hair_back), 체인 2개 · 빌드 방식: rig --config');
  expect(clothTagOpt.textContent).toBe('bottomwear (레시피 없음)');

  // Verify #294 Row 3: all 15 multi-word cloth labels match between visible <span> and control aria-label
  for(const node of clothFieldNodes){
   expect(node.ctrl.getAttribute('aria-label')).toBe(node.koAria);
   expect(node.span.textContent).toBe(node.koSpan);
  }

  // Verify #294 Row 4: idle blink marker and idle tracks state/options
  expect(blinkMarker.title).toBe('눈 깜빡임 t 2.3초 · 드래그하여 이동');
  expect(blinkMarker.getAttribute('aria-label')).toBe('눈 깜빡임 t 2.3초 · 드래그하여 이동');
  expect(idleState.textContent).toBe('핸드오프 설정의 아이들 트랙 4개 (단일 4개, 체인 0개) · 길이 3.33333초 · 눈 깜빡임 · 제공 주기: 길이 / 1…12');
  expect(idleChainOpt.textContent).toBe('hairback_r0_ (링크 3개)');
  expect(idleChainKeyedOpt.textContent).toBe('hairback_r (링크 3개) · 키 설정됨');

  // Verify additional dynamic surfaces
  expect(reqState.textContent).toBe('리그 사양: 본 42개, 슬롯 19개, 메시 슬롯 6개, IK/트랜스폼 제약 조건 0개, 애니메이션 7개.');
  expect(handoffLine.textContent).toBe('핸드오프 선언됨 (open --config): ../../config.json sha256 afa4e7b240c6… · 파츠 .. · 베이스라인: 실행 안 됨 — rig-parts rig이(가) 지정된 거부 사유 없이 종료 코드 1(으)로 종료됨 (0.1초)');
  expect(lmPrompt.textContent).toBe('파츠를 클릭해 오른쪽 끝 → 왼쪽 끝 → 가운데 골 순서로 찍고, 마커는 끌어서 옮겨요');
  expect(turnPadBtn.title).toBe('모델 슬라이더 body_dial → 본 body_dial, rotate, 애니메이션 body_turn (컴파일된 body_turn 바인딩)');
  expect(selectedPartMeta.textContent).toBe('확인된 공개 어태치먼트: default / hair_back. 선언됨: default / hair_back (mesh). 그려진 페이지: skeleton.png · 시퀀스 0');
  expect(boneEditorTitle.textContent).toBe('hip · 본 · 부모 root · bones[0]');
  expect(physEditorTitle.textContent).toBe('hairback_r0_phys · 물리 · 본 hairback_r0 · /constraints/0');
  expect(cpSpan.textContent).toBe('contact.png 점검');
  expect(refOpt.textContent).toBe('contact.png · 이미지');
  expect(refInfo.textContent).toBe('이미지 · contact.png');
  expect(rigTimeLabel.textContent).toBe('생성된 리그 · idle · 0.600초');
  expect(timeLabel.textContent).toBe('0.0000 / 2.2100초');
  expect(meshMaxInf.getAttribute('aria-label')).toBe('최대 영향 수(maxInfluences) 값');
  expect(meshMaxInf.placeholder).toBe('없음');
  expect(cutsFront.textContent).toBe('앞');
  expect(cutsBack.textContent).toBe('뒤');
  expect(retargetErr.textContent).toBe('RETARGET_PRODUCER_NOT_INSTALLED: 패키지 또는 리뷰 옆에 @rig-c/pose가 설치되어 있지 않으며 리뷰가 직접 설치하지 않아요 — bun add -d @rig-c/pose');
  expect(chestErr.textContent).toBe('CHEST_REGION_VALUE_INVALID: 윤곽 허용 오차(contour tolerance)');

  // Full Korean DOM scan must pass with zero violations
  const scanRes=checkKoreanDomI18n(doc as unknown as Document);
  expect(scanRes.violations).toEqual([]);
  expect(scanRes.ok).toBe(true);

  // Planted half-translated and untranslated controls must fail checkKoreanDomI18n
  const plantedWrap=doc.createElement('div');plantedWrap.id='planted-controls';
  const plantedEye=doc.createElement('span');plantedEye.textContent='eyewhite_l · no 고정 행';
  const plantedClothState=doc.createElement('p');plantedClothState.textContent='3 tag(s) the installed reader accepts · 설정에 파츠 bottomwear: 0개';
  const plantedClothInput=doc.createElement('input');plantedClothInput.setAttribute('aria-label','bottomwear split at');
  const plantedClothSelect=doc.createElement('select');plantedClothSelect.setAttribute('aria-label','bottomwear hold 팁');
  const plantedBlink=doc.createElement('button');plantedBlink.title='blink t 2.3 s · drag to move';
  const plantedLabel=doc.createElement('label');plantedLabel.textContent='Planted untranslated control label';
  plantedWrap.append(plantedEye,plantedClothState,plantedClothInput,plantedClothSelect,plantedBlink,plantedLabel);
  root.append(plantedWrap);

  const plantedScan=checkKoreanDomI18n(doc as unknown as Document);
  expect(plantedScan.ok).toBe(false);
  expect(plantedScan.violations.map(v=>`${v.kind}:${v.reason}:${v.text}`)).toEqual([
   'aria-label:untranslated-english:bottomwear split at',
   'aria-label:half-translated:bottomwear hold 팁',
   'title:untranslated-english:blink t 2.3 s · drag to move',
   'text:half-translated:eyewhite_l · no 고정 행',
   'text:half-translated:3 tag(s) the installed reader accepts · 설정에 파츠 bottomwear: 0개',
   'text:untranslated-english:Planted untranslated control label',
  ]);
  expect(classifyKoreanDomString('머리 기준 들어올림(raised by head)')).toBe('ok');

  // Remove planted controls and verify round-trip back to English
  root.children.splice(root.children.indexOf(plantedWrap),1);
  setLanguagePreference('en');
  applyDomI18n(doc as unknown as Document);

  expect(eyeHandle.title).toBe('eyewhite_l · no still row');
  expect(eyeLabel.textContent).toBe('eyewhite_l · no still row');
  expect(clothStateDecl.textContent).toBe('3 tag(s) the installed reader accepts · back hair: 1 part(s) (hair_back), 2 chain(s) in the config · built by rig --config');
  for(const node of clothFieldNodes){
   expect(node.ctrl.getAttribute('aria-label')).toBe(`bottomwear ${node.enLabel}`);
   expect(node.span.textContent).toBe(node.enSpan);
  }
  expect(blinkMarker.title).toBe('blink t 2.3 s · drag to move');
  expect(timeLabel.textContent).toBe('0.0000 / 2.2100 s');
  expect(idleState.textContent).toBe('4 idle tracks from the handoff config (4 single, 0 chain) · duration 3.33333 s · blink · periods offered: duration / 1…12');
 }finally{
  setLanguagePreference('system');
 }
});

test('#294: an attached optional suffix keeps a value that opens with a bare space', ()=>{
 const roundTrips:[string,string][]=[
  ['preview — Apply decides (2 op(s) on idle)','미리보기 — 적용 시 확정됨 (작업 2개 · idle 대상)'],
  ['preview — Apply decides (2 op(s) on idle, tilt)','미리보기 — 적용 시 확정됨 (작업 2개 · idle, tilt 대상)'],
  ['Applying 3 op(s) with @rig-c/parts 2.0.5: rig --config --idle-keys ctl, compile, check…','@rig-c/parts 2.0.5로 작업 3개 적용 중: rig --config --idle-keys ctl, 컴파일, 검사…']
 ];
 for(const [en,ko] of roundTrips){
  expect(tr(en,'ko')).toBe(ko);
  expect(tr(ko,'en')).toBe(en);
 }
});

test('#299: a link forces en or ko over the stored choice and the browser, and stores nothing',()=>{
 expect(languageFromSearch('?input=a&lang=en')).toBe('en');
 expect(languageFromSearch('?lang=ko')).toBe('ko');
 for(const search of ['','?lang=','?lang=fr','?lang=EN','?input=a'])expect(languageFromSearch(search)).toBeNull();
 const korean={languages:['ko-KR'],language:'ko-KR'};
 setLinkLanguage('en');
 expect(setLanguagePreference('ko',korean)).toBe('en');
 expect(setLanguagePreference('system',korean)).toBe('en');
 expect(getLanguagePreference()).toBe('system');
 setLinkLanguage('ko');
 expect(setLanguagePreference('en',{languages:['en-US'],language:'en-US'})).toBe('ko');
 setLinkLanguage(null);
 expect(setLanguagePreference('system',korean)).toBe('ko');
 setLanguagePreference('system',{languages:['en-US'],language:'en-US'});
});


test('unsupported interview kind copy retains its named code and meaning in English and Korean', () => {
 const code = 'INTERVIEW_CONTEXT_KIND_UNSUPPORTED';
 expect(enCatalog[code]).toBe('INTERVIEW_CONTEXT_KIND_UNSUPPORTED: This option context kind is unsupported.');
 expect(koCatalog[code]).toBe('INTERVIEW_CONTEXT_KIND_UNSUPPORTED: 지원하지 않는 선택지 문맥 유형이에요.');
 for (const language of ['en', 'ko'] as const) {
  const message = t(code, undefined, language);
  expect(message).toStartWith(code + ': ');
  expect(message.length).toBeGreaterThan(code.length);
  expect(message).toBe(language === 'en' ? enCatalog[code]! : koCatalog[code]!);
 }
});

test('#764 joined server route preserves planted notes through the real route, picks file and reloaded GET',async()=>{
 const capability='a'.repeat(64),origin='http://127.0.0.1:4321';
 for(const note of ['  planted\r\n원문 👁 e\u0301\n  ','',undefined]){
  const fixture=await interviewOpenFixture();let context:Awaited<ReturnType<typeof createReviewRequestContext>>|undefined;
  try{
   const project=fixture.project,options=JSON.parse(await readFile(join(fixture.root,'evidence/options.json'),'utf8'));
   await writeFile(join(fixture.root,'source.txt'),await readFile(join(fixture.root,'source.svg')));
   project.inputs[0].path='source.txt';options.context.files[0].path='source.txt';
   const optionBytes=JSON.stringify(options)+'\n';await writeFile(join(fixture.root,'evidence/options.json'),optionBytes);
   project.interview.framing[0].pending_options.sha256=digest(optionBytes);
   await writeFile(join(fixture.root,'project.json'),JSON.stringify(project)+'\n');
   const joined=joinProject(null,fixture.inputs.project),question=joined.opened.questions[0]!;
   expect(question.editable).toBe(true);expect(question.images).toHaveLength(0);
   const picks=question.set.asks.map(ask=>({ask:ask.id,option_id:ask.options.find(option=>option.kind==='value')!.id}));
   const record=interviewPicksRecord(question.ref,picks,note,'2026-11-11T00:00:00Z');
   if(note!==undefined)savePicks(join(fixture.root,'picks'),question,record);
   const inputs=['project.json','evidence/options.json','source.txt','source.svg'];
   const baseline=await Promise.all(inputs.map(path=>readFile(join(fixture.root,path))));
   context=await createReviewRequestContext(null,{joined,capability,stateDir:fixture.stateDir,bundle:new Blob(['// synthetic storage test'])});
   const postResponse=await context.handle(new Request(origin+'/api/interview/picks',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':capability},body:JSON.stringify(record),
   }),4321,{} as never);
   expect(postResponse?.status).toBe(200);
   const file=await readFile(join(fixture.root,'picks',question.ref.sha256+'.json'),'utf8'),stored=JSON.parse(file);
   expect(stored.picks).toEqual(picks);expect(Object.hasOwn(stored,'note')).toBe(note!==undefined);expect(stored.note).toBe(note);
   const response=await context.handle(new Request(origin+'/api/interview'),4321,{} as never);
   expect(response?.status).toBe(200);
   const reloaded=(await response!.json()).questions[0].saved;
   expect(Object.hasOwn(reloaded,'note')).toBe(note!==undefined);expect(reloaded.note).toBe(note);
   if(note!==undefined){expect(Buffer.from(stored.note)).toEqual(Buffer.from(note));expect(Buffer.from(reloaded.note)).toEqual(Buffer.from(note));}
   else expect(file).not.toContain('"note":');
   expect(await Promise.all(inputs.map(path=>readFile(join(fixture.root,path))))).toEqual(baseline);
  }finally{context?.stop();await fixture.close();}
 }
});

test('#1230 interview diagnostic and disabled-form refusal codes render in EN/KO', () => {
 const preference = getLanguagePreference();
 try {
  for (const key of [
   'INTERVIEW_OPTIONS_SCENE_LEGACY',
   'INTERVIEW_OPTIONS_STALE',
   'INTERVIEW_PICKS_DISABLED: the interview answer form has been removed; discuss options through live job comments.',
  ] as const) {
   expect(enCatalog[key]).toBeTruthy();
   expect(koCatalog[key]).toMatch(/[가-힣]/);
   for (const language of ['en', 'ko'] as const) {
    setLanguagePreference(language);
    expect(t(key)).toBe(language === 'en' ? enCatalog[key]! : koCatalog[key]!);
   }
   expect(tr(enCatalog[key]!, 'ko')).toBe(koCatalog[key]!);
   expect(tr(koCatalog[key]!, 'en')).toBe(enCatalog[key]!);
  }
 } finally {
  setLanguagePreference(preference);
 }
});

test('parts save provenance and notification refusals translate in EN/KO while preserving dynamic filesystem operation/code details and reviewer words', () => {
 const preference = getLanguagePreference();
 try {
  const staticMessages = [
   'PARTS_VERDICT_INVALID: reviewer name must be nonblank',
   'PARTS_VERDICT_INVALID: saved reviewer name must be nonblank',
   'PARTS_VERDICT_WRITE_FAILED: server is closing',
   'PARTS_VERDICT_WRITE_FAILED: save count exhausted',
   'PARTS_VERDICT_NOTIFY_FAILED: durable save notification failed',
   'PARTS_VERDICT_NOTIFY_FAILED: stdout failed',
   '--by: expected a nonblank reviewer name',
   '--by: launch only; incompatible with export or correction options',
  ] as const;

  for (const enMessage of staticMessages) {
   expect(enCatalog[enMessage]).toBe(enMessage);
   const koMessage = koCatalog[enMessage];
   expect(typeof koMessage).toBe('string');
   expect(koMessage).not.toBe(enMessage);
   expect(koMessage).toMatch(/[가-힣]/);
   const prefix = enMessage.split(':')[0]! + ': ';
   expect(koMessage!.startsWith(prefix)).toBe(true);
   expect(tr(enMessage, 'ko')).toBe(koMessage!);
   expect(tr(koMessage!, 'en')).toBe(enMessage);
  }

  const operations = ['mkdir', 'write/fsync', 'rename', 'directory fsync', 'temporary cleanup'] as const;
  const codes = ['ENOSPC', 'EACCES', 'EPERM', 'IO'] as const;
  for (const operation of operations) {
   for (const code of codes) {
    const enDynamic = `PARTS_VERDICT_WRITE_FAILED: ${operation} (${code})`;
    const koDynamic = tr(enDynamic, 'ko');
    expect(koDynamic).toStartWith('PARTS_VERDICT_WRITE_FAILED: ');
    expect(koDynamic).toMatch(/[가-힣]/);
    expect(koDynamic).toContain(`${operation} (${code})`);
    expect(tr(koDynamic, 'en')).toBe(enDynamic);
   }
  }

  const {doc, root} = makeTestDoc();
  const statusEl = doc.createElement('span');
  statusEl.id = 'pv-save-status';
  statusEl.textContent = 'PARTS_VERDICT_WRITE_FAILED: directory fsync (ENOSPC)';
  const reviewerNoteInput = doc.createElement('textarea');
  reviewerNoteInput.id = 'pv-note';
  reviewerNoteInput.value = 'Alice Kim: keep 2 px bleed around hair_front';
  root.append(statusEl, reviewerNoteInput);

  setLanguagePreference('ko');
  const plantedCheck = checkKoreanDomI18n(doc as unknown as Document);
  expect(plantedCheck.ok).toBe(false);
  expect(plantedCheck.violations.some((v: {text: string}) => v.text.includes('PARTS_VERDICT_WRITE_FAILED: directory fsync (ENOSPC)'))).toBe(true);

  applyDomI18n(doc as unknown as Document);
  expect(statusEl.textContent).toBe(tr('PARTS_VERDICT_WRITE_FAILED: directory fsync (ENOSPC)', 'ko'));
  expect(statusEl.textContent).toContain('directory fsync (ENOSPC)');
  expect(reviewerNoteInput.value).toBe('Alice Kim: keep 2 px bleed around hair_front');
  expect(checkKoreanDomI18n(doc as unknown as Document)).toEqual({ok: true, violations: []});

  setLanguagePreference('en');
  applyDomI18n(doc as unknown as Document);
  expect(statusEl.textContent).toBe('PARTS_VERDICT_WRITE_FAILED: directory fsync (ENOSPC)');
  expect(reviewerNoteInput.value).toBe('Alice Kim: keep 2 px bleed around hair_front');
 } finally {
  setLanguagePreference(preference);
 }
});


test('assembly caption reports the visible part count in both languages', async () => {
 const key = 'Assembled package · {count} visible parts.';
 expect(enCatalog[key]).toBe('Assembled package · {count} visible parts.');
 expect(koCatalog[key]).toBe('조립 패키지 · 파츠 {count}개 표시.');
 expect(enCatalog['Comment · C ({0}) · Rendering']).toBe('Comment · C ({0}) · Rendering');
 expect(koCatalog['Comment · C ({0}) · Rendering']).toBe('코멘트 · C ({0}) · 렌더링 중');
 const source = await readFile(new URL('../web/parts-viewport-provider.ts', import.meta.url), 'utf8');
 expect(source).toContain("t(assembled()?'Assembled parts':'Selected part')");
 expect(enCatalog['Assembled parts']).toBe('Assembled parts');expect(koCatalog['Assembled parts']).toBe('조립된 파츠');
 expect(source).not.toContain('Selection and verdict remain per part.');
});

test('#743 live host notices and act status retain English source and render in EN/KO', async () => {
 const sessionSource = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
 const main = await readFile(new URL('../web/main.ts', import.meta.url), 'utf8');
 const inspector = await readFile(new URL('../web/inspector-blocks.ts', import.meta.url), 'utf8');
 const transpiler = new Bun.Transpiler({loader: 'ts'});
 const live = sessionSource.indexOf('export async function mountJobScreen(');
 const start = sessionSource.indexOf('    const rigScreen=createJobRigScreen(', live);
 const end = sessionSource.indexOf('    let bootstrapNotice:', start);
 expect(start).toBeGreaterThan(live);
 expect(end).toBeLessThan(sessionSource.length);
 // Execute the actual host wiring, rather than supplying an already corrected translator.
 const translate = new Function('createJobRigScreen', 'host', 'pageId', 'access', 'i18n', 't', 'jobWindowRefusal', 'dependencies',
  transpiler.transformSync(sessionSource.slice(start, end)) + ';return rigScreen.translate;')(
   (options: {translate: typeof t}) => options, {}, 'page', {}, {t}, t, String, {});
 const text = main.slice(main.indexOf('const text = '), main.indexOf('const option = '));
 const message = main.slice(main.indexOf('function message('), main.indexOf('async function api<'));
 const saveState = inspector.slice(inspector.indexOf(' const setSaveState='), inspector.indexOf(' return {element,refresh,setSaveState'));
 const cases: {key: string; values?: (string | number)[]; missing?: boolean; status?: 'unsaved' | 'saving' | 'saved'}[] = [
  {key: 'job.updated', values: ['A', 'B']}, {key: 'job.updated', values: ['B', 'C'], missing: true},
  {key: 'job.failed'}, {key: 'job.closed'}, {key: 'job.saved'},
  {key: 'Not submitted', status: 'unsaved'}, {key: 'Sending', status: 'saving'}, {key: 'Submitted', status: 'saved'}
 ];
 const preference = getLanguagePreference(), link = getLinkLanguage();
 try {
  setLinkLanguage(null);
  for (const lang of ['en', 'ko'] as const) {
   setLanguagePreference(lang);
   const {doc, root} = makeTestDoc();
   for (const id of ['message', 'review-message', 'review-draft-state', 'status-copy']) {
    const node = doc.createElement('span'); node.id = id; root.append(node);
   }
   const render = new Function('el', 'setSourceText', 'setSourceAttribute', 'titledIds', 'host',
    transpiler.transformSync(text + message) + ';return message;')(
     (id: string) => doc.getElementById(id), setSourceText, setSourceAttribute, new Set(['message']), {});
   // Use the existing act bar renderer and its copies, through the same source-text writer.
   const renderStatus = new Function('options', 'setSourceText', 'setSourceAttribute',
    transpiler.transformSync('let current=null,retry=null;'+saveState) + ';return setSaveState;')({
     saveState: doc.getElementById('review-draft-state'), saveStateCopies: [{node: doc.getElementById('status-copy'), title: true}]
    }, setSourceText, setSourceAttribute);
   for (const entry of cases) {
    const english = t(entry.key, entry.values, 'en') + (entry.missing ? ' · '+t('job.incompatible', undefined, 'en') : '');
    const expected = t(entry.key, entry.values, lang) + (entry.missing ? ' · '+t('job.incompatible', undefined, lang) : '');
    const value = translate(entry.key, entry.values) + (entry.missing ? ' · '+translate('job.incompatible') : '');
    render(value);
    if (entry.status) renderStatus({kind: entry.status, text: value});
    // Repeated observer sweeps must not reverse a rendered Korean template into a raw key.
    applyDomI18n(doc as unknown as Document); applyDomI18n(doc as unknown as Document);
    for (const id of ['message', 'review-message', ...(entry.status ? ['review-draft-state', 'status-copy'] : [])]) {
     expect(doc.getElementById(id)!.textContent).toBe(expected);
     expect(sourceTextContent(doc.getElementById(id))).toBe(english);
    }
   }
  }
 } finally { setLinkLanguage(link); setLanguagePreference(preference); }
});

test('#739 rig Difference pixel count translates and round-trips in the existing dynamic DOM path',()=>{
 const key='Difference: {0} of {1} pixels differ, compared where the rig draws · rest still vs original painting.';
 const english=t(key,[64,100],'en'),korean=t(key,[64,100],'ko');
 expect(english).toBe('Difference: 64 of 100 pixels differ, compared where the rig draws · rest still vs original painting.');
 expect(korean).toBe('차이: 리그가 그리는 100픽셀 중 64픽셀 다름 · 정지 셋업과 원본 그림.');
 expect(tr(english,'ko')).toBe(korean);expect(tr(korean,'en')).toBe(english);
});

test('#756 translate=no ancestors preserve producer prose, table values and identities while chrome translates',()=>{
 const preference=getLanguagePreference();const {doc,root}=makeTestDoc();
 const raw=new TestElement('section',doc);raw.setAttribute('translate','no');
 const heading=new TestElement('summary',doc);heading.textContent='Frame';heading.title='Zoom out';
 const table=new TestElement('table',doc),head=new TestElement('thead',doc),column=new TestElement('th',doc),body=new TestElement('tbody',doc),cell=new TestElement('td',doc);
 column.textContent='Frame';cell.textContent='Pass';head.append(column);body.append(cell);table.append(head,body);raw.append(heading,table);
 const chrome=new TestElement('button',doc);chrome.textContent='Close';chrome.title='Zoom out';root.append(raw,chrome);
 try{
  for(const language of ['ko','en'] as const){setLanguagePreference(language);applyDomI18n(doc);expect(heading.textContent).toBe('Frame');expect(heading.title).toBe('Zoom out');expect(column.textContent).toBe('Frame');expect(cell.textContent).toBe('Pass');expect(chrome.textContent).toBe(t('Close'));expect(chrome.title).toBe(t('Zoom out'));}
  raw.removeAttribute('translate');setLanguagePreference('ko');applyDomI18n(doc);expect(column.textContent).toBe(t('Frame'));expect(heading.title).toBe(t('Zoom out'));
 }finally{setLanguagePreference(preference);}
});


test('#756 rendered semantic refusals remain idempotent across repeated translation and DOM refresh',()=>{
 const preference=getLanguagePreference();const {doc,root}=makeTestDoc();
 const note=doc.createElement('small');root.append(note);
 try{
  for(const key of ['JOB_REVIEW_READ_ONLY','JOB_STILL_UNAVAILABLE']){
   const english=enCatalog[key]!,korean=koCatalog[key]!;
   expect(tr(english,'ko')).toBe(korean);expect(tr(korean,'en')).toBe(english);
   for(const language of ['ko','en','ko','en'] as const){
    const expected=language==='ko'?korean:english;setLanguagePreference(language);
    note.textContent=t(key);note.title=t(key);
    for(let n=0;n<3;n++){expect(t(note.textContent)).toBe(expected);applyDomI18n(doc);expect(note.textContent).toBe(expected);expect(note.title).toBe(expected);}
   }
  }
 }finally{setLanguagePreference(preference);}
});

test('#1009 provenance rig and motion SHA rows localize Not supplied in KO/EN while keeping supplied hex prefixes untranslated in code',async()=>{
 const mainSource=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const compareSource=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const transpiler=new Bun.Transpiler({loader:'ts'});
 const rpStart=mainSource.indexOf('function renderProvenance(): void {'),rpEnd=mainSource.indexOf('\nfunction renderCheckpoints(',rpStart);
 const partsStart=mainSource.indexOf(' const renderPartsProvenance='),partsEnd=mainSource.indexOf('\n text(\'provenance-full\'',partsStart);
 const reportStart=mainSource.indexOf('function initReport(): void {'),reportEnd=mainSource.indexOf('\nfunction renderReportEvents(',reportStart);
 const cmpStart=compareSource.indexOf('function provenance(): void {'),cmpEnd=compareSource.indexOf('\nfunction renderFeedbackSelection(',cmpStart);
 expect(rpStart).toBeGreaterThan(0);expect(partsStart).toBeGreaterThan(0);expect(reportStart).toBeGreaterThan(0);expect(cmpStart).toBeGreaterThan(0);
 const preference=getLanguagePreference();
 try{
  const makeProvenanceDom=()=>{
   const {doc,root}=makeTestDoc();
   const version=doc.createElement('strong');version.id='provenance-version';
   const rig=doc.createElement('code');rig.id='provenance-rig';
   const motion=doc.createElement('code');motion.id='provenance-motion';
   const missing=doc.createElement('span');missing.id='provenance-motion-missing';missing.textContent='Not supplied';missing.hidden=true;
   const full=doc.createElement('pre');full.id='provenance-full';
   const summary=doc.createElement('span');summary.id='report-summary';
   const browser=doc.createElement('div');browser.id='report-browser';
   const unavail=doc.createElement('p');unavail.id='report-unavailable';
   const brief=doc.createElement('div');brief.id='provenance-brief';
   root.append(version,rig,motion,missing,full,summary,browser,unavail,brief);
   return {doc,version,rig,motion,missing,summary,brief};
  };
  // 1. Parts-verdict job (no rig, no motion): KO shows 제공되지 않음 in both rows, EN shows Not supplied.
  {
   const {doc,version,rig,motion,missing}=makeProvenanceDom();
   const viewDisposers:(()=>void)[]=[];
   const el=(id:string)=>doc.getElementById(id)!;
   const text=(id:string,v:string)=>setSourceText(el(id),v);
   const runParts=new Function('text','el','t','viewDisposers','onLanguageChange','renderProvenance',transpiler.transformSync(mainSource.slice(partsStart,partsEnd)));
   setLanguagePreference('ko');
   runParts(text,el,t,viewDisposers,()=>{},()=>{});
   applyDomI18n(doc as unknown as Document);
   expect(version.textContent).toBe('파츠 패키지, 리깅 전');
   expect(rig.textContent).toBe('제공되지 않음');
   expect(motion.hidden).toBe(true);
   expect(missing.hidden).toBe(false);
   expect(missing.textContent).toBe('제공되지 않음');
   setLanguagePreference('en');
   runParts(text,el,t,viewDisposers,()=>{},()=>{});
   applyDomI18n(doc as unknown as Document);
   expect(version.textContent).toBe('Parts package, before rigging');
   expect(rig.textContent).toBe('Not supplied');
   expect(missing.textContent).toBe('Not supplied');
  }
  // 2. Single-package renderProvenance: missing vs supplied rig/motion SHA, report-summary, and compare provenance-brief.
  {
   const {doc,rig,motion,missing,summary,brief}=makeProvenanceDom();
   const viewDisposers:(()=>void)[]=[];
   const el=(id:string)=>doc.getElementById(id)!;
   const text=(id:string,v:string)=>setSourceText(el(id),v);
   const session:any={sourceHash:'s'.repeat(64),reviewedSource:{packageRevision:'v1',rig:null,motion:null}};
   const data:any={report:null,a:{reviewedSource:{packageRevision:'v1',rig:{sha256:'abcdef0123456789'.padEnd(64,'0')},motion:null}},b:{reviewedSource:{packageRevision:'v2',rig:null,motion:null}},reference:{sha256:'fedcba9876543210'.padEnd(64,'0')}};
   const renderProv=new Function('session','text','el','t','viewDisposers','onLanguageChange',transpiler.transformSync(mainSource.slice(rpStart,rpEnd))+';return renderProvenance;')(session,text,el,t,viewDisposers,()=>{});
   const initRep=new Function('data','el','text',transpiler.transformSync(mainSource.slice(reportStart,reportEnd))+';return initReport;')(data,el,text);
   const runCmp=new Function('el','data','session','document','text',transpiler.transformSync(compareSource.slice(cmpStart,cmpEnd))+';return provenance;')(el,data,{binding:{}},doc,(id:string,v:string)=>{el(id).textContent=v;});
   setLanguagePreference('ko');
   renderProv();initRep();runCmp();
   applyDomI18n(doc as unknown as Document);
   expect(rig.textContent).toBe('제공되지 않음');
   expect(motion.hidden).toBe(true);expect(missing.hidden).toBe(false);expect(missing.textContent).toBe('제공되지 않음');
   expect(summary.textContent).toBe('제공되지 않음');
   expect(brief.children[0]!.textContent).toBe('A · v1 / 리그 abcdef012345 / 모션 제공되지 않음');
   expect(brief.children[1]!.textContent).toBe('B · v2 / 리그 제공되지 않음 / 모션 제공되지 않음');

   // Supplied SHA stays untranslated in <code>
   session.reviewedSource={packageRevision:'v1',rig:{sha256:'abcdef0123456789'.padEnd(64,'0')},motion:{sha256:'1234567890abcdef'.padEnd(64,'0')}};
   renderProv();applyDomI18n(doc as unknown as Document);
   expect(rig.textContent).toBe('abcdef012345…');
   expect(motion.hidden).toBe(false);expect(missing.hidden).toBe(true);expect(motion.textContent).toBe('1234567890ab…');
  }
  // 3. Control that fails on 93280e2: writing raw 'Not supplied' into <code id="provenance-rig"> and <code id="provenance-motion"> leaves English in KO because isExemptElement skips <code> outside p.hint.
  {
   const {doc,rig,motion}=makeProvenanceDom();
   const el=(id:string)=>doc.getElementById(id)!;
   const text=(id:string,v:string)=>setSourceText(el(id),v);
   setLanguagePreference('ko');
   text('provenance-rig','Not supplied');text('provenance-motion','Not supplied');
   applyDomI18n(doc as unknown as Document);
   expect(rig.textContent).toBe('Not supplied');
   expect(motion.textContent).toBe('Not supplied');
  }
 }finally{setLanguagePreference(preference);}
});

test('#1026 stage comment row localizes producer and multi-digit reference frame basis labels in KO while keeping EN, reviewer summary, and act projection byte-identical',()=>{
 const preference=getLanguagePreference();
 const {doc,root}=makeTestDoc();
 const main=doc.createElement('main');
 const toolbar=doc.createElement('div');
 const toggle=doc.createElement('button');toggle.id='stage-comment';toggle.title='Comment · C';
 toolbar.append(toggle);
 const pane=doc.createElement('div');pane.clientWidth=100;pane.clientHeight=100;
 main.append(toolbar,pane);
 root.append(main);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
 const sha='c'.repeat(64);
 const camera={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
 const singleBookmark={schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:sha,rigs:[null]},time:0.166667,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'playback'}};
 const compareBookmark={schema:'rig-review-inspection/1',binding:{mode:'compare',sourceHash:sha,rigs:[null,null]},time:5,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:null,a:camera,b:camera,reference:camera}},selection:{mode:'compare',inspector:'playback'}};
 const producerMark={schema:'rig-review-comment/1' as const,mode:'animate' as const,viewport:'rig' as const,frame:{index:4,basis:'producer' as const},time:0.166667,animation:'idle',sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:40,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:singleBookmark};
 const referenceMark={...producerMark,mode:'compare' as const,viewport:'reference' as const,frame:{index:120,basis:'reference' as const},time:5,bookmark:compareBookmark};
 const reviewerSummary='Not drawn at current pose';
 expect(koCatalog[reviewerSummary]).toBe('현재 포즈에서 그려지지 않음');
 const feedbackRows:any[]=[
  {id:'sc-producer',frameStart:4,frameEnd:4,target:{kind:'rig',name:'probe'},category:'defect',summary:reviewerSummary,context:{animation:'idle',time:0.166667,frame:4,interval:{frameStart:4,frameEnd:4,inclusive:true},comment:producerMark}},
  {id:'sc-reference',frameStart:120,frameEnd:120,target:{kind:'rig',name:'probe'},category:'defect',summary:'Reset',context:{animation:'idle',time:5,frame:null,interval:{frameStart:120,frameEnd:120,inclusive:true},comment:referenceMark}},
 ];
 const expectedSnapshot=JSON.stringify(feedbackRows);
 const expectedProjection=projectComments(feedbackItemComments(feedbackRows));
 const parsedSession:any={schema:'rig-review-session/1',id:'probe',revision:'v1',sourceHash:sha,reviewedSource:{packageRevision:'v1',rig:null,motion:null},referenceBinding:null,status:'changes-requested',updatedAt:'2026-11-20T00:00:00.000Z',checkpoints:{},feedback:feedbackRows,feedbackWarnings:[],historyWarnings:[]};
 const expectedExportJson=JSON.stringify(feedbackWithCommentGroups(parsedSession));
 const expectedExportMd=formatFeedbackIssues(parsedSession);
 expect(expectedExportMd).toContain('- Viewport: rig · frame basis: producer');
 expect(expectedExportMd).toContain('- Viewport: reference · frame basis: reference');
 const savedGlobals=new Map<string,any>();
 for(const [k,v]of Object.entries({document:doc,window:root,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}})){
  savedGlobals.set(k,(globalThis as any)[k]);
  (globalThis as any)[k]=v;
 }
 setLanguagePreference('ko');
 const tool=bindStageComments({
  toolbar:toolbar as any,
  viewports:{rig:pane as any},
  pose:()=>({mode:'animate',camera,frame:{index:4,basis:'producer'},time:0.166667,animation:'idle',turn:null,sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,rig:'probe'}),
  pause:async()=>{},
  bookmark:()=>singleBookmark,
  restore:async()=>{},
  feedback:()=>feedbackRows,
  locked:()=>false,
  add:f=>feedbackRows.push(f),
  changed:()=>{},
  error:()=>{},
  refusal:()=>null,
  blocked:()=>false,
 });
 try{
  const list=main.children.find((n:TestElement)=>n.id==='stage-comment-list')!;
  const rowTexts=()=>list.children.filter((n:TestElement)=>n.className==='stage-comment-item').map((item:TestElement)=>item.children[0]!.textContent);
  applyDomI18n(doc as unknown as Document);
  expect(rowTexts()).toEqual([
   `1 · 애니메이트 · 리그 · F4 (프로듀서) · ${reviewerSummary}`,
   '2 · 비교 · 레퍼런스 · F120 (레퍼런스) · Reset',
  ]);
  expect(JSON.stringify(feedbackRows)).toBe(expectedSnapshot);
  expect(projectComments(feedbackItemComments(feedbackRows))).toBe(expectedProjection);
  expect(JSON.stringify(feedbackWithCommentGroups(parsedSession))).toBe(expectedExportJson);
  expect(formatFeedbackIssues(parsedSession)).toBe(expectedExportMd);

  setLanguagePreference('en');
  applyDomI18n(doc as unknown as Document);
  expect(rowTexts()).toEqual([
   `1 · Animate · Rig · F4 (producer) · ${reviewerSummary}`,
   '2 · Compare · Reference · F120 (reference) · Reset',
  ]);
  expect(JSON.stringify(feedbackRows)).toBe(expectedSnapshot);
  expect(projectComments(feedbackItemComments(feedbackRows))).toBe(expectedProjection);
  expect(JSON.stringify(feedbackWithCommentGroups(parsedSession))).toBe(expectedExportJson);
  expect(formatFeedbackIssues(parsedSession)).toBe(expectedExportMd);
 }finally{
  tool.dispose();
  setLanguagePreference(preference);
  for(const [k,v]of savedGlobals)(globalThis as any)[k]=v;
 }
});

import {createViewportController,createViewportState} from '../web/viewport-controller.ts';
import {createRigViewportProvider} from '../web/rig-viewport-provider.ts';
import {createPartsViewportProvider} from '../web/parts-viewport-provider.ts';
import {createViewControls,inspectionViewSwitch} from '../web/view-controls.ts';

test('#1037 F03: stage comment rows localize mode and viewport in sentence case in KO and EN with no uppercase prefix',async()=>{
 const stageCommentsSource=await readFile(new URL('../web/stage-comments.ts',import.meta.url),'utf8');
 const preference=getLanguagePreference();
 const {doc,root}=makeTestDoc();
 const main=doc.createElement('main'),toolbar=doc.createElement('div'),toggle=doc.createElement('button'),pane=doc.createElement('div');
 toggle.id='stage-comment';toggle.title='Comment · C';pane.clientWidth=100;pane.clientHeight=100;
 toolbar.append(toggle);main.append(toolbar,pane);root.append(main);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
 const sha='d'.repeat(64);
 const camera={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
 const bookmarkFor=(mode:'setup'|'animate'|'compare',viewport:'rig'|'reference')=>({
  schema:'rig-review-inspection/1',
  binding:mode==='compare'?{mode:'compare',sourceHash:sha,rigs:[null,null]}:{mode:'single',sourceHash:sha,rigs:[null]},
  time:0,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},
  view:{schema:'rig-review-view/1',cameras:{rig:viewport==='rig'?camera:null,a:mode==='compare'?camera:null,b:mode==='compare'?camera:null,reference:viewport==='reference'?camera:null}},
  selection:{...(mode==='compare'?{mode:'compare'}:{}),inspector:mode==='setup'?'rig':'playback'},
 });
 const makeRow=(id:string,mode:'setup'|'animate'|'compare',viewport:'rig'|'reference',summary:string)=>({
  id,frameStart:0,frameEnd:0,target:{kind:'rig',name:'probe'},category:'defect',summary,
  context:{animation:'idle',time:0,frame:0,interval:{frameStart:0,frameEnd:0,inclusive:true},comment:{
   schema:'rig-review-comment/1' as const,mode,viewport,frame:{index:0,basis:'producer' as const},time:0,animation:'idle',
   sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:40,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],
   crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:bookmarkFor(mode,viewport),
  }},
 });
 const rows:any[]=[
  makeRow('r1','setup','rig','Setup rig check'),
  makeRow('r2','setup','reference','Setup reference check'),
  makeRow('r3','animate','rig','Animate rig check'),
  makeRow('r4','compare','reference','Compare reference check'),
 ];
 const savedGlobals=new Map<string,any>();
 for(const [k,v]of Object.entries({document:doc,window:root,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}})){
  savedGlobals.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;
 }
 setLanguagePreference('ko');
 const tool=bindStageComments({
  toolbar:toolbar as any,viewports:{rig:pane as any},
  pose:()=>({mode:'setup',camera,frame:{index:0,basis:'producer'},time:0,animation:'idle',turn:null,sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,rig:'probe'}),
  pause:async()=>{},bookmark:()=>bookmarkFor('setup','rig'),restore:async()=>{},feedback:()=>rows,locked:()=>false,add:f=>rows.push(f),changed:()=>{},error:()=>{},refusal:()=>null,blocked:()=>false,
 });
 try{
  const list=main.children.find((n:TestElement)=>n.id==='stage-comment-list')!;
  const readTexts=()=>list.children.filter((n:TestElement)=>n.className==='stage-comment-item').map((item:TestElement)=>item.children[0]!.textContent);
  expect(readTexts()).toEqual([
   '1 · 셋업 · 리그 · F0 (프로듀서) · Setup rig check',
   '2 · 셋업 · 레퍼런스 · F0 (프로듀서) · Setup reference check',
   '3 · 애니메이트 · 리그 · F0 (프로듀서) · Animate rig check',
   '4 · 비교 · 레퍼런스 · F0 (프로듀서) · Compare reference check',
  ]);
  setLanguagePreference('en');
  expect(readTexts()).toEqual([
   '1 · Setup · Rig · F0 (producer) · Setup rig check',
   '2 · Setup · Reference · F0 (producer) · Setup reference check',
   '3 · Animate · Rig · F0 (producer) · Animate rig check',
   '4 · Compare · Reference · F0 (producer) · Compare reference check',
  ]);
  expect(stageCommentsSource).not.toContain('toUpperCase');
 }finally{
  tool.dispose();setLanguagePreference(preference);
  for(const [k,v]of savedGlobals)(globalThis as any)[k]=v;
 }
});

test('#1037 F05: time-only pinned comment row places reviewer text before short Frame unavailable reason and keeps COMMENT_FRAME_UNAVAILABLE in title only while payloads stay unchanged',()=>{
 const preference=getLanguagePreference();
 const {doc,root}=makeTestDoc();
 const main=doc.createElement('main'),toolbar=doc.createElement('div'),toggle=doc.createElement('button'),pane=doc.createElement('div');
 toggle.id='stage-comment';toggle.title='Comment · C';pane.clientWidth=100;pane.clientHeight=100;
 toolbar.append(toggle);main.append(toolbar,pane);root.append(main);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
 const sha='e'.repeat(64);
 const camera={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
 const rawTime=0.8500000000000024;
 const bookmark={schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:sha,rigs:[null]},time:rawTime,animation:'idle',theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'rig'}};
 const timedMark={schema:'rig-review-comment/1' as const,mode:'setup' as const,viewport:'rig' as const,frame:null,timeBasis:timeOnlyBasis,time:rawTime,animation:'idle',sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:40,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark};
 const rows:any[]=[{id:'sc-timed',frameStart:null,frameEnd:null,target:{kind:'rig',name:'probe'},category:'defect',summary:'Pinned cuff note',context:{animation:'idle',time:rawTime,frame:null,interval:null,comment:timedMark}}];
 const expectedPayload=JSON.stringify(rows);
 const parsedSession:any={schema:'rig-review-session/1',id:'probe',revision:'v1',sourceHash:sha,reviewedSource:{packageRevision:'v1',rig:null,motion:null},referenceBinding:null,status:'changes-requested',updatedAt:'2026-11-20T00:00:00.000Z',checkpoints:{},feedback:rows,feedbackWarnings:[],historyWarnings:[]};
 const expectedMd=formatFeedbackIssues(parsedSession);
 expect(expectedMd).toContain('COMMENT&#95;FRAME&#95;UNAVAILABLE');
 const savedGlobals=new Map<string,any>();
 for(const [k,v]of Object.entries({document:doc,window:root,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}})){
  savedGlobals.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;
 }
 setLanguagePreference('ko');
 const tool=bindStageComments({
  toolbar:toolbar as any,viewports:{rig:pane as any},
  pose:()=>({mode:'setup',camera,frame:null,timeBasis:timeOnlyBasis,time:rawTime,animation:'idle',turn:null,sourceHash:sha,modelHash:null,referenceHash:null,referenceId:null,rig:'probe'}),
  pause:async()=>{},bookmark:()=>bookmark,restore:async()=>{},feedback:()=>rows,locked:()=>false,add:f=>rows.push(f),changed:()=>{},error:()=>{},refusal:()=>null,blocked:()=>false,
 });
 try{
  const list=main.children.find((n:TestElement)=>n.id==='stage-comment-list')!;
  const rowBtn=()=>list.children.find((n:TestElement)=>n.className==='stage-comment-item')!.children[0]!;
  expect(rowBtn().textContent).toBe('1 · 셋업 · 리그 · 0.850초 (초 기준) · Pinned cuff note · 프레임을 사용할 수 없음');
  expect(rowBtn().textContent.indexOf('Pinned cuff note')).toBeLessThan(rowBtn().textContent.indexOf('프레임을 사용할 수 없음'));
  expect(rowBtn().textContent).not.toContain('COMMENT_FRAME_UNAVAILABLE');
  expect(rowBtn().title).toBe('프레임을 사용할 수 없음: 이 시간에 명시적 프로듀서 프레임 인덱스가 없어요 (COMMENT_FRAME_UNAVAILABLE)');
  expect(rowBtn().title).toContain('COMMENT_FRAME_UNAVAILABLE');

  setLanguagePreference('en');
  expect(rowBtn().textContent).toBe('1 · Setup · Rig · 0.850 s (seconds basis) · Pinned cuff note · Frame unavailable');
  expect(rowBtn().textContent.indexOf('Pinned cuff note')).toBeLessThan(rowBtn().textContent.indexOf('Frame unavailable'));
  expect(rowBtn().textContent).not.toContain('COMMENT_FRAME_UNAVAILABLE');
  expect(rowBtn().title).toBe('frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)');
  expect(rowBtn().title).toContain('COMMENT_FRAME_UNAVAILABLE');

  expect(JSON.stringify(rows)).toBe(expectedPayload);
  expect(formatFeedbackIssues(parsedSession)).toBe(expectedMd);
 }finally{
  tool.dispose();setLanguagePreference(preference);
  for(const [k,v]of savedGlobals)(globalThis as any)[k]=v;
 }
});

test('#1037 F17: KO catalog drops bracketed English UI labels (grep count 0) while preserving real file, code, and unit brackets',async()=>{
 const koSource=await readFile(new URL('../web/catalog-ko.ts',import.meta.url),'utf8');
 const bracketedUiRe=/": ".*[가-힣][^"]*\((Apply|Reset|REGIONS|Solo|Turn|Idle|[A-Z][a-z]+)\)/;
 const hits=koSource.split('\n').filter(line=>bracketedUiRe.test(line));
 expect(hits).toEqual([]);
 expect(koCatalog['REGIONS']).toBe('영역');
 expect(koCatalog['Gust']).toBe('돌풍');
 expect(koCatalog['Linear']).toBe('선형');
 expect(koCatalog['SEAM PAIR']).toBe('심 쌍');
 expect(koCatalog['Cloth links']).toBe('천 링크');
 expect(koCatalog['Cloth {0}']).toBe('천 {0}');
 // Kept real-name brackets: files, codes, and units stay intact.
 expect(koCatalog['v / t (remesh.json)']).toContain('(remesh.json)');
 expect(koCatalog['{0}: the package supplies no compiled model document (skeleton.model.json); {1} read from it']).toContain('(skeleton.model.json)');
 expect(koCatalog['frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)']).toContain('(COMMENT_FRAME_UNAVAILABLE)');
 expect(koCatalog['how far the silhouette grows before it is traced, px: 0, or 1 or more']).toContain('(px)');
 expect(koCatalog['flip degrees']).toContain('(°)');
});

test('#1037 F13 + R3a: rig and parts viewport providers share one zoom readout shape and interview View switch uses shared view names with no file name',async()=>{
 const preference=getLanguagePreference();
 try{
  const makeProviderDom=()=>{
   const nodes=new Map<string,any>();
   const el=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{id,clientWidth:640,clientHeight:480,hidden:false,checked:true,textContent:'',style:{},setAttribute(){}});
    return nodes.get(id);
   };
   return {nodes,el};
  };
  for(const lang of ['en','ko'] as const){
   setLanguagePreference(lang);
   for(const [active,zoom,targetLabel]of [['rig',1,'Rig'],['reference',16,'Reference']] as const){
    const rigDom=makeProviderDom(),partsDom=makeProviderDom();
    if(active==='reference'){rigDom.el('rig-pane').hidden=true;partsDom.el('rig-pane').hidden=true;}
    const rigState=createViewportState(),partsState=createViewportState();
    rigState.activeCamera=partsState.activeCamera=active;
    rigState.zoom=partsState.zoom=rigState.referenceZoom=partsState.referenceZoom=zoom;
    const rigCtrl=createViewportController(createRigViewportProvider({
     el:rigDom.el,player:()=>({bounds:()=>({x:0,y:0,width:100,height:100}),renderer:{syncPixelRatio(){}}} as any),
     assets:()=>({stage:{x:0,y:0,width:100,height:100}} as any),referenceSize:()=>({width:100,height:100}),
     view:()=>active,referenceGeneration:()=>0,parts:()=>null,
     text:(id,value)=>{rigDom.el(id).textContent=t(value,undefined,lang);},message:()=>{},redrawOverlay:()=>{},
    },rigState),rigState);
    const partsCtrl=createViewportController(createPartsViewportProvider({
     el:partsDom.el,canvas:{width:100,height:100} as HTMLCanvasElement,
     reference:()=>({width:100,height:100} as HTMLCanvasElement),
     frameSize:()=>({w:100,h:100}),message:()=>{},
    },partsState),partsState);
    rigCtrl.renderCameraControls();
    partsCtrl.renderCameraControls();
    const expected=`${Math.round(zoom*100)}% · ${t(targetLabel)}`;
    expect(rigDom.el('zoom-value').textContent).toBe(expected);
    expect(partsDom.el('zoom-value').textContent).toBe(expected);
   }
  }

  // Interview View switch uses shared view names (no file name) for 1 image and numbered Reference {0} for 2+ images, and preserves control order.
  const mainSource=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
  const start=mainSource.indexOf('function syncQuestionImage():void {'),end=mainSource.indexOf('/** Record forms take the record section',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const {doc,root}=makeTestDoc();
  const savedDoc=(globalThis as any).document;
  Object.defineProperty(globalThis,'document',{value:doc,configurable:true});
  try{
   for(const lang of ['en','ko'] as const){
    setLanguagePreference(lang);
    const singleExpected=t('Reference');
    const pairExpected=[t('Reference {0}',[1]),t('Reference {0}',[2])];
    expect(pairExpected[0]).not.toBe(pairExpected[1]);
    for(const [interviewImages,expectedLabels]of [
     [[{name:'reference.png',src:'/img/0'}],[singleExpected]],
     [[{name:'reference.png',src:'/img/0'},{name:'background',src:'/img/1'}],pairExpected],
    ] as const){
     const controls=createViewControls({layout:'rigStep1',viewSwitch:inspectionViewSwitch(()=>{},true)});
     const zoomGroup=controls.zoomGroup as unknown as TestElement;
     root.replaceChildren(zoomGroup);
     expect(zoomGroup.children.map((n:TestElement)=>n.id)).toEqual(['zoom-in','zoom-out','fit','native-one','view-menu','zoom-value']);
     const nodes=new Map<string,any>();
     const el=(id:string)=>{if(!nodes.has(id)){const n=doc.createElement('div');n.id=id;nodes.set(id,n);}return nodes.get(id);};
     const scope:any={
      disposed:false,releaseInterview:null,
      host:{record:{questionPictures:interviewImages.map((image,i)=>({...image,path:`inputs/${i}.png`,sha256:String(i).repeat(64)}))}},
      activeInterviewImages:null,activeInterviewImage:null,
      view:'compare',viewport:{state:createViewportState(),cancelFit(){},bindControls:()=>()=>{},bindNavigation:()=>()=>{}},
      el,button:(id:string)=>el(id),controls,chooseInspectionView(){},
      referenceInput:{state:'absent'},referenceSize:null,referenceGeneration:0,
      video:null,controlledVideoSample:null,sequence:null,sequenceSvg:null,selectedPerson:'',lastPoseFrame:-1,
      unitScaleMessage(){},sourceTextContent:()=>'',message(){},showReference:async()=>{},
      renderLayout(){},workspace:null,fitCamera(){},
     };
     const run=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(mainSource.slice(start,end))};return syncQuestionImage;}`)(scope);
     run();
     const viewSwitch=controls.viewSwitch as unknown as TestElement;
     const viewLabel=viewSwitch.querySelectorAll('*').find((n:TestElement)=>n.id==='view-menu-label')!;
     const itemButtons=viewSwitch.querySelectorAll('button');
     expect(viewLabel.textContent).toBe(expectedLabels[0]);
     expect(itemButtons.map((b:TestElement)=>b.textContent)).toEqual([...expectedLabels]);
     if(itemButtons.length>1)expect(new Set(itemButtons.map((b:TestElement)=>b.textContent)).size).toBe(itemButtons.length);
     expect(itemButtons.map((b:TestElement)=>b.dataset.view)).toEqual(interviewImages.map((_,i)=>`interview-image-${i}`));
     expect(viewSwitch.textContent).not.toContain('reference.png');
     expect(viewSwitch.textContent).not.toContain('background');
    }
   }
  }finally{
   if(savedDoc)Object.defineProperty(globalThis,'document',{value:savedDoc,configurable:true});
   else delete (globalThis as any).document;
  }
 }finally{
  setLanguagePreference(preference);
 }
});

test('#1037 KO catalog uses 레퍼런스 for the noun reference and keeps 참조 only on explicit verb/see entries',()=>{
 const allowedVerbKeys=new Set([
  'Comparison and submission session refer to different source identities. Reopen the review.',
  "Review's pre-check refuses the pending idle (lines above); the producer would refuse it by the same name",
  '{0} physics constraints editable from the handoff config · {1} not editable (reasons below) · {2} chains from bone parentage',
 ]);
 const hits=Object.entries(koCatalog).filter(([,v])=>v.includes('참조')).map(([k])=>k);
 const unexpected=hits.filter(k=>!allowedVerbKeys.has(k));
 expect(unexpected).toEqual([]);
 expect(hits.sort()).toEqual([...allowedVerbKeys].sort());
 expect(t('job.imageRole.reference',undefined,'ko')).toBe(t('Reference',undefined,'ko'));
 expect(tr('1600% · Reference','ko')).toBe(`1600% · ${t('Reference',undefined,'ko')}`);
 expect(tr('reference.png · Reference','ko')).toBe(`reference.png · ${t('Reference',undefined,'ko')}`);
});
