import {expect,test} from 'bun:test';
import {WorkspacePreferenceStore,defaultWorkspacePreferences,defaultWorkspacePanels,legacyAppearanceKey,mergeWorkspacePreferences,parseWorkspacePreferences,workspacePreferenceKey,type PreferenceStorage,type WorkspacePreferencePatch} from '../web/workspace-preferences.ts';
class PreferenceHub {
 values=new Map<string,string>();queue:Array<()=>void>=[];writes=0;endpoints:Array<{storage:PreferenceStorage;events:EventTarget;stale:string|null|undefined;denyRead:boolean;denyWrite:boolean}>=[];
 endpoint(){
  const endpoint={storage:{} as PreferenceStorage,events:new EventTarget(),stale:undefined as string|null|undefined,denyRead:false,denyWrite:false};
  endpoint.storage={getItem:key=>{if(endpoint.denyRead)throw new Error('denied read');if(key===workspacePreferenceKey&&endpoint.stale!==undefined)return endpoint.stale;return this.values.get(key)??null;},setItem:(key,value)=>{if(endpoint.denyWrite)throw new Error('denied write');this.values.set(key,value);this.writes++;for(const other of this.endpoints)if(other!==endpoint)this.queue.push(()=>{const event=new Event('storage');Object.assign(event,{key,newValue:value,storageArea:other.storage});other.events.dispatchEvent(event);});}};this.endpoints.push(endpoint);return endpoint;
 }
 flush(reverse=false){let count=0;while(this.queue.length){if(++count>100)throw new Error('Preference reconciliation did not settle');(reverse?this.queue.pop():this.queue.shift())!();}return count;}
}
test('closed versioned preferences refuse source data, malformed fields, dimensions and metadata',()=>{
 const defaults=defaultWorkspacePreferences();expect(parseWorkspacePreferences(defaults)).toEqual(defaults);
 for(const value of [{...defaults,sourceHash:'private'},{...defaults,capability:'token'},{...defaults,schema:'future'},{...defaults,theme:'auto'},{...defaults,defaultIdleRepeat:1},{...defaults,panels:{...defaults.panels,leftWidth:NaN}},{...defaults,panels:{...defaults.panels,rightWidth:179}},{...defaults,panels:{...defaults.panels,inspectorHeight:901}},{...defaults,panels:{...defaults.panels,css:'display:none'}},{...defaults,revision:1},{...defaults,stamps:{...defaults.stamps,theme:{revision:0,writer:'tab'}}}])expect(()=>parseWorkspacePreferences(value)).toThrow();
 const hub=new PreferenceHub(),end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'one'});expect(()=>store.update({sourceHash:'x'} as unknown as WorkspacePreferencePatch)).toThrow('unknown field');expect(hub.writes).toBe(0);store.dispose();
});
test('only an absent new record migrates same-origin legacy appearance and snapshots are owned',()=>{
 const hub=new PreferenceHub();hub.values.set(legacyAppearanceKey,'dark');const end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'one'});expect(store.get().theme).toBe('dark');expect(hub.values.has(workspacePreferenceKey)).toBe(true);expect(store.get().defaultCameraSync).toBe(true);const copy=store.get();copy.panels.leftWidth=500;copy.stamps.theme.writer='other';expect(store.get().panels.leftWidth).toBe(defaultWorkspacePanels.leftWidth);expect(store.get().stamps.theme.writer).toBe('one');store.dispose();
 const otherHub=new PreferenceHub(),other=otherHub.endpoint(),fresh=new WorkspacePreferenceStore({...other,writer:'two'});expect(fresh.get().theme).toBe('system');expect(otherHub.writes).toBe(0);fresh.dispose();
});
test('corrupt records refuse cleanly without migrating an existing record; storage denial keeps edits usable',()=>{
 const hub=new PreferenceHub();hub.values.set(legacyAppearanceKey,'dark');hub.values.set(workspacePreferenceKey,'{broken');const end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'one'});expect(store.get().theme).toBe('system');expect(store.status().state).toBe('corrupt');expect(hub.writes).toBe(0);
 end.denyRead=true;end.denyWrite=true;store.update({theme:'light',defaultIdleRepeat:false});expect(store.get()).toMatchObject({theme:'light',defaultIdleRepeat:false});expect(store.status().state).toBe('memory-only');store.update({panels:{rightWidth:350}});expect(store.get().theme).toBe('light');expect(store.get().panels.rightWidth).toBe(350);
 end.denyRead=false;end.denyWrite=false;hub.values.delete(workspacePreferenceKey);store.update({defaultCameraSync:false});expect(parseWorkspacePreferences(JSON.parse(hub.values.get(workspacePreferenceKey)!))).toMatchObject({theme:'light',defaultIdleRepeat:false,defaultCameraSync:false,panels:{rightWidth:350}});expect(store.status().state).toBe('available');store.dispose();
 const denied=new WorkspacePreferenceStore({storage:{getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}},events:null,writer:'denied'});expect(denied.status().detail).toContain('denied');denied.update({theme:'dark'});expect(denied.get().theme).toBe('dark');denied.dispose();
});
test('a stale tab field update reads latest unrelated fields and Reset layout changes geometry only',()=>{
 const hub=new PreferenceHub(),a=hub.endpoint(),b=hub.endpoint(),first=new WorkspacePreferenceStore({...a,writer:'a'}),second=new WorkspacePreferenceStore({...b,writer:'b'});first.update({theme:'dark',defaultCameraSync:false});second.update({defaultIdleRepeat:false,panels:{leftWidth:420}});first.resetLayout();hub.flush();const expected={theme:'dark',defaultCameraSync:false,defaultIdleRepeat:false,panels:{...defaultWorkspacePanels}};expect(first.get()).toMatchObject(expected);expect(second.get()).toMatchObject(expected);expect(JSON.parse(hub.values.get(workspacePreferenceKey)!)).toMatchObject(expected);first.dispose();second.dispose();
});
test('simultaneous stale whole-record writes converge by field stamps under reversed event delivery',()=>{
 const hub=new PreferenceHub(),a=hub.endpoint(),b=hub.endpoint(),first=new WorkspacePreferenceStore({...a,writer:'tab-a'}),second=new WorkspacePreferenceStore({...b,writer:'tab-b'});a.stale=null;b.stale=null;
 first.update({theme:'dark',panels:{leftWidth:410}});second.update({defaultIdleRepeat:false,panels:{rightWidth:380}});expect(first.get().defaultIdleRepeat).toBe(true);expect(second.get().theme).toBe('system');a.stale=undefined;b.stale=undefined;
 const processed=hub.flush(true);const persisted=parseWorkspacePreferences(JSON.parse(hub.values.get(workspacePreferenceKey)!));expect(persisted).toMatchObject({theme:'dark',defaultIdleRepeat:false,panels:{leftWidth:410,rightWidth:380}});expect(first.get()).toEqual(persisted);expect(second.get()).toEqual(persisted);expect(processed).toBeLessThan(12);const writes=hub.writes;first.refresh();second.refresh();expect(hub.flush()).toBe(0);expect(hub.writes).toBe(writes);first.dispose();second.dispose();
});
test('concurrent same-field edits use a deterministic writer tie and old events cannot revive cleared storage',()=>{
 const hub=new PreferenceHub(),a=hub.endpoint(),b=hub.endpoint(),first=new WorkspacePreferenceStore({...a,writer:'a'}),second=new WorkspacePreferenceStore({...b,writer:'z'});a.stale=null;b.stale=null;first.update({theme:'dark'});second.update({theme:'light'});a.stale=undefined;b.stale=undefined;hub.flush();expect(first.get().theme).toBe('light');expect(second.get()).toEqual(first.get());
 first.update({defaultIdleRepeat:false});hub.values.delete(workspacePreferenceKey);hub.flush();expect(second.get()).toEqual(defaultWorkspacePreferences());expect(hub.values.has(workspacePreferenceKey)).toBe(false);first.dispose();second.dispose();
});
test('field merge rejects conflicting same-stamp values and subscriptions stop at disposal',()=>{
 const hub=new PreferenceHub(),a=hub.endpoint(),store=new WorkspacePreferenceStore({...a,writer:'a'});let calls=0;const unsubscribe=store.subscribe(value=>{calls++;value.panels.rightWidth=899;});store.update({theme:'dark'});expect(store.get().panels.rightWidth).toBe(defaultWorkspacePanels.rightWidth);expect(calls).toBe(1);const one=store.get(),two=store.get();two.theme='light';expect(()=>mergeWorkspacePreferences(one,two)).toThrow('STAMP_CONFLICT');unsubscribe();store.update({defaultCameraSync:false});expect(calls).toBe(1);store.dispose();expect(()=>store.update({theme:'light'})).toThrow('DISPOSED');
});

