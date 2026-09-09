import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from '../knowledge/frontmatter.ts';
import { getConfigRoot } from './config-loader.ts';
import {
  inspectSkillPackage,
  readSkillPackageText,
  SkillPackageError,
  type SkillPackageSnapshot,
} from './skill-package.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface InstalledSkill {
  id: string;
  displayName: string;
  description: string;
  readiness: 'ready' | 'needs_binding' | 'blocked';
  missingCapabilities: string[];
  package: SkillPackageSnapshot;
}

export interface InstalledSkillCatalogSnapshot {
  catalogHash: string;
  skills: InstalledSkill[];
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function firstBodyParagraph(markdown: string): string {
  const { content } = parseFrontmatter(markdown);
  return content.split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/^#+\s+.*$/gmu, '').trim())
    .find(Boolean) ?? '';
}

function packageStatus(frontmatter: Record<string, unknown>): InstalledSkill['readiness'] {
  const status = typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : '';
  return status === 'candidate' || status === 'draft' || status === 'deprecated'
    ? 'blocked'
    : 'ready';
}

function description(snapshot: SkillPackageSnapshot, entry: string): string {
  const whenToUse = snapshot.frontmatter.when_to_use;
  if (typeof whenToUse === 'string' && whenToUse.trim()) return whenToUse.trim();
  if (snapshot.description) return snapshot.description;
  return firstBodyParagraph(entry) || snapshot.name;
}

function findPackages(rootPath: string): string[] {
  const configuredRoot = resolve(rootPath);
  let root: string;
  try {
    if (lstatSync(configuredRoot).isSymbolicLink()) {
      throw new SkillPackageError(`catalog root must not be a symbolic link: ${configuredRoot}`);
    }
    root = realpathSync(configuredRoot);
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!statSync(root).isDirectory()) return [];
  const packages: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      packages.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new SkillPackageError(
          `catalog contains a symbolic link: ${relative(root, resolve(directory, entry.name)).split(sep).join('/')}`,
        );
      }
      if (entry.isDirectory()) visit(resolve(directory, entry.name));
    }
  };
  visit(root);
  return packages.sort();
}

function configuredRoots(): string[] {
  const defaults = [
    resolve(getConfigRoot(), 'skills'),
    resolve(getConfigRoot(), 'knowledge-base/skills'),
  ];
  const raw = process.env.SKILL_PACKAGE_ROOTS;
  if (!raw?.trim()) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillPackageError('SKILL_PACKAGE_ROOTS must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new SkillPackageError('SKILL_PACKAGE_ROOTS must be a JSON array of paths');
  }
  return [...new Set([...defaults, ...parsed.map((path) => resolve(path))])];
}

export class InstalledSkillCatalog {
  private snapshot: InstalledSkillCatalogSnapshot | null = null;

  constructor(private readonly roots?: readonly string[]) {}

  scan(): InstalledSkillCatalogSnapshot {
    if (this.snapshot) return this.snapshot;
    const roots = this.roots ?? configuredRoots();
    const packages = roots.flatMap(findPackages).map((rootPath) => inspectSkillPackage({ rootPath }));
    const ids = new Set<string>();
    const skills = packages.map((snapshot): InstalledSkill => {
      const id = snapshot.name.trim() || basename(snapshot.rootPath);
      if (!SAFE_ID.test(id)) throw new SkillPackageError(`invalid package id: ${id}`);
      if (ids.has(id)) throw new SkillPackageError(`duplicate package id: ${id}`);
      ids.add(id);
      const entry = readSkillPackageText(snapshot, snapshot.entryPath);
      return {
        id,
        displayName: typeof snapshot.frontmatter.title === 'string' && snapshot.frontmatter.title.trim()
          ? snapshot.frontmatter.title.trim()
          : id,
        description: description(snapshot, entry),
        readiness: packageStatus(snapshot.frontmatter),
        missingCapabilities: [],
        package: snapshot,
      };
    }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const catalogHash = digest(skills.map(({ id, readiness, package: snapshot }) => (
      `${id}\0${readiness}\0${snapshot.packageHash}\n`
    )).join(''));
    this.snapshot = { catalogHash, skills };
    return this.snapshot;
  }

  get(id: string): InstalledSkill | null {
    return this.scan().skills.find((skill) => skill.id === id) ?? null;
  }
}
