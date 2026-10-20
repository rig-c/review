/**
 * What `rig-parts rig` (and `remesh`) writes into a rig directory, as review compares it (#125): the JSON documents by
 * name, and the part images under `images/` by hash. The baseline (`src/baseline.ts`, does the handoff reproduce the
 * inspected rig?) and the applied-state diff (`src/rebuild.ts`, what did the patch change?) both read this one list, so a
 * document the producer starts writing is one line here. Pure: no imports, no IO.
 */
export const PRODUCER_DOCUMENTS = ['rig.json', 'motion.json', 'sets.json', 'mesh_report.json'] as const;
export type ProducerDocument = typeof PRODUCER_DOCUMENTS[number];
/** The part images' directory inside a rig directory; compared by hash, file by file. */
export const PRODUCER_IMAGES_DIR = 'images';
export const isProducerFile = (path: string): boolean => (PRODUCER_DOCUMENTS as readonly string[]).includes(path) || path.startsWith(`${PRODUCER_IMAGES_DIR}/`);
