import { lstatSync } from 'node:fs';
import { accessGate } from './open-protocol.ts';
import { boundBytes, invalid, object, readProject } from './interview-project.ts';
import { outputDirectory, picksLimit, readPicks, savePicks } from './interview-picks.ts';

export const interviewHeaders = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const json = (value: unknown, status = 200) => Response.json(value, {status, headers:interviewHeaders});

async function body(req: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return invalid('Expected application/json');
  const reader = req.body?.getReader();
  if (!reader) return invalid('Missing body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > picksLimit) {
        await reader.cancel().catch(() => {});
        return invalid('Picks payload exceeds size limit');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)));
  } catch {return invalid('Invalid or oversized picks JSON');}
  finally {reader.releaseLock();}
}

export const interviewRefusals = [
  'INTERVIEW_UNAVAILABLE', 'INTERVIEW_SOURCE_MISMATCH', 'INTERVIEW_CHOICE_INVALID',
  'INTERVIEW_CHOICE_CONSTRAINT', 'INTERVIEW_CHOICE_REQUIRED', 'INTERVIEW_OPTIONS_INVALID',
  'INTERVIEW_OPTIONS_FILE', 'INTERVIEW_OPTIONS_STALE', 'INTERVIEW_PICKS_OUTPUT',
] as const;
export function interviewRequest(path: string) {
  return path === '/api/interview' || path === '/api/interview/picks' ||
    /^\/api\/interview\/image\/[a-f0-9]{64}\/(0|[1-9]\d*)$/.test(path);
}

export function interviewRoutes(root: string, output: string, capability: string,
    joined?: {opened: ReturnType<typeof readProject>; assertCurrent: () => Promise<void>; available: boolean; sourceHash: string; version: number}) {
  const opened = joined?.opened ?? readProject(root);
  const outputPath = outputDirectory(opened.root, output, opened.project);
  const openedOutput = lstatSync(outputPath);
  const destination = () => {
    const path = outputDirectory(opened.root, output, opened.project);
    const info = lstatSync(path);
    if (info.dev !== openedOutput.dev || info.ino !== openedOutput.ino) throw new Error('INTERVIEW_PICKS_OUTPUT: Output directory changed');
    return path;
  };
  const current = async () => {
    await joined?.assertCurrent();
    if (readProject(opened.root).hash !== opened.hash) throw new Error('INTERVIEW_OPTIONS_STALE: Project changed; reopen the interview');
  };
  return async (req: Request, origin: string): Promise<Response | undefined> => {
    const url = new URL(req.url);
    if (url.origin !== origin) return json({error:'Loopback host required'}, 403);
    const denied = accessGate(req, capability);
    if (denied) return denied;
    try {
      if (joined && interviewRequest(url.pathname) && !joined.available) return json({error:'INTERVIEW_UNAVAILABLE'}, 404);
      if (req.method === 'GET' && url.pathname === '/api/interview') {
        await current();
        const dir = destination();
        return json({...(joined ? {binding:{projectHash:opened.hash, sourceHash:joined.sourceHash, version:joined.version}} : {}), historical:opened.historical, questions:opened.questions.map(question => ({
          ...question, saved:question.editable ? readPicks(dir, question) : null,
          images:question.images.map(({name}, index) => ({name, url:'/api/interview/image/' + question.ref.sha256 + '/' + index})),
        }))});
      }
      const image = /^\/api\/interview\/image\/([a-f0-9]{64})\/(0|[1-9]\d*)$/.exec(url.pathname);
      if (image && req.method === 'GET') {
        await current();
        const asset = opened.questions.find(question => question.ref.sha256 === image[1])?.images[Number(image[2])];
        if (!asset) return json({error:'Not found'}, 404);
        let bytes: Buffer;
        try {bytes = boundBytes(opened.root, asset.ref);}
        catch {throw new Error('INTERVIEW_OPTIONS_STALE: Image bytes changed');}
        if (asset.type === 'image/png' && !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
          return json({error:'INTERVIEW_IMAGE_INVALID'}, 422);
        }
        return new Response(new Uint8Array(bytes), {headers:{...interviewHeaders,
          'Content-Type':asset.type, 'Content-Security-Policy':"default-src 'none'; sandbox"}});
      }
      if (url.pathname === '/api/interview/picks' && req.method === 'POST') {
        if (req.headers.get('origin') !== origin) return json({error:'Same-origin Origin required'}, 403);
        const input = await body(req);
        await current();
        const ref = object(object(input).set);
        const question = opened.questions.find(question => question.editable && question.ref.path === ref.path && question.ref.sha256 === ref.sha256);
        if (!question) {
          if (opened.questions.some(question => question.ref.path === ref.path)) {
            throw new Error('INTERVIEW_OPTIONS_STALE: Displayed set is changed or superseded');
          }
          return invalid('Displayed set is not registered');
        }
        return json(savePicks(destination(), question, input));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /^INTERVIEW_[A-Z_]+:/.exec(message)?.[0].slice(0,-1) ?? 'INTERVIEW_CHOICE_INVALID';
      return json({error:code}, code === 'INTERVIEW_OPTIONS_STALE' ? 409 : 400);
    }
  };
}
