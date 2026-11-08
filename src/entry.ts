#!/usr/bin/env bun
/** The legacy CLI keeps every argv and exit contract outside the session namespace. */
import {writeSync} from 'node:fs';
import {main as legacyMain} from './cli.ts';
import {jobCommand, type JobCLIOptions} from './job-cli.ts';
import {startJobHost} from './job-front.ts';
import {defaultStateDir, openFingerprint} from './open.ts';
import {JobError} from './job-store.ts';

const sessionUsage = `Usage: rig-review session open <root>
       rig-review session publish <job-url> --generation <n> --key <id> --result <relative-path> --freeze-hold <id> [--selector <JSON>] [--record <path> --record-hash <sha256>]
       rig-review session ask <job-url> --generation <n> --key <id> --publication <id> --subject <JSON>
       rig-review session next <job-url> [--after <cursor>] [--wait-ms <n>]
       rig-review session close <job-url> --generation <n> --key <id> --reason <words>
        rig-review session fetch-act <job-url> --act <actId> --consumer-capability-stdin [--still-out <existing-directory>]
Open requires RIG_REVIEW_JOB_REVIEWER_ID and RIG_REVIEW_JOB_REVIEWER_ROLE (owner or delegate).
RIG_REVIEW_JOB_AGENT_FD optionally delivers the private agent bootstrap on an inherited writable descriptor >= 3.
Agent verbs use RIG_REVIEW_JOB_AGENT_CAPABILITY. Create's writer binding is installed by its trusted host callback.`;

export async function main(args: string[], options: {stateDir?: string; job?: JobCLIOptions} = {}): Promise<void> {
    const sessionArgs = args[0] === 'session' ? args.slice(1) : args[0] === '--' && args[1] === 'session' ? args.slice(2) : null;
    if (!sessionArgs) return legacyMain(args, {stateDir: options.stateDir});
    if (sessionArgs.length === 0 || sessionArgs[0] === '--help' || sessionArgs[0] === '-h') {
        console.log(sessionUsage);
        return;
    }
    return jobCommand(sessionArgs, {
        ...options.job,
        open: options.job?.open ?? (async root => {
            const id = process.env.RIG_REVIEW_JOB_REVIEWER_ID;
            const role = process.env.RIG_REVIEW_JOB_REVIEWER_ROLE;
            if (!id || role !== 'owner' && role !== 'delegate') throw new JobError('JOB_AUTHORITY_REFUSED');
            const rawPort = process.env.RIG_REVIEW_JOB_PORT;
            const port = rawPort === undefined ? undefined : Number(rawPort);
            if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new JobError('JOB_REQUEST_INVALID');
            const rawFD = process.env.RIG_REVIEW_JOB_AGENT_FD;
            const descriptor = rawFD === undefined ? null : Number(rawFD);
            if (descriptor !== null && (!Number.isSafeInteger(descriptor) || descriptor < 3)) throw new JobError('JOB_REQUEST_INVALID');
            const host = await startJobHost({root, stateDir: options.stateDir ?? defaultStateDir(),
                fingerprint: await openFingerprint(), reviewer: {id, role}, port});
            try {
                if (descriptor !== null) {
                    writeSync(descriptor, JSON.stringify({jobId: host.session.jobId, origin: host.origin,
                        agentCapability: host.session.hostCredentials().agent}) + '\n');
                }
            } catch (error) {host.stop(); throw error;}
            if (!host.reused) {
                const stop = () => {host.stop();};
                process.once('SIGINT', stop);
                process.once('SIGTERM', stop);
            } else host.stop();
            return {ownerUrl: host.ownerUrl};
        }),
    });
}

if (import.meta.main) main(Bun.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
