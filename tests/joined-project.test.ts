import { joinProject } from '../src/joined-project.ts';
import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenInputs } from '../src/cli.ts';
import { frontRoute } from '../src/front.ts';
import { digest } from '../src/interview-project.ts';
import { loadOpenPackage, openKey } from '../src/open.ts';
import { producerInputs } from '../src/rebuild.ts';
import { startServer } from '../src/server.ts';
import { freshSession, sessionFile } from '../src/session.ts';

test('joined open requires an explicit project, version and picks directory together', () => {
  const flags = ['--project','create','--project-version','2','--picks-dir','picks'];
  expect(parseOpenInputs(['out', ...flags]).project).toEqual({root:'create', version:2, picksDir:'picks'});
  expect(parseOpenInputs(['out'])).toEqual({input:'out'});
  expect(() => parseOpenInputs(['out', ...flags.slice(0,-2)])).toThrow('OPEN_OPTION_INVALID --project');
  expect(() => parseOpenInputs(['out', ...flags, '--compare','other'])).toThrow('OPEN_OPTION_INVALID --project');
});

test('joined front allowlists only the existing bounded interview routes and no frame page', () => {
  for (const path of ['/stage-interview.html','/interview.js','/interview.css']) expect(frontRoute('single','GET',path)).toBeNull();
  expect(frontRoute('single','GET','/api/interview/image/' + 'a'.repeat(64) + '/0')).not.toBeNull();
  expect(frontRoute('single','POST','/api/interview/picks')?.limit).toBe(256*1024);
  for (const path of ['/api/interview/project.json','/api/interview/image/../../project.json','/api/interview/image/' + 'a'.repeat(64) + '/00']) {
    expect(frontRoute('single','GET',path)).toBeNull();
  }
  expect(frontRoute('compare','GET','/api/interview')).toBeNull();
  expect(frontRoute('single','PUT','/api/interview/picks')).toBeNull();
});

