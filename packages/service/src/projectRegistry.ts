import * as fs from 'fs';
import * as path from 'path';

export interface AgentOsProjectEntry {
  registryKey: string;
  name: string;
  aliases: string[];
  color?: string | null;
  localRepoPath: string | null;
  githubRepo: string | null;
  repoLess?: boolean;
  description?: string | null;
  relatedDomains?: string[];
  id?: string | null;
  updatedAt?: string;
  createdAt?: string | null;
}

export interface AgentOsProjectRegistryState {
  schemaVersion: string;
  entries: AgentOsProjectEntry[];
}

export interface ProjectMetadata {
  registryKey: string;
  projectName: string;
  localRepoPath: string | null;
  githubRepo: string | null;
  githubOwner: string | null;
  githubRepoName: string | null;
  vercelTeam?: string;
  vercelProject?: string;
  supabaseProjectRef?: string;
  projectDomain?: string;
  matchedBy: string;
}

export const DEFAULT_AGENTOS_REGISTRY_PATH =
  'D:\\_Dev\\Apps\\AgentOS\\.agent-os\\state\\project-registry.json';
export const AGENTOS_PROJECT_REGISTRY_SCHEMA_VERSION = 'project-registry-state-1';
export const DEFAULT_REGISTRY_REFRESH_INTERVAL_MS = 1_000;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Read-only adapter over AgentOS-owned project identity state.
 *
 * This class deliberately does NOT resolve aliases, names, ChatGPT titles/slugs,
 * Vercel slugs, or other lexical candidates. AgentOS is the identity authority;
 * StreamDockBridge may only project an exact AgentOS-declared binding into the
 * browser context it already owns.
 */
export class ProjectRegistryService {
  private entries: AgentOsProjectEntry[] = [];
  private lastLoadedAt = 0;
  private lastCheckedAt = 0;
  private lastMtimeMs: number | null = null;
  private healthy = false;

  constructor(
    private registryPath = DEFAULT_AGENTOS_REGISTRY_PATH,
    private refreshIntervalMs = DEFAULT_REGISTRY_REFRESH_INTERVAL_MS
  ) {
    this.reload();
  }

  public reload(): void {
    this.lastCheckedAt = Date.now();
    try {
      if (!fs.existsSync(this.registryPath)) {
        this.clearLoadedState();
        return;
      }

      const stat = fs.statSync(this.registryPath);
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const validated = this.validateState(parsed);
      if (!validated) {
        this.clearLoadedState();
        this.lastMtimeMs = stat.mtimeMs;
        return;
      }

      this.entries = validated.entries;
      this.lastLoadedAt = Date.now();
      this.lastMtimeMs = stat.mtimeMs;
      this.healthy = true;
    } catch (_e) {
      this.clearLoadedState();
    }
  }

  private clearLoadedState(): void {
    this.entries = [];
    this.healthy = false;
    this.lastLoadedAt = 0;
    this.lastMtimeMs = null;
  }

  private ensureFresh(now = Date.now()): void {
    if (this.refreshIntervalMs > 0 && now - this.lastCheckedAt < this.refreshIntervalMs) return;
    this.lastCheckedAt = now;

    try {
      if (!fs.existsSync(this.registryPath)) {
        if (this.healthy || this.entries.length > 0) this.clearLoadedState();
        return;
      }
      const stat = fs.statSync(this.registryPath);
      if (!this.healthy || this.lastMtimeMs === null || stat.mtimeMs !== this.lastMtimeMs) {
        this.reload();
      }
    } catch (_e) {
      this.clearLoadedState();
    }
  }

