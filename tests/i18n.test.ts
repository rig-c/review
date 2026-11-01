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

 // Every exemption has a non-empty reason, including the #276 stage-comments exemptions.
 expect(WEB_STRING_EXEMPTIONS.length).toBeGreaterThan(0);
 for(const exemption of WEB_STRING_EXEMPTIONS){
  expect(exemption.reason.trim().length).toBeGreaterThan(10);
 }
 expect(WEB_STRING_EXEMPTIONS.some(e=>e.file==='web/stage-comments.ts'&&e.reason.includes('#276'))).toBe(true);
 expect(WEB_STRING_EXEMPTIONS.some(e=>e.file==='web/index.html'&&e.match.includes('Comment')&&e.reason.includes('#276'))).toBe(true);
 expect(WEB_STRING_EXEMPTIONS.some(e=>e.file==='web/compare.html'&&e.match.includes('Comment')&&e.reason.includes('#276'))).toBe(true);

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
