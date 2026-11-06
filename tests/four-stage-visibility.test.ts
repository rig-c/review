import { expect, test } from 'bun:test';
import { fullyVisible, visibilityGeometry } from './helpers/walk-visibility.ts';

test('the walk distinguishes a clipped pending result from one exposed by panel scroll', () => {
  const layoutParent = {
    parentElement:null, style:{overflowX:'visible', overflowY:'visible'},
    getBoundingClientRect:() => ({left:70, top:20, right:90, bottom:30}),
  };
  const scrollPanel = {
    id:'idle-scroll', parentElement:layoutParent,
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
  expect(visibilityGeometry(target)).toMatchObject({
    firstFailure:'#idle-scroll',
    viewport:{left:0, top:0, right:300, bottom:250},
    target:{left:25, top:145, right:120, bottom:161},
    clips:[{
      boundary:'#idle-scroll', failed:true,
      rect:{left:22, top:52, right:162, bottom:152},
      intersection:{left:0, top:52, right:300, bottom:152},
    }],
  });
  top = 245;
  expect(visibilityGeometry(target).firstFailure).toBe('viewport');
  top = 130;
  expect(fullyVisible(target)).toBe(true);
  expect(visibilityGeometry(target).firstFailure).toBeNull();
  shown = false;
  expect(fullyVisible(target)).toBe(false);
});
