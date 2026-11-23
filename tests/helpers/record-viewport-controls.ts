import assert from 'node:assert/strict';
import {clickPartsViewControl as click} from './parts-view-shots.ts';
import type {InputCdpSession} from '../parts-explorer-browser.ts';
import {enCatalog} from '../../web/catalog-en.ts';
import {koCatalog} from '../../web/catalog-ko.ts';

const ids=['zoom-in','zoom-out','fit','native-one','view-menu'];
const selector=ids.map(id=>'#'+id).join(',');
const summary='#view-menu summary';
type Command=(method:string,params:Record<string,unknown>)=>Promise<unknown>;

export async function recordViewportControls(page:InputCdpSession,send:Command,language:'en'|'ko',disabled:boolean){
 const catalog=language==='en'?enCatalog:koCatalog;
 const state=await page.evaluate<{id:string;name:string;disabled:boolean;visible:boolean}[]>(`
 [...document.querySelectorAll('${selector}')].map(node=>{
  const control=node.id==='view-menu'?node.querySelector('summary'):node;
  return {id:node.id,name:(node.id==='view-menu'?control.firstChild.textContent:control.getAttribute('aria-label')||control.textContent).trim(),
   disabled:control.matches(':disabled,[aria-disabled=true]'),visible:control.checkVisibility({opacityProperty:true})};
 })`);
 assert.deepEqual(state,ids.map((id,index)=>({id,name:[catalog['Zoom in'],catalog['Zoom out'],catalog.Fit,'1:1',catalog['View switch']][index],disabled,visible:true})),
  '#1128 five visible viewport controls in stable order and availability');
 assert.equal(await page.evaluate(`document.querySelector('#view-menu').getAttribute('aria-disabled')==='true'`),disabled);
 const press=async(key:string,code=key)=>{
  const virtualKey=({Enter:13,Tab:9,Space:32} as Record<string,number>)[code];
  await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,...key==='Enter'?{text:'\r'}:{}});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey});
 };
 const open=()=>page.evaluate<boolean>("document.querySelector('#view-menu').open");
 if(disabled){
  await click(page,summary);
  assert.equal(await open(),false,'disabled summary rejects pointer activation');
  await page.evaluate(`document.querySelector('${summary}').focus()`);
  for(const [key,code] of [['Enter','Enter'],[' ','Space']]){
   await press(key,code);
   assert.equal(await open(),false,'disabled summary rejects '+code);
  }
  await page.evaluate("document.querySelector('#view-menu').open=true");
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await open(),false,'disabled details closes after a programmatic toggle');
 }else{
  await page.evaluate("document.querySelector('#zoom-in').focus()");
  for(const id of ids.slice(1)){
   await press('Tab');
   assert.equal(await page.evaluate("document.activeElement.closest('#view-menu')?.id ?? document.activeElement.id"),id,'mounted tab order');
  }
  await press('Enter');
  assert.equal(await open(),true,'mounted summary opens from the keyboard');
  await press('Enter');
  assert.equal(await open(),false,'mounted summary closes from the keyboard');
 }
 if(disabled){
  await page.evaluate(`(()=>{
   const group=document.querySelector('.zoom-controls:has(#view-menu)');
   const sentinel=document.createElement('span');sentinel.tabIndex=0;group.before(sentinel);sentinel.focus();
  })()`);
  const focused:string[]=[];
  for(let i=0;i<5;i++){
   await press('Tab');
   focused.push(await page.evaluate("document.activeElement.closest('#view-menu')?.id ?? document.activeElement.id"));
  }
  await page.evaluate("document.querySelector('.zoom-controls:has(#view-menu)').previousElementSibling.remove()");
  assert.ok(focused.every(id=>!ids.includes(id)),JSON.stringify(focused));
 }
}