test('logical stamp corruption quarantines only that field and explicit edits repair it',()=>{
 for(const delivery of ['refresh','event','update'] as const){
  const hub=new PreferenceHub(),end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'known'});store.update({theme:'dark'});
  const corrupted=store.get();corrupted.theme='light';corrupted.defaultIdleRepeat=false;corrupted.stamps.defaultIdleRepeat={revision:2,writer:'other'};corrupted.revision=2;
  // Individually well-formed, but its theme disagrees with this page at exactly one stamp.
  parseWorkspacePreferences(corrupted);hub.values.set(workspacePreferenceKey,JSON.stringify(corrupted));const writes=hub.writes;
  if(delivery==='refresh')expect(()=>store.refresh()).not.toThrow();
  if(delivery==='event'){const event=new Event('storage');Object.assign(event,{key:workspacePreferenceKey,newValue:JSON.stringify(corrupted),storageArea:end.storage});expect(()=>end.events.dispatchEvent(event)).not.toThrow();}
  if(delivery!=='update'){expect(store.status().state).toBe('corrupt');expect(store.get()).toMatchObject({theme:'dark',defaultIdleRepeat:false});expect(hub.writes).toBe(writes);}
  expect(()=>store.update({panels:{leftWidth:200}})).not.toThrow();
  const repaired=parseWorkspacePreferences(JSON.parse(hub.values.get(workspacePreferenceKey)!));expect(repaired).toMatchObject({theme:'dark',defaultIdleRepeat:false,panels:{leftWidth:200}});expect(repaired.stamps.theme).toEqual({revision:3,writer:'known'});expect(repaired.stamps.defaultIdleRepeat).toEqual({revision:2,writer:'other'});expect(store.status().state).toBe('available');expect(store.get()).toEqual(repaired);store.dispose();
 }
});