test('real Create v2 joins existing Stage 1 and 2 without changing the feedback address', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()),'review-'));
  const root = join(scratch,'project'), other = join(scratch,'other'), stateDir = join(scratch,'state');
  const capability = 'a'.repeat(64);
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    const archive = await readFile(new URL('./fixtures/create-reopened-v2/project.tar.gz', import.meta.url));
    // This digest identifies the audited archive of regular files with literal relative paths.
    expect(digest(archive)).toBe('35fb7799f48336e10c7999dbeeacdfa87b2e6e015b59a76c6a37d33966f311ff');
    await mkdir(root);
    const extracted = Bun.spawnSync(['tar','-xzf','-','-C',root], {stdin:archive});
    if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString());
    expect(digest(await readFile(join(root,'project.json')))).toBe('e3ec008fc9d1b3977315343d5a59c5f2b8ed0fb932b06f85a1afb8c7b74697f1');
    await mkdir(join(root,'reviewer-picks'),{recursive:true});
    await cp(root, other, {recursive:true});
    const input = join(root,'derived/review/v2/out');
    const project = {root, version:2, picksDir:'reviewer-picks'};
    const old = await loadOpenPackage({input}), connected = await loadOpenPackage({input, project});
    if (old.mode !== 'single' || connected.mode !== 'single' || !connected.joined) throw new Error('Expected joined single open');
    expect(connected.contentHash).toBe(old.contentHash);
    expect(sessionFile(connected.p,stateDir)).toBe(sessionFile(old.p,stateDir));
    expect(openKey(connected,'tool')).not.toBe(openKey(old,'tool'));
    expect(openKey(await loadOpenPackage(connected.inputs),'tool')).toBe(openKey(connected,'tool'));
    await expect(loadOpenPackage({input,project:{...project, root:other}})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
    await expect(loadOpenPackage({input,project:{...project, version:1}})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');

    const handoff = connected.p.handoff!;
    const requirement = handoff.record.files.find(file=>file.path==='../../interview-requirements.json')!;
    expect(requirement.sha256).toBe(digest(await readFile(join(root,'derived/review/v2/interview-requirements.json'))));
    const producer = await producerInputs(handoff,null);
    expect(producer.requirements).toEqual({source:join(root,'derived/review/v2/interview-requirements.json'),sha256:requirement.sha256});
    const unbound = {...handoff,record:{...handoff.record,files:handoff.record.files.filter(file=>file!==requirement)}};
    await expect(producerInputs(unbound,null)).rejects.toThrow('REBUILD_REQUIREMENTS_UNAVAILABLE: config.requirements has no bound handoff hash');
    const requirementsPath = producer.requirements!.source;
    const rawRequirements = await readFile(requirementsPath);
    try {
      await writeFile(requirementsPath,Buffer.concat([rawRequirements,Buffer.from(' ')]));
      await expect(loadOpenPackage({input,project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
    } finally {await writeFile(requirementsPath,rawRequirements);}
    expect(digest(await readFile(requirementsPath))).toBe(requirement.sha256);
    const config = await readFile(handoff.config);
    try {
      const traversal = JSON.stringify({...JSON.parse(config.toString('utf8')),requirements:'../interview-requirements.json'});
      await writeFile(handoff.config,traversal);
      const changed = {...handoff,record:{...handoff.record,config:{...handoff.record.config,sha256:digest(traversal)}}};
      await expect(producerInputs(changed,null)).rejects.toThrow('REBUILD_REQUIREMENTS_UNAVAILABLE: config.requirements is missing or outside the bound handoff');
    } finally {await writeFile(handoff.config,config);}
    expect(digest(await readFile(handoff.config))).toBe(digest(config));

    const server = await startServer(connected.p,{port:0,stateDir,capability,joined:connected.joined});
    servers.push(server);
    const origin = 'http://127.0.0.1:' + server.port;
    const get = (path: string) => fetch(origin + path);
    const post = (headers: Record<string,string>) => fetch(origin + '/api/interview/picks', {
      method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:'{}',
    });
    const projectPath = join(root,'project.json');
    const rawProject = await readFile(projectPath);
    const response = await get('/api/interview');
    expect(response.status).toBe(200);
    const interview = await response.json();
    expect(interview.binding).toEqual({projectHash:digest(rawProject),sourceHash:old.contentHash,version:2});
    expect(interview.questions).toHaveLength(11);
    expect(interview.questions.every((q:{editable:boolean;saved:unknown}) => !q.editable && q.saved === null)).toBe(true);
    expect(interview.historical.map((answer:{verbatim:string}) => answer.verbatim)).toEqual(connected.joined.opened.historical.map(answer=>answer.verbatim));
    const parts = await (await get('/api/stage-parts')).json();
    const sourceParts = JSON.parse(await readFile(join(input,'parts.json'),'utf8'));
    expect(parts.inspectionSourceHash).toBe(old.contentHash);
    expect(parts.items.map((p:{name:string})=>p.name).sort()).toEqual(sourceParts.parts.map((p:{name:string})=>p.name).sort());
    // #726: the stage interview frame is deleted; the API above is the interview's only route.
    for (const path of ['/stage-interview.html?stageEmbed=1&lang=ko','/interview.js','/interview.css']) expect((await get(path)).status).toBe(404);
    expect((await post({Origin:origin})).status).toBe(403);
    expect((await post({Origin:'https://example.test','X-Review-Capability':capability})).status).toBe(403);
    expect((await post({Origin:origin,'X-Review-Capability':capability})).status).toBe(400);
    expect((await (await get('/api/session')).json()).status).toBe('pending');

    // Alter only disposable copies. Restore the exact bytes even when a refusal assertion fails.
    const image = join(input,'parts/torso.png');
    const rawImage = await readFile(image);
    try {
      await writeFile(image,Buffer.concat([rawImage,Buffer.from([0])]));
      for (const path of ['/api/stage-parts','/api/interview']) {
        const stale = await get(path);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({error:'INTERVIEW_OPTIONS_STALE'});
      }
      const stalePost = await post({Origin:origin,'X-Review-Capability':capability});
      expect(stalePost.status).toBe(409);
      expect(await stalePost.json()).toEqual({error:'INTERVIEW_OPTIONS_STALE'});
    } finally {await writeFile(image,rawImage);}
    try {
      await writeFile(projectPath,Buffer.concat([rawProject,Buffer.from('\n')]));
      const stale = await get('/api/interview');
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({error:'INTERVIEW_OPTIONS_STALE'});
      const revised = await loadOpenPackage({input,project});
      expect(openKey(revised,'tool')).not.toBe(openKey(connected,'tool'));
      expect(revised.contentHash).toBe(connected.contentHash);

      const record = JSON.parse(rawProject.toString('utf8'));
      delete record.interview;
      await writeFile(projectPath,JSON.stringify(record));
      const missing = await loadOpenPackage({input,project});
      if (missing.mode !== 'single' || !missing.joined) throw new Error('Expected joined project without an interview');
      expect(missing.joined.available).toBe(false);
      const noInterview = await startServer(missing.p,{port:0,stateDir,capability,joined:missing.joined});
      servers.push(noInterview);
      const refusal = await fetch('http://127.0.0.1:'+noInterview.port+'/api/interview');
      expect(refusal.status).toBe(404);
      expect(await refusal.json()).toEqual({error:'INTERVIEW_UNAVAILABLE'});
    } finally {await writeFile(projectPath,rawProject);}
    expect(digest(await readFile(image))).toBe(digest(rawImage));
    expect(digest(await readFile(projectPath))).toBe(digest(rawProject));
    expect((await get('/api/interview')).status).toBe(200);
  } finally {
    for (const server of servers) server.stop(true);
    await rm(scratch,{recursive:true,force:true});
  }
}, 15_000);

test('joined authored post maps the recorded package and isolates feedback and stale inputs', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-direction-'));
  const root = join(scratch, 'project'), stateDir = join(scratch, 'state');
  const input = join(root, 'derived/review/v1/out');
  const flags = ['--project', root, '--project-version', '1', '--picks-dir', 'picks', '--post-version', '2'];
  const inputs = parseOpenInputs([input, ...flags]);
  const capability = 'a'.repeat(64);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const archive = await readFile(new URL('./fixtures/create-example-chain/project.tar.gz', import.meta.url));
    expect(digest(archive)).toBe('88b5a4584b25608fd9409b2e27f0c77dad8f042e82751dc882cbf40bca6b2072');
    await mkdir(root);
    const tar = Bun.spawnSync(['tar', '-xzf', '-', '-C', root], {stdin:archive});
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
    await mkdir(join(root, 'picks'));
    const joined = await loadOpenPackage(inputs);
    const standalone = await loadOpenPackage({input});
    if (joined.mode !== 'single' || standalone.mode !== 'single' || !joined.joined || !joined.p.direction?.joined)
      throw new Error('Expected the selected joined authored direction');
    const {p} = joined, authored = p.direction!;
    const projectPath = join(root, 'project.json'), directionPath = join(root, authored.file.path);
    const projectBytes = await readFile(projectPath), directionBytes = await readFile(directionPath);
    const doc = JSON.parse(directionBytes.toString());
    expect(authored.joined).toEqual({postVersion:2, projectHash:digest(projectBytes),
      packageSourceHash:standalone.contentHash, packageRoot:'derived/review/v1', projectModel:doc.rig.model});
    const projectAlias = join(scratch, 'project-alias'), packageAlias = join(scratch, 'package-alias');
    await symlink(root, projectAlias, 'dir');
    await symlink(input, packageAlias, 'dir');
    const aliased = await loadOpenPackage(parseOpenInputs([packageAlias, ...flags.map(flag => flag === root ? projectAlias : flag)]));
    if (aliased.mode !== 'single' || !aliased.joined) throw new Error('Expected joined post through both aliases');
    expect(aliased.inputs).toEqual(joined.inputs);
    expect(aliased.contentHash).toBe(joined.contentHash);
    expect(aliased.p.direction?.joined).toEqual(authored.joined);
    await aliased.joined.assertCurrent();
    // Isolate the package identity: the selected video contributes to the package hash
    // while the Create project, its rig package and direction document stay identical.
    const video=join(scratch,'explicit.mp4');
    await writeFile(video,'Reference bytes for source identity');
    const differentPackage=await loadOpenPackage({...inputs,reference:video});
    if(differentPackage.mode!=='single')throw new Error('Expected joined package with explicit reference');
    expect(differentPackage.p.direction?.joined?.projectHash).toBe(authored.joined!.projectHash);
    expect(differentPackage.p.direction?.joined?.packageSourceHash).not.toBe(authored.joined!.packageSourceHash);
    expect(differentPackage.contentHash).not.toBe(joined.contentHash);
    // Isolate the project identity: its raw bytes can change with the package bytes held fixed.
    try {
      await writeFile(projectPath,Buffer.concat([projectBytes,Buffer.from('\n')]));
      const differentProject=joinProject(standalone.p,joined.joined.designation).review;
      expect(differentProject.direction?.joined?.packageSourceHash).toBe(authored.joined!.packageSourceHash);
      expect(differentProject.direction?.joined?.projectHash).not.toBe(authored.joined!.projectHash);
      expect(differentProject.sourceHash).not.toBe(joined.contentHash);
    } finally {await writeFile(projectPath,projectBytes);}
    expect(authored.rigVersion).toBe(1);
    expect(authored.camera).toEqual(doc.camera);
    expect(authored.timing).toEqual(doc.timing.keys);
    expect(p.reviewedSource.rig).toEqual({path:'build/skeleton.model.json', sha256:doc.rig.model.sha256});
    expect(standalone.p.direction).toBeUndefined();
    expect(sessionFile(p,stateDir)).not.toBe(sessionFile(standalone.p,stateDir));
    expect(openKey(await loadOpenPackage(joined.inputs),'tool')).toBe(openKey(joined,'tool'));

    server = await startServer(p,{port:0,stateDir,capability,joined:joined.joined});
    const origin = 'http://127.0.0.1:' + server.port;
    const get = (path: string) => fetch(origin + path);
    expect((await (await get('/api/review')).json()).direction).toEqual(authored);
    const parts = await get('/api/stage-parts');
    expect(parts.status).toBe(200);
    expect((await parts.json()).inspectionSourceHash).toBe(p.sourceHash);
    expect((await get('/assets/' + authored.file.path)).status).toBe(404);
    const session = freshSession(p);
    const item = {id:'authored-request', frameStart:0, frameEnd:0, target:{kind:'rig',name:p.manifest.id},
      category:'quality', summary:'  Keep this timing.\r\n프레이밍 유지  \n',
      context:{correction:{path:'described',selector:{stage:'direction-review',kind:'post',version:2,modelFile:p.reviewedSource.rig!.path}}}};
    const submit = (source = session) => fetch(origin + '/api/session', {
      method:'PUT', headers:{origin,'content-type':'application/json','x-review-capability':capability},
      body:JSON.stringify({...source,feedback:[item]}),
    });
    const stale = await submit(freshSession(standalone.p));
    expect(stale.ok).toBe(false);
    expect(await stale.text()).toContain('session.sourceHash: does not match loaded package');
    item.context.correction.selector.version = 1;
    expect(await (await submit()).text()).toContain('CORRECTION_DIRECTION_SOURCE');
    item.context.correction.selector.version = 2;
    item.context.correction.path = 'made';
    expect(await (await submit()).text()).toContain('CAMERA_APPLY_UNSUPPORTED');
    item.context.correction.path = 'described';
    const saved = await submit();
    expect(saved.status, await saved.text()).toBe(200);
    const exported = Bun.spawnSync([process.execPath,'src/cli.ts','feedback',input,...flags,
      '--correction',item.id,'--format','issue'], {env:{...process.env,RIG_REVIEW_STATE_DIR:stateDir}});
    expect(exported.exitCode,exported.stderr.toString()).toBe(0);
    const issue = JSON.parse(exported.stdout.toString().split('\n').slice(5,-2).join('\n'));
    expect(issue.verbatim).toBe(item.summary);
    expect(issue.selectorArgs).toEqual(['--version','2','--model-file',doc.rig.model.path]);
    expect(JSON.parse(issue.createSource)).toMatchObject({post:2, rigVersion:1,
      model:doc.rig.model, direction:authored.file, binding:authored.joined, inspectedModel:p.reviewedSource.rig});

    const refusal = async (path: string, code: string) => {
      const result = await get(path);
      expect(result.status).toBe(409);
      expect(await result.text()).toContain(code);
    };
    const modelPath = join(root, doc.rig.model.path);
    const modelBytes = await readFile(modelPath);
    for (const [path, bytes, code] of [[directionPath,directionBytes,'DIRECTION_SOURCE_STALE'],
      [projectPath,projectBytes,'INTERVIEW_OPTIONS_STALE'], [modelPath,modelBytes,'INTERVIEW_OPTIONS_STALE']] as const) {
      try {
        await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
        await refusal('/api/review', code);
      } finally { await writeFile(path, bytes); }
    }
    await expect(loadOpenPackage({...inputs,project:{...inputs.project!,version:1,postVersion:1,draftId:undefined,partsVerdictDir:undefined}})).rejects.toThrow('DIRECTION_VERSION');
    await expect(loadOpenPackage({...inputs,project:{...inputs.project!,version:2,draftId:undefined,partsVerdictDir:undefined}})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');

    const mutateProject = async (edit: (post: any) => void) => {
      const record = JSON.parse(projectBytes.toString());
      edit(record.versions.find((entry: {n:number}) => entry.n === 2));
      await writeFile(projectPath,JSON.stringify(record));
    };
    try {
      await mutateProject(post => {post.rig_version = 2;});
      await expect(loadOpenPackage(inputs)).rejects.toThrow('DIRECTION_RIG_MISMATCH');
      await mutateProject(post => {delete post.provenance.direction;});
      await expect(loadOpenPackage(inputs)).rejects.toThrow('DIRECTION_DOCUMENT_REQUIRED');
      // This different project path really names another copy of the same model bytes.
      const wrong = join(root, 'wrong.model.json');
      await writeFile(wrong, modelBytes);
      doc.rig.model.path = 'wrong.model.json';
      const changed = JSON.stringify(doc);
      await writeFile(directionPath, changed);
      await mutateProject(post => {
        const binding = {path:authored.file.path,sha256:digest(changed)};
        post.outputs = [binding];
        post.provenance.config = post.provenance.direction = binding;
      });
      await expect(loadOpenPackage(inputs)).rejects.toThrow('DIRECTION_MODEL_MISMATCH');
      await writeFile(projectPath, projectBytes);
      await rm(directionPath);
      const outside = join(scratch, 'direction.json');
      await writeFile(outside, directionBytes);
      await symlink(outside, directionPath);
      await expect(loadOpenPackage(inputs)).rejects.toThrow('DIRECTION_SOURCE_MISMATCH');
    } finally {
      await rm(directionPath,{force:true});
      await writeFile(directionPath,directionBytes);
      await writeFile(projectPath,projectBytes);
    }
    expect((await get('/api/review')).status).toBe(200);
  } finally {
    server?.stop(true);
    await rm(scratch,{recursive:true,force:true});
  }
}, 15000);