  private validateState(value: unknown): AgentOsProjectRegistryState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (raw.schemaVersion !== AGENTOS_PROJECT_REGISTRY_SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.entries)) return null;

    const entries: AgentOsProjectEntry[] = [];
    const registryKeys = new Set<string>();
    for (const candidate of raw.entries) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const entry = candidate as Record<string, unknown>;
      if (typeof entry.registryKey !== 'string' || !entry.registryKey.trim()) return null;
      if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
      if (!isStringArray(entry.aliases)) return null;
      if (entry.relatedDomains !== undefined && !isStringArray(entry.relatedDomains)) return null;
      if (entry.localRepoPath !== null && typeof entry.localRepoPath !== 'string') return null;
      if (entry.githubRepo !== null && typeof entry.githubRepo !== 'string') return null;

      const key = normalized(entry.registryKey);
      if (registryKeys.has(key)) return null;
      registryKeys.add(key);

      entries.push({
        registryKey: entry.registryKey.trim(),
        name: entry.name.trim(),
        aliases: [...entry.aliases],
        color: typeof entry.color === 'string' ? entry.color : null,
        localRepoPath:
          typeof entry.localRepoPath === 'string' && entry.localRepoPath.trim()
            ? entry.localRepoPath.trim()
            : null,
        githubRepo:
          typeof entry.githubRepo === 'string' && entry.githubRepo.trim()
            ? entry.githubRepo.trim()
            : null,
        repoLess: entry.repoLess === true,
        description: typeof entry.description === 'string' ? entry.description : null,
        relatedDomains: entry.relatedDomains ? [...entry.relatedDomains] : [],
        id: typeof entry.id === 'string' ? entry.id : null,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
      });
    }

    return { schemaVersion: AGENTOS_PROJECT_REGISTRY_SCHEMA_VERSION, entries };
  }

  public isHealthy(now = Date.now()): boolean {
    this.ensureFresh(now);
    return this.healthy;
  }

  public getEntries(now = Date.now()): AgentOsProjectEntry[] {
    this.ensureFresh(now);
    return this.entries.map((entry) => ({
      ...entry,
      aliases: [...entry.aliases],
      relatedDomains: [...(entry.relatedDomains ?? [])],
    }));
  }

  public getLastLoadedAt(): number {
    return this.lastLoadedAt;
  }

  /** Exact AgentOS registryKey lookup. No alias/name fallback. */
  public resolveProjectByRegistryKey(registryKey: string, now = Date.now()): ProjectMetadata | null {
    this.ensureFresh(now);
    if (!this.healthy || !registryKey.trim()) return null;
    const needle = normalized(registryKey);
    const matches = this.entries.filter((entry) => normalized(entry.registryKey) === needle);
    return matches.length === 1 ? this.enrich(matches[0], `registry-key:${matches[0].registryKey}`) : null;
  }

  /**
   * Resolve browser PAGE context only from exact AgentOS-declared external bindings.
   *
   * Allowed today:
   * - exact GitHub owner/repo against entry.githubRepo
   * - exact hostname against entry.relatedDomains
   *
   * The title argument remains for source compatibility but is intentionally
   * ignored. ChatGPT slugs/titles, aliases, names and Vercel slugs are candidate
   * signals at best and therefore cannot authorize project identity here.
   */
  public resolveProjectFromPage(url: string, _title = '', now = Date.now()): ProjectMetadata | null {
    this.ensureFresh(now);
    if (!this.healthy || !url || typeof url !== 'string') return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (_e) {
      return null;
    }

    if (normalized(parsed.hostname) === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/i, '');
        const exactRepo = normalized(`${owner}/${repo}`);
        const matches = this.entries.filter(
          (entry) => entry.githubRepo && normalized(entry.githubRepo) === exactRepo
        );
        if (matches.length !== 1) return null;
        return this.enrich(matches[0], `github-repo:${exactRepo}`);
      }
    }

    const hostname = normalized(parsed.hostname);
    const matches = this.entries.filter((entry) =>
      (entry.relatedDomains ?? []).some((domain) => normalized(domain) === hostname)
    );
    if (matches.length !== 1) return null;
    return this.enrich(matches[0], `related-domain:${hostname}`);
  }

  private enrich(entry: AgentOsProjectEntry, matchedBy: string): ProjectMetadata {
    let githubOwner: string | null = null;
    let githubRepoName: string | null = null;

    if (entry.githubRepo) {
      const parts = entry.githubRepo.split('/');
      if (parts.length === 2) {
        githubOwner = parts[0];
        githubRepoName = parts[1];
      }
    }

    let vercelTeam: string | undefined;
    let vercelProject: string | undefined;
    let supabaseProjectRef: string | undefined;

    // Non-secret enrichment happens only AFTER exact AgentOS identity is established.
    if (entry.localRepoPath && fs.existsSync(entry.localRepoPath)) {
      try {
        const vercelJsonPath = path.join(entry.localRepoPath, '.vercel', 'project.json');
        if (fs.existsSync(vercelJsonPath)) {
          const raw = fs.readFileSync(vercelJsonPath, 'utf8');
          const v = JSON.parse(raw);
          if (typeof v.orgId === 'string' && v.orgId) vercelTeam = v.orgId;
          if (typeof v.projectName === 'string' && v.projectName) vercelProject = v.projectName;
        }
      } catch (_e) {
        // Enrichment failure never changes identity.
      }

      try {
        const supabaseTomlPath = path.join(entry.localRepoPath, 'supabase', 'config.toml');
        if (fs.existsSync(supabaseTomlPath)) {
          const toml = fs.readFileSync(supabaseTomlPath, 'utf8');
          const match = toml.match(/project_id\s*=\s*["']([a-zA-Z0-9_-]+)["']/);
          if (match) supabaseProjectRef = match[1];
        }
      } catch (_e) {
        // Enrichment failure never changes identity.
      }
    }

    return {
      registryKey: entry.registryKey,
      projectName: entry.name,
      localRepoPath: entry.localRepoPath,
      githubRepo: entry.githubRepo,
      githubOwner,
      githubRepoName,
      vercelTeam,
      vercelProject,
      supabaseProjectRef,
      projectDomain: (entry.relatedDomains ?? [])[0],
      matchedBy,
    };
  }
}