test('denied corruption repair retains every usable value and retries after access returns',()=>{
 const hub=new PreferenceHub(),end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'known'});store.update({theme:'dark'});const conflict=store.get();conflict.theme='light';hub.values.set(workspacePreferenceKey,JSON.stringify(conflict));store.refresh();expect(store.status().state).toBe('corrupt');
 end.denyWrite=true;store.update({defaultCameraSync:false});expect(store.get()).toMatchObject({theme:'dark',defaultCameraSync:false});expect(store.status().state).toBe('memory-only');end.denyWrite=false;store.refresh();expect(store.status().state).toBe('available');expect(JSON.parse(hub.values.get(workspacePreferenceKey)!)).toMatchObject({theme:'dark',defaultCameraSync:false});store.dispose();
});

test('Settings collapsed state round-trips through storage under its own key and records from before it still load',()=>{
 const hub=new PreferenceHub(),end=hub.endpoint(),store=new WorkspacePreferenceStore({...end,writer:'one'});expect(store.get().settingsCollapsed).toBe(true);
 store.update({settingsCollapsed:false});const stored=JSON.parse(hub.values.get(workspacePreferenceKey)!);expect(stored.settingsCollapsed).toBe(false);expect(stored.stamps.settingsCollapsed).toEqual({revision:1,writer:'one'});
 expect(stored).toMatchObject({theme:'system',defaultCameraSync:true,defaultIdleRepeat:true});store.dispose();
 const reopened=new WorkspacePreferenceStore({...hub.endpoint(),writer:'two'});expect(reopened.get().settingsCollapsed).toBe(false);expect(reopened.status().state).toBe('available');reopened.dispose();
 // A record written before the field existed has neither the value nor its stamp: it loads, collapsed.
 const old=JSON.parse(JSON.stringify(defaultWorkspacePreferences()));delete old.settingsCollapsed;delete old.stamps.settingsCollapsed;old.theme='dark';old.stamps.theme={revision:4,writer:'legacy'};old.revision=4;
 expect(parseWorkspacePreferences(old)).toMatchObject({theme:'dark',settingsCollapsed:true,revision:4,stamps:{settingsCollapsed:{revision:0,writer:''}}});
 const legacy=new PreferenceHub();legacy.values.set(workspacePreferenceKey,JSON.stringify(old));const loaded=new WorkspacePreferenceStore({...legacy.endpoint(),writer:'three'});expect(loaded.status().state).toBe('available');expect(loaded.get()).toMatchObject({theme:'dark',settingsCollapsed:true});
 loaded.update({settingsCollapsed:false});expect(JSON.parse(legacy.values.get(workspacePreferenceKey)!)).toMatchObject({theme:'dark',settingsCollapsed:false,revision:5,stamps:{settingsCollapsed:{revision:5,writer:'three'}}});loaded.dispose();
 // An unstamped value that differs from the default, or a non-boolean, is refused like every other field.
 expect(()=>parseWorkspacePreferences({...old,settingsCollapsed:false})).toThrow('PREFERENCES_STAMP');expect(()=>parseWorkspacePreferences({...defaultWorkspacePreferences(),settingsCollapsed:'no'})).toThrow('settingsCollapsed');
});

