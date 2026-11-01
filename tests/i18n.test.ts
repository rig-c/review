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
 checkKoreanDomI18n,
 checkWebHardcodedStrings,
 classifyKoreanDomString,
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

 // Extract the real renderProposals() from web/main.ts and renderFeedback() from web/compare.ts.
 const rpStart=mainSource.indexOf('function renderProposals(): void {');
 const rpEnd=mainSource.indexOf('\nfunction propose(',rpStart);
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
  const runProposalSurface=(fnSource:string)=>{
   const {doc,root}=makeTestDoc();
   const proposalList=doc.createElement('div');proposalList.id='proposal-list';
   const warnings=doc.createElement('p');warnings.id='feedback-warnings';
   const appliedCheck=doc.createElement('p');appliedCheck.id='feedback-applied-check';
   root.append(proposalList,warnings,appliedCheck);
   const feedbackEntry={
    id:'fb-single-1',
    category:'defect',
    target:{kind:'slot',name:catalogTargetName},
    frameStart:0,
    frameEnd:12,
    summary:catalogSummary,
    context:{note:compoundCatalogSummary},
   };
   const session={feedback:[feedbackEntry],feedbackWarnings:[]};
   const jsSource=new Bun.Transpiler({loader:'ts'}).transformSync(fnSource);
   const run=new Function('scope',`with(scope){${jsSource}; renderProposals();}`);
   run({
    comments:null,
    el:(id:string)=>doc.getElementById(id),
    text:(id:string,v:string)=>{const n=doc.getElementById(id);if(n)n.textContent=v;},
    session,
    appliedCheckRefusal:()=>null,
    document:doc,
    feedbackTimingLabel:(f:any)=>`F${f.frameStart}–F${f.frameEnd}`,
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
  expect(actualSingle.headingText).toBe(`defect · slot:${catalogTargetName} · F0–F12`);
  expect(actualSingle.jsonText).toBe(actualSingle.expectedJson);
  expect(actualSingle.detailsHeadingText).toBe('저장된 피드백 및 점검 컨텍스트');
  expect(actualSingle.deleteBtnText).toBe('삭제');

  // Planted old-code control for Surface 1: unclassed <span> and <strong> as before the fix.
  const oldRpSource=rpSource
   .replace("title.className = 'feedback-heading'; ",'')
   .replace("description.className = 'feedback-summary'; ",'');
  expect(oldRpSource).not.toBe(rpSource);
  const oldSingle=runProposalSurface(oldRpSource);
  expect(oldSingle.summaryText).toBe('현재 포즈에서 그려지지 않음');
  expect(oldSingle.headingText).toBe('defect · slot:Idle preview 사용 불가 · F0–F12');

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
   const jsSource=new Bun.Transpiler({loader:'ts'}).transformSync(fnSource);
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
   const toggle=doc.createElement('button');toggle.id='stage-comment';toggle.title='Comment · C (active mesh editor keeps C)';
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

    // Surface 3: Stage comment drawer row button preserves catalogue-matching summary in ko.
    const koItem=list.children.find((n:TestElement)=>n.className==='stage-comment-item')!;
    const koRowBtn=koItem.children[0]!;
    expect(koRowBtn.className).toBe('stage-comment-summary');
    expect(koRowBtn.textContent).toBe(`1 · ANIMATE · RIG · F0 (producer) · ${catalogSummary}`);

    // Planted old-code control for Surface 3: unexempt row button gets its trailing summary translated by ' · ' splitting.
    const unexemptRowBtn=doc.createElement('button');
    unexemptRowBtn.textContent=`1 · ANIMATE · RIG · F0 (producer) · ${catalogSummary}`;
    root.append(unexemptRowBtn);
    applyDomI18n(doc as unknown as Document);
    expect(unexemptRowBtn.textContent).toBe('1 · ANIMATE · RIG · F0 (producer) · 현재 포즈에서 그려지지 않음');

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
 lmPrompt.textContent='Click the part to place Apex R (then Apex L, Cleavage) · drag a marker to move it';
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
  expect(clothState.textContent).toBe('설치된 리더가 허용하는 태그 3개 · bottomwear: 설정에 파츠 0개 (없음), 체인 0개 · 빌드 방식: rig --config · 적용: CLOTH_KEYPOINTS_UNDECLARED: 천(Cloth) 레시피 적용은 인물의 키포인트로부터 신체 본을 배치하는 rig-parts propose를 실행합니다. 키포인트가 없으면 초안이 설정의 신체 본을 이동시키므로 rig-review open <dir> --config <path> --keypoints <file> 또는 review.json "producer" 블록의 "keypoints"로 키포인트 파일을 선언하세요');
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
  expect(lmPrompt.textContent).toBe('파츠를 클릭하여 우측 정점(Apex R) (다음 왼쪽 정점(Apex L), 골(Cleavage)) 배치 · 마커를 드래그하여 이동');
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
  expect(retargetErr.textContent).toBe('RETARGET_PRODUCER_NOT_INSTALLED: 패키지 또는 리뷰 옆에 @rig-c/pose가 설치되어 있지 않으며 리뷰가 직접 설치하지 않습니다 — bun add -d @rig-c/pose');
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
