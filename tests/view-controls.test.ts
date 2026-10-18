import {initialReviewSelection} from '../src/open-selection.ts';
import {test,expect} from 'bun:test';
import {stageOrientation,panCenter,idleAvailable,initialIdleAnimation,themePreference,automaticIdlePreview} from '../web/view-controls.ts';
test('orientation follows available center rectangle, with stable square tie',()=>{expect(stageOrientation(900,600)).toBe('horizontal');expect(stageOrientation(600,900)).toBe('vertical');expect(stageOrientation(600,600)).toBe('horizontal');});
test('pan preserves coordinate signs and scales independently of pose time',()=>{expect(panCenter({x:10,y:20},40,20,2,'world')).toEqual({x:-10,y:30});expect(panCenter({x:10,y:20},40,20,2,'image')).toEqual({x:-10,y:10});expect(panCenter({x:10,y:20},40,20,4,'world')).toEqual({x:0,y:25});expect(()=>panCenter({x:0,y:0},1,1,0,'world')).toThrow('positive scale');});
test('only actual exact idle can preview; explicit inspection wins startup',()=>{expect(idleAvailable(['idle','walk'],'walk')).toBe(false);expect(idleAvailable(['idle_variant'],'idle')).toBe(false);expect(idleAvailable(['idle'],'idle')).toBe(true);expect(initialIdleAnimation(['walk','idle'],'walk',false)).toBe('idle');expect(initialIdleAnimation(['walk','idle'],'walk',true)).toBe('walk');expect(initialIdleAnimation(['walk'],'walk',false)).toBe('walk');expect(initialIdleAnimation([],null,false)).toBe(null);});
test('appearance accepts only local supported choices',()=>{expect(themePreference('light')).toBe('light');expect(themePreference('dark')).toBe('dark');expect(themePreference('system')).toBe('system');expect(themePreference('other')).toBe('system');expect(themePreference(null)).toBe('system');});

test('real handoff automatic idle checkpoint previews; deep-link, timed or axis inspections hold',()=>{
 const point={id:'character',title:'Character',animation:'idle',time:0,workspace:'modeling' as const,camera:{zoom:1,x:20,y:30}};
 const manifest={references:[],axes:[],checkpoints:[point]};
 const initial=initialReviewSelection(manifest,null,undefined,'idle');
 expect(initial.checkpoint).toBe(point);
 expect(automaticIdlePreview(['idle'],'idle',initial.checkpoint,false)).toBe(true);
 const requested=initialReviewSelection(manifest,point.id,undefined,'idle');
 expect(automaticIdlePreview(['idle'],'idle',requested.checkpoint,true)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',{...point,time:.4},false)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',{...point,axis:{id:'look',value:0}},false)).toBe(false);
 expect(automaticIdlePreview(['idle','dance'],'dance',{...point,animation:'dance'},false)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',undefined,false)).toBe(true);
 expect(automaticIdlePreview(['idle_variant'],'idle',undefined,false)).toBe(false);
});