test('saved preferences from earlier versions with 280px inspectorHeight still load (both unstamped default and stamped user resize)',()=>{
 expect(defaultWorkspacePanels.inspectorHeight).toBe(350);
 // 1. Earlier version saved record where user changed theme, leaving inspectorHeight at the earlier unstamped default 280.
 const legacyUnstamped=JSON.parse(JSON.stringify(defaultWorkspacePreferences()));
 legacyUnstamped.theme='dark';
 legacyUnstamped.stamps.theme={revision:2,writer:'legacy'};
 legacyUnstamped.revision=2;
 legacyUnstamped.panels.inspectorHeight=280;
 legacyUnstamped.stamps.inspectorHeight={revision:0,writer:''};
 const parsedUnstamped=parseWorkspacePreferences(legacyUnstamped);
 expect(parsedUnstamped.panels.inspectorHeight).toBe(350);
 expect(parsedUnstamped.theme).toBe('dark');
 const hubA=new PreferenceHub();
 hubA.values.set(workspacePreferenceKey,JSON.stringify(legacyUnstamped));
 const storeA=new WorkspacePreferenceStore({...hubA.endpoint(),writer:'tab-a'});
 expect(storeA.status().state).toBe('available');
 expect(storeA.get().panels.inspectorHeight).toBe(350);
 storeA.dispose();

 // 2. Earlier version saved record where user explicitly set/stamped inspectorHeight to 280.
 const legacyStamped=JSON.parse(JSON.stringify(defaultWorkspacePreferences()));
 legacyStamped.panels.inspectorHeight=280;
 legacyStamped.stamps.inspectorHeight={revision:3,writer:'legacy'};
 legacyStamped.revision=3;
 const parsedStamped=parseWorkspacePreferences(legacyStamped);
 expect(parsedStamped.panels.inspectorHeight).toBe(280);
 const hubB=new PreferenceHub();
 hubB.values.set(workspacePreferenceKey,JSON.stringify(legacyStamped));
 const storeB=new WorkspacePreferenceStore({...hubB.endpoint(),writer:'tab-b'});
 expect(storeB.status().state).toBe('available');
 expect(storeB.get().panels.inspectorHeight).toBe(280);
 storeB.dispose();

 // 3. Arbitrary unstamped non-default inspectorHeight (e.g. 250) is still refused.
 const tampered=JSON.parse(JSON.stringify(defaultWorkspacePreferences()));
 tampered.panels.inspectorHeight=250;
 expect(()=>parseWorkspacePreferences(tampered)).toThrow('PREFERENCES_STAMP: unstamped inspectorHeight differs from defaults');
});

test('stored preferences from 0.24.1 without language load unchanged and language round-trips with planted controls refused',()=>{
 // Exact 0.24.1 record shape: no language field and no stamps.language entry.
 const v0241Record={
  schema:workspacePreferenceKey,
  revision:3,
  theme:'dark',
  defaultCameraSync:false,
  defaultIdleRepeat:true,
  settingsCollapsed:false,
  panels:{leftWidth:210,rightWidth:310,inspectorHeight:360},
  stamps:{
   theme:{revision:1,writer:'tab-0241'},
   defaultCameraSync:{revision:2,writer:'tab-0241'},
   defaultIdleRepeat:{revision:0,writer:''},
   settingsCollapsed:{revision:3,writer:'tab-0241'},
   leftWidth:{revision:2,writer:'tab-0241'},
   rightWidth:{revision:2,writer:'tab-0241'},
   inspectorHeight:{revision:3,writer:'tab-0241'},
  },
 };
 const parsed=parseWorkspacePreferences(v0241Record);
 expect(parsed).toMatchObject({
  theme:'dark',
  language:'system',
  defaultCameraSync:false,
  defaultIdleRepeat:true,
  settingsCollapsed:false,
  panels:{leftWidth:210,rightWidth:310,inspectorHeight:360},
  revision:3,
  stamps:{language:{revision:0,writer:''}},
 });
 const hub=new PreferenceHub();
 hub.values.set(workspacePreferenceKey,JSON.stringify(v0241Record));
 const store=new WorkspacePreferenceStore({...hub.endpoint(),writer:'tab-new'});
 expect(store.status().state).toBe('available');
 expect(store.get()).toEqual(parsed);
 expect(hub.writes).toBe(0);
 store.update({language:'ko'});
 expect(store.get().language).toBe('ko');
 const afterKo=parseWorkspacePreferences(JSON.parse(hub.values.get(workspacePreferenceKey)!));
 expect(afterKo).toMatchObject({
  theme:'dark',
  language:'ko',
  defaultCameraSync:false,
  settingsCollapsed:false,
  panels:{leftWidth:210,rightWidth:310,inspectorHeight:360},
  revision:4,
  stamps:{language:{revision:4,writer:'tab-new'}},
 });
 store.resetLayout();
 expect(store.get().language).toBe('ko');
 store.dispose();
 // Planted controls: unstamped non-default language or unsupported language code must fail.
 expect(()=>parseWorkspacePreferences({...v0241Record,language:'ko'})).toThrow('PREFERENCES_STAMP: unstamped language differs from defaults');
 expect(()=>parseWorkspacePreferences({...defaultWorkspacePreferences(),language:'ja'})).toThrow('PREFERENCES_LANGUAGE: expected system, en or ko');
});
