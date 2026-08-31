import * as fs from 'fs';
import * as path from 'path';

export interface AgentOsProjectEntry {
  registryKey: string;
  name: string;
  aliases: string[];
  color?: string;
  localRepoPath: string | null;
  githubRepo: string | null;
  repoLess?: boolean;
  relatedDomains?: string[];
  id?: string;
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

export class ProjectRegistryService {
  private registryPath: string;
  private entries: AgentOsProjectEntry[] = [];
  private lastLoadedAt = 0;

  constructor(registryPath = DEFAULT_AGENTOS_REGISTRY_PATH) {
    this.registryPath = registryPath;
    this.reload();
  }

  public reload(): void {
    try {
      if (fs.existsSync(this.registryPath)) {
        const raw = fs.readFileSync(this.registryPath, 'utf8');
        const parsed: AgentOsProjectRegistryState = JSON.parse(raw);
        if (Array.isArray(parsed?.entries)) {
          this.entries = parsed.entries;
          this.lastLoadedAt = Date.now();
        }
      }
    } catch (e) {
      // Graceful fallback if file unreadable
    }
  }

  public getEntries(): AgentOsProjectEntry[] {
    return this.entries;
  }

  public resolveProjectFromPage(url: string, title = ''): ProjectMetadata | null {
    if (!url || typeof url !== 'string') return null;

    // 1. GitHub match (highest precision)
    const githubMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
    if (githubMatch) {
      const owner = githubMatch[1];
      const repo = githubMatch[2].replace(/\.git$/i, '');
      const full = `${owner}/${repo}`.toLowerCase();

      for (const entry of this.entries) {
        if (entry.githubRepo && entry.githubRepo.toLowerCase() === full) {
          return this.enrich(entry, `github-url:${full}`);
        }
      }
    }

    // 2. ChatGPT Project match
    const chatGptMatch = url.match(
      /^https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/g\/g-p-[a-f0-9]+-([a-z0-9-]+)/i
    );
    if (chatGptMatch) {
      const slug = chatGptMatch[1].toLowerCase();
      const match = this.matchBySlugOrAlias(slug);
      if (match) {
        return this.enrich(match, `chatgpt-slug:${slug}`);
      }
    }

    // 3. ChatGPT Title extraction (e.g. "Oasis Culture Lounge - Reconcile...")
    if (/https?:\/\/(?:chatgpt\.com|chat\.openai\.com)/i.test(url) && title) {
      const cleanTitle = title
        .replace(/^ChatGPT\s*[-|:]\s*/i, '')
        .replace(/\s*[-|:]\s*ChatGPT$/i, '')
        .trim();

      const parts = cleanTitle.split(/\s*[-|:]\s*/);
      for (const candidate of parts) {
        const trimmed = candidate.trim();
        if (trimmed.length > 2) {
          const match = this.matchByNameOrAlias(trimmed);
          if (match) {
            return this.enrich(match, `chatgpt-title:${trimmed}`);
          }
        }
      }
    }

    // 4. Vercel Dashboard match
    const vercelMatch = url.match(/^https?:\/\/vercel\.com\/([^/]+)\/([^/?#]+)/i);
    if (vercelMatch) {
      const vercelProj = vercelMatch[2].toLowerCase();
      for (const entry of this.entries) {
        const enriched = this.enrich(entry, `vercel-url:${vercelProj}`);
        if (
          enriched.vercelProject?.toLowerCase() === vercelProj ||
          entry.registryKey.toLowerCase() === vercelProj ||
          this.slugify(entry.name) === vercelProj
        ) {
          return enriched;
        }
      }
    }

    // 5. Related domains match
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      for (const entry of this.entries) {
        if (
          Array.isArray(entry.relatedDomains) &&
          entry.relatedDomains.some((d) => d.toLowerCase() === hostname)
        ) {
          return this.enrich(entry, `related-domain:${hostname}`);
        }
      }
    } catch (e) {
      // Invalid URL
    }

    return null;
  }

  private matchBySlugOrAlias(slug: string): AgentOsProjectEntry | null {
    for (const entry of this.entries) {
      // Exact registryKey match
      if (entry.registryKey.toLowerCase() === slug) return entry;
      // Slugified name match
      if (this.slugify(entry.name) === slug) return entry;
      // Alias match
      if (Array.isArray(entry.aliases)) {
        for (const alias of entry.aliases) {
          const cleanAlias = alias.replace(/^ChatGPT:\s*/i, '').trim();
          if (
            this.slugify(cleanAlias) === slug ||
            cleanAlias.toLowerCase() === slug
          ) {
            return entry;
          }
        }
      }
    }
    return null;
  }

  private matchByNameOrAlias(text: string): AgentOsProjectEntry | null {
    const textLower = text.toLowerCase();
    const textSlug = this.slugify(text);

    for (const entry of this.entries) {
      if (entry.name.toLowerCase() === textLower || this.slugify(entry.name) === textSlug) {
        return entry;
      }
      if (entry.registryKey.toLowerCase() === textLower || entry.registryKey.toLowerCase() === textSlug) {
        return entry;
      }
      if (Array.isArray(entry.aliases)) {
        for (const alias of entry.aliases) {
          const cleanAlias = alias.replace(/^ChatGPT:\s*/i, '').trim().toLowerCase();
          if (cleanAlias === textLower || this.slugify(cleanAlias) === textSlug) {
            return entry;
          }
        }
      }
    }
    return null;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
    let projectDomain: string | undefined;

    // Discover non-secret routing metadata from localRepoPath if available
    if (entry.localRepoPath && fs.existsSync(entry.localRepoPath)) {
      try {
        const vercelJsonPath = path.join(entry.localRepoPath, '.vercel', 'project.json');
        if (fs.existsSync(vercelJsonPath)) {
          const raw = fs.readFileSync(vercelJsonPath, 'utf8');
          const v = JSON.parse(raw);
          if (v.orgId) vercelTeam = v.orgId;
          if (v.projectName) vercelProject = v.projectName;
          else if (v.projectId) vercelProject = entry.registryKey;
        }
      } catch (e) {
        // Ignore unreadable config
      }

      // Check for non-secret supabase/config.toml project_id if present
      try {
        const supabaseTomlPath = path.join(entry.localRepoPath, 'supabase', 'config.toml');
        if (fs.existsSync(supabaseTomlPath)) {
          const toml = fs.readFileSync(supabaseTomlPath, 'utf8');
          const match = toml.match(/project_id\s*=\s*["']([a-zA-Z0-9_-]+)["']/);
          if (match) {
            supabaseProjectRef = match[1];
          }
        }
      } catch (e) {
        // Ignore
      }

      // If relatedDomains exists, use primary domain strictly from registry
      if (Array.isArray(entry.relatedDomains) && entry.relatedDomains.length > 0) {
        projectDomain = entry.relatedDomains[0];
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
      projectDomain,
      matchedBy,
    };
  }
}
