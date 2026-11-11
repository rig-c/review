import {readFile} from 'node:fs/promises';
import {mountStatusBar} from '../../web/workspace-ui.ts';
import {panelMake} from '../../web/view-controls.ts';
import {rigWorkspaceMarkup,rigReviewDialogMarkup} from '../../src/compare-html.ts';

/** Reuse the existing i18n DOM host; this helper adds no product renderer or DOM implementation. */
export async function statusDom(){
 const source=await readFile(new URL('../i18n.test.ts',import.meta.url),'utf8');
 const start=source.indexOf('class TestTextNode {'),end=source.indexOf("test('Bar 6 reviewer-text surfaces",start);
 if(start<0||end<start)throw new Error('STATUS_TEST_DOM_HOST_MISSING');
 const make=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end))+';return makeTestDoc;')();
 return make() as {doc:any;root:any};
}
export async function mountedRigStatus(){
 const {doc,root}=await statusDom(),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
 try{
  const source=await readFile(new URL('../../web/main.ts',import.meta.url),'utf8'),start=source.indexOf('const rigStatusBar=mountStatusBar('),end=source.indexOf('const shell=mountWorkspaceShell',start);
  if(start<0||end<start)throw new Error('STATUS_TEST_RIG_MOUNT_MISSING');
  const app={querySelector:()=>({replaceWith:(footer:HTMLElement)=>root.append(footer)})};
  new Function('mountStatusBar','panelMake','app','el',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)))(mountStatusBar,panelMake,app,(id:string)=>doc.getElementById(id));
  return {doc,root,footer:root.children[0]};
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
}
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
/** Generic test-host serialization, never a handwritten footer or application rendering path. */
export function serializeStatusDom(node:any):string {
 if(node.nodeType===3)return escape(node.nodeValue);
 const attrs=new Map<string,string>(node.attrs);if(node.id)attrs.set('id',node.id);if(node.className)attrs.set('class',node.className);
 return '<'+node.tagName.toLowerCase()+[...attrs].map(([name,value])=>' '+name+'="'+escape(value)+'"').join('')+'>'+node.childNodes.map(serializeStatusDom).join('')+'</'+node.tagName.toLowerCase()+'>';
}
export async function composedRigMarkup(){
 const {footer}=await mountedRigStatus();
 return rigWorkspaceMarkup.replace('<div data-workspace-status></div>',serializeStatusDom(footer))+rigReviewDialogMarkup;
}
/** Parses the immutable original footer into the same i18n host for independent DOM comparison. */
export async function originalRigStatus(){
 const {doc,root}=await statusDom(),stack=[root];
 const original=await readFile(new URL('../fixtures/workspace-status/rig-footer.html',import.meta.url),'utf8');
 for(const token of original.match(/<[^>]*>|[^<]+/g)??[]){
  if(token.startsWith('</')){stack.pop();continue;}
  if(token.startsWith('<')){
   const tag=token.match(/^<([a-z0-9-]+)/)![1]!,node=doc.createElement(tag);
   for(const attr of token.matchAll(/([a-z-]+)="([^"]*)"/g)){node.setAttribute(attr[1]!,attr[2]!);if(attr[1]==='id')node.id=attr[2];if(attr[1]==='class')node.className=attr[2];}
   stack.at(-1).append(node);stack.push(node);
  }else stack.at(-1).append(token);
 }
 return {doc,root,footer:root.children[0]};
}
export function statusDomSnapshot(node:any):unknown {
 if(node.nodeType===3)return {text:node.nodeValue};
 const attrs=new Map<string,string>(node.attrs);if(node.id)attrs.set('id',node.id);if(node.className)attrs.set('class',node.className);
 return {tag:node.tagName,attrs:[...attrs].sort(([a],[b])=>a.localeCompare(b)),children:node.childNodes.map(statusDomSnapshot)};
}
