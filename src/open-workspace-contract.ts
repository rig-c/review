import type {OpenInputs} from './open.ts';

export const WORKSPACE_SCHEMA = 'rig-review-open-workspace/1';
export const WORKSPACE_TARGETS_SCHEMA = 'rig-review-open-targets/1';
export const WORKSPACE_VISIBILITY_SCHEMA = 'rig-review-workspace-visibility/1';
export const WORKSPACE_READY_SCHEMA = 'rig-review-workspace-ready/1';
export const WORKSPACE_TARGET_DOMAIN = 'rig-review-target/1';
export const WORKSPACE_TARGET_LIMIT = 32;
export const WORKSPACE_SOCKET_LIMIT = 64;
export const WORKSPACE_BODY_LIMIT = 64 * 1024;
export const WORKSPACE_REGISTRATION_QUEUE = 8;

export interface WorkspaceDesignation {
  key: string;
  contentHash: string;
  inputs: OpenInputs;
  cwd: string;
  viewOnly: boolean;
}

export interface WorkspaceRecord {
  schema: typeof WORKSPACE_SCHEMA;
  incarnation: string;
  pid: number;
  uid: number;
  origin: string;
  installation: string;
  fingerprint: string;
  runtime: string;
  registrationCapability: string;
  ownerCapability: string;
}

export interface WorkspaceStoredTarget {
  designation: WorkspaceDesignation;
  controlToken?: string;
}

export interface WorkspaceRegistry {
  schema: typeof WORKSPACE_TARGETS_SCHEMA;
  incarnation: string;
  targets: WorkspaceStoredTarget[];
}

export interface WorkspaceTargetView {
  key: string;
  contentHash: string;
  title: string;
  mode: 'single' | 'compare';
  animation: string | null;
  viewOnly: boolean;
  unavailable: string | null;
  entry: string;
}

export interface WorkspaceList {
  schema: typeof WORKSPACE_SCHEMA;
  incarnation: string;
  targets: WorkspaceTargetView[];
}
