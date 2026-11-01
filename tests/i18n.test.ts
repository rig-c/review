import {expect,test} from 'bun:test';
import {readdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {
 WEB_STRING_EXEMPTIONS,
 applyDomI18n,
 assertCatalogParity,
 checkWebHardcodedStrings,
 getLanguage,
 resolveLanguage,
 setLanguagePreference,
 sourceTextContent,
 tr,
} from '../web/i18n.ts';
import {loadReferencedReview} from '../src/reference.ts';
import {freshSession,saveSession,readSession,sessionFile} from '../src/session.ts';
import {readFeedbackSession} from '../src/session-history.ts';
import {commentCropPaths} from '../src/comment-crops.ts';
import {feedbackWithCommentGroups,formatFeedbackIssues} from '../src/feedback-export.ts';
import {bindStageComments} from '../web/stage-comments.ts';

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
 for(const name of entries.sort()){
  if(name.endsWith('.html')||name.endsWith('.ts')){
   files.push({path:`web/${name}`,content:await readFile(new URL(name,webDir),'utf8')});
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
 const plantedHtml=files.map(f=>f.path==='web/index.html'?{...f,content:f.content.replace('</header>','<button type="button">Planted hardcoded button label</button></header>')}:f);
 const resHtml=checkWebHardcodedStrings(plantedHtml);
 expect(resHtml.ok).toBe(false);
 expect(resHtml.violations.some(v=>v.file==='web/index.html'&&v.kind==='html-text'&&v.text==='Planted hardcoded button label')).toBe(true);

 // Planted control 2: hardcoded visible attribute in HTML fails.
 const plantedAttr=files.map(f=>f.path==='web/compare.html'?{...f,content:f.content.replace('</header>','<input aria-label="Planted hardcoded aria label"></header>')}:f);
 const resAttr=checkWebHardcodedStrings(plantedAttr);
 expect(resAttr.ok).toBe(false);
 expect(resAttr.violations.some(v=>v.file==='web/compare.html'&&v.kind==='html-attr'&&v.text==='Planted hardcoded aria label')).toBe(true);

 // Planted control 3: hardcoded visible string literal in TypeScript fails.
 const plantedTs=files.map(f=>f.path==='web/main.ts'?{...f,content:f.content+'\nconst plantedVisibleWarning = "Planted hardcoded status message";\nvoid plantedVisibleWarning;\n'}:f);
 const resTs=checkWebHardcodedStrings(plantedTs);
 expect(resTs.ok).toBe(false);
 expect(resTs.violations.some(v=>v.file==='web/main.ts'&&v.kind==='ts-string'&&v.text==='Planted hardcoded status message')).toBe(true);
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
   .toBe('PREFERENCES_LANGUAGE: system, en 또는 ko여야 합니다');
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
   .toBe('hair_front 리메시됨: 40 → 42 (remesh.json) · 초기화 시 점검 중인 빌드로 돌아갑니다');

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
  expect(statusNode.nodeValue).toBe('hair_front 리메시됨: 40 → 42 (remesh.json) · 초기화 시 점검 중인 빌드로 돌아갑니다');
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
  children:Node[]=[];parent:Node|null=null;style:any={};dataset:Record<string,string>={};className='';id='';textContent='';title='Comment · C (active mesh editor keeps C)';value='';placeholder='';type='';maxLength=0;hidden=false;disabled=false;readOnly=false;clientWidth=100;clientHeight=100;clientLeft=0;clientTop=0;captured=new Set<number>();attributes=new Map<string,string>();listeners=new Map<string,Function[]>();onclick:Function|null=null;onsubmit:Function|null=null;onkeydown:Function|null=null;
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
  expect(toggle.title).toBe('Comment · C (active mesh editor keeps C)');

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
  expect(toggle.title).toBe('코멘트 · C (활성 메시 편집기가 C 키를 사용함)');
  expect(list.getAttribute('aria-label')).toBe('스테이지 코멘트');
  expect(list.children[0]!.textContent).toBe('코멘트 목록');
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
