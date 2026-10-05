import type { ToolId } from './types';

export interface SkillSource {
  kind: 'local' | 'repository' | 'tool';
  label: string;
  path?: string;
  url?: string;
  ref?: string;
  commit?: string;
  subpath?: string;
  tool?: ToolId;
}
export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
}
export interface SkillDeployment {
  tool: ToolId;
  path: string;
  state: 'disabled' | 'deployed' | 'modified' | 'missing' | 'conflict';
  message: string;
  /** True only for an unchanged ordinary external directory matching the library. */
  canAdopt?: boolean;
}
export interface ManagedSkill extends SkillMetadata {
  id: string;
  directory: string;
  source: SkillSource;
  importedAt: string;
  files: string[];
  sizeBytes: number;
  deployments: SkillDeployment[];
}
export interface SkillTarget {
  tool: ToolId;
  name: string;
  directory: string;
  scanDirectories: string[];
  canDeploy: boolean;
  sharedWith: ToolId[];
  note: string;
  docsUrl: string;
}
export interface SkillSnapshot { skills: ManagedSkill[]; targets: SkillTarget[]; libraryDir: string }
export interface SkillRepositoryInput { url: string; ref?: string; subpath?: string }
export interface SkillImportResult { imported: ManagedSkill[]; skipped: string[] }
export interface SkillFilePreview { path: string; content: string; sizeBytes: number }
export interface SkillRemovePreview { id: string; name: string; paths: string[]; canRemove: boolean; message: string }
