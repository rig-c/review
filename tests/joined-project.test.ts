import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenInputs } from '../src/cli.ts';
import { frontRoute } from '../src/front.ts';
import { digest } from '../src/interview-project.ts';
import { loadOpenPackage, openKey } from '../src/open.ts';
import { producerInputs } from '../src/rebuild.ts';
import { startServer } from '../src/server.ts';
import { sessionFile } from '../src/session.ts';

test('joined open requires an explicit project, version and picks directory together', () => {
  const flags = ['--project','create','--project-version','2','--picks-dir','picks'];
  expect(parseOpenInputs(['out', ...flags]).project).toEqual({root:'create', version:2, picksDir:'picks'});
  expect(parseOpenInputs(['out'])).toEqual({input:'out'});
  expect(() => parseOpenInputs(['out', ...flags.slice(0,-2)])).toThrow('OPEN_OPTION_INVALID --project');
  expect(() => parseOpenInputs(['out', ...flags, '--compare','other'])).toThrow('OPEN_OPTION_INVALID --project');
});

test('joined front allowlists only the existing bounded interview routes and fixed frame', () => {
  expect(frontRoute('single','GET','/stage-interview.html')).not.toBeNull();
  expect(frontRoute('single','GET','/api/interview/image/' + 'a'.repeat(64) + '/0')).not.toBeNull();
  expect(frontRoute('single','POST','/api/interview/picks')?.limit).toBe(256*1024);
  for (const path of ['/api/interview/project.json','/api/interview/image/../../project.json','/api/interview/image/' + 'a'.repeat(64) + '/00']) {
    expect(frontRoute('single','GET',path)).toBeNull();
  }
  expect(frontRoute('compare','GET','/api/interview')).toBeNull();
  expect(frontRoute('single','PUT','/api/interview/picks')).toBeNull();
});

test('real Create v2 joins existing Stage 1 and 2 without changing the feedback address', async () => {
  const scratch = await mkdtemp(join(tmpdir(),'review-'));
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
    expect((await get('/stage-interview.html?stageEmbed=1&lang=ko')).headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    expect((await get('/interview.js')).status).toBe(200);
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
