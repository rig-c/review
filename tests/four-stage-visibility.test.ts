import { expect, test } from 'bun:test';
import { fullyVisible } from './helpers/walk-visibility.ts';

test('the walk distinguishes a clipped pending result from one exposed by panel scroll', () => {
  const layoutParent = {
    parentElement:null, style:{overflowX:'visible', overflowY:'visible'},
    getBoundingClientRect:() => ({left:70, top:20, right:90, bottom:30}),
  };
  const scrollPanel = {
    parentElement:layoutParent,
    style:{overflowX:'visible', overflowY:'auto'},
    clientTop:2, clientLeft:2, clientWidth:140, clientHeight:100,
    getBoundingClientRect:() => ({left:20, top:50, right:164, bottom:154}),
  };
  let top = 145;
  let shown = true;
  const target = {
    ownerDocument:{defaultView:{
      innerWidth:300, innerHeight:250,
      getComputedStyle:(node: typeof scrollPanel | typeof layoutParent) => node.style,
    }},
    parentElement:scrollPanel,
    checkVisibility:() => shown,
    getBoundingClientRect:() => ({left:25, right:120, top, bottom:top+16, width:95, height:16}),
  } as unknown as HTMLElement;

  expect(target.checkVisibility()).toBe(true);
  expect(fullyVisible(target)).toBe(false);
  top = 130;
  expect(fullyVisible(target)).toBe(true);
  shown = false;
  expect(fullyVisible(target)).toBe(false);
});
