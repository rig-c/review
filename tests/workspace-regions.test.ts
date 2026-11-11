import {expect,test} from 'bun:test';
import {mountStatusBar} from '../web/workspace-ui.ts';
import {applyDomI18n,getLanguagePreference,getLinkLanguage,setLanguagePreference,setLinkLanguage} from '../web/i18n.ts';
import {statusDom,mountedRigStatus,originalRigStatus,statusDomSnapshot} from './helpers/workspace-status-dom.ts';
import {mountViewportPair,viewportPairMarkup} from '../web/viewport-pair.ts';

test('#678 C11 uses supplied node identities, live message semantics and ordered readouts without HTML parsing',async()=>{
 const {doc}=await statusDom(),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
 try{
  const first=doc.createElement('span'),second=doc.createElement('span'),source=doc.createElement('div');
  const bar=mountStatusBar({message:'<b>Loading inputs…</b>',readouts:[first,second],source});
  expect(bar.footer.tagName).toBe('FOOTER');expect(bar.footer.className).toBe('status-bar');
  expect(bar.message.textContent).toBe('<b>Loading inputs…</b>');expect(bar.message.children).toEqual([]);
  expect(bar.message.getAttribute('role')).toBe('status');expect(bar.message.getAttribute('aria-live')).toBe('polite');
  expect(bar.footer.children[0]).toBe(bar.message);expect(bar.footer.children[1].children).toEqual([first,second]);expect(bar.footer.children[2]).toBe(source);
  const node=doc.createElement('span'),custom=mountStatusBar({message:node,readouts:[]});expect(custom.message).toBe(node);expect(custom.footer.children.length).toBe(2);
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});

test('#678 actual rig mount preserves the original raw footer DOM, attributes, order and text in EN and KO',async()=>{
 const preference=getLanguagePreference(),link=getLinkLanguage();
 try{
  for(const language of ['en','ko'] as const){
   setLinkLanguage(null);setLanguagePreference(language);
   const original=await originalRigStatus(),mounted=await mountedRigStatus();
   expect(statusDomSnapshot(mounted.footer)).toEqual(statusDomSnapshot(original.footer));
   applyDomI18n(original.root);applyDomI18n(mounted.root);
   expect(statusDomSnapshot(mounted.footer)).toEqual(statusDomSnapshot(original.footer));
   expect(mounted.footer.querySelectorAll('*').filter((node:any)=>node.id).map((node:any)=>node.id)).toEqual(['message','player-state','layout-state','renderer-state','layer-state','idle-state','control-state','draft-state','draft-recovery','view-coordinates','source-hash']);
  }
 }finally{setLinkLanguage(link);setLanguagePreference(preference);}
});

test('#678 caller caption is mounted immediately below the main view and unused footer leaves rig untouched',()=>{
 const captions:HTMLElement[]=[],host={innerHTML:'',after:(node:HTMLElement)=>captions.push(node)};
 mountViewportPair(host as unknown as HTMLElement);expect(host.innerHTML).toBe(viewportPairMarkup);expect(captions).toEqual([]);
 const footer={textContent:'Generated rig · read only'} as HTMLElement;
 mountViewportPair(host as unknown as HTMLElement,{footer});
 expect(host.innerHTML).toBe(viewportPairMarkup);expect(captions).toEqual([footer]);expect(captions[0]).toBe(footer);
});
