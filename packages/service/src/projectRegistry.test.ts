import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProjectRegistryService,
  DEFAULT_AGENTOS_REGISTRY_PATH,
  AGENTOS_PROJECT_REGISTRY_SCHEMA_VERSION,
} from './projectRegistry';

describe('ProjectRegistryService', () => {
  it('loads the real AgentOS project registry only when its schema is valid', () => {
    const service = new ProjectRegistryService(DEFAULT_AGENTOS_REGISTRY_PATH);
    if (fs.existsSync(DEFAULT_AGENTOS_REGISTRY_PATH)) {
      expect(service.isHealthy()).toBe(true);
      expect(service.getEntries().length).toBeGreaterThan(0);
    }
  });

  describe('exact project resolution with mock registry', () => {
    let tempRegistryPath: string;
    let service: ProjectRegistryService;

    const write = (entries: any[], schemaVersion = AGENTOS_PROJECT_REGISTRY_SCHEMA_VERSION) => {
      fs.writeFileSync(
        tempRegistryPath,
        JSON.stringify({ schemaVersion, entries }, null, 2),
        'utf8'
      );
      const now = new Date(Date.now() + 20);
      fs.utimesSync(tempRegistryPath, now, now);
    };

    const baseEntries = () => [
      {
        registryKey: 'adhdeploy',
        name: 'ADHDeploy',
        aliases: ['ChatGPT: ADHDeploy'],
        localRepoPath: null,
        githubRepo: 'cmarabate/adhdeploy',
        relatedDomains: ['adhdeploy.vercel.app'],
      },
      {
        registryKey: 'gbc-lounge',
        name: 'Oasis Culture Lounge',
        aliases: ['ChatGPT: GBC Lounge'],
        localRepoPath: null,
        githubRepo: 'cmarabate/gbclounge.com',
        relatedDomains: ['gbclounge.com', 'greenbeanoasis.com'],
      },
      {
        registryKey: 'ideaforge',
        name: 'IdeaForge',
        aliases: ['ChatGPT: IdeaForge'],
        localRepoPath: null,
        githubRepo: 'cmarabate/IdeaForge',
        relatedDomains: [],
      },
    ];

    beforeEach(() => {
      tempRegistryPath = path.join(
        os.tmpdir(),
        `test-project-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
      write(baseEntries());
      service = new ProjectRegistryService(tempRegistryPath, 0);
    });

    afterEach(() => {
      try {
        if (fs.existsSync(tempRegistryPath)) fs.unlinkSync(tempRegistryPath);
      } catch (_e) {
        // Cleanup
      }
    });

    it('resolves only an exact GitHub owner/repo binding', () => {
      const p = service.resolveProjectFromPage('https://github.com/cmarabate/adhdeploy/pull/42');
      expect(p).not.toBeNull();
      expect(p?.registryKey).toBe('adhdeploy');
      expect(p?.projectName).toBe('ADHDeploy');
      expect(p?.githubOwner).toBe('cmarabate');
      expect(p?.githubRepoName).toBe('adhdeploy');
      expect(p?.matchedBy).toBe('github-repo:cmarabate/adhdeploy');
    });

    it('normalizes only bounded case and .git syntax for GitHub matching', () => {
      const p = service.resolveProjectFromPage('https://github.com/CMARABATE/IdeaForge.git');
      expect(p?.registryKey).toBe('ideaforge');
    });

    it('resolves only an exact declared relatedDomain', () => {
      expect(service.resolveProjectFromPage('https://gbclounge.com/menu')?.registryKey).toBe(
        'gbc-lounge'
      );
      expect(service.resolveProjectFromPage('https://shop.gbclounge.com/menu')).toBeNull();
    });

    it('fails closed when two projects declare the same GitHub binding', () => {
      write([
        ...baseEntries(),
        {
          registryKey: 'duplicate',
          name: 'Duplicate',
          aliases: [],
          localRepoPath: null,
          githubRepo: 'cmarabate/adhdeploy',
          relatedDomains: [],
        },
      ]);
      expect(service.resolveProjectFromPage('https://github.com/cmarabate/adhdeploy')).toBeNull();
    });

    it('fails closed when two projects declare the same related domain', () => {
      write([
        ...baseEntries(),
        {
          registryKey: 'duplicate',
          name: 'Duplicate',
          aliases: [],
          localRepoPath: null,
          githubRepo: null,
          relatedDomains: ['gbclounge.com'],
        },
      ]);
      expect(service.resolveProjectFromPage('https://gbclounge.com')).toBeNull();
    });

    it('does not authorize ChatGPT project slugs', () => {
      expect(
        service.resolveProjectFromPage(
          'https://chatgpt.com/g/g-p-6a2dd799c9d88191a5636f7ccee42ece-oasis-culture-lounge/c/x'
        )
      ).toBeNull();
      expect(service.resolveProjectFromPage('https://chat.openai.com/g/g-p-99999999-ideaforge')).toBeNull();
    });

    it('does not authorize ChatGPT titles, names, or aliases', () => {
      expect(
        service.resolveProjectFromPage(
          'https://chatgpt.com/c/conv-1234',
          'Oasis Culture Lounge - Reconcile StoryForge Repository Truth'
        )
      ).toBeNull();
      expect(
        service.resolveProjectFromPage('https://chatgpt.com/c/conv-9999', 'GBC Lounge - Architecture')
      ).toBeNull();
      expect(
        service.resolveProjectFromPage('https://chatgpt.com/c/conv-5678', 'ChatGPT - IdeaForge')
      ).toBeNull();
    });

    it('does not authorize inferred Vercel/name slugs', () => {
      expect(service.resolveProjectFromPage('https://vercel.com/cmarabate/adhdeploy/deployments')).toBeNull();
    });

    it('supports exact registryKey validation without alias fallback', () => {
      expect(service.resolveProjectByRegistryKey(' GBC-LOUNGE ')?.projectName).toBe(
        'Oasis Culture Lounge'
      );
      expect(service.resolveProjectByRegistryKey('GBC Lounge')).toBeNull();
      expect(service.resolveProjectByRegistryKey('does-not-exist')).toBeNull();
    });

    it('uses AgentOS canonical metadata rather than caller/page wording', () => {
      const p = service.resolveProjectFromPage(
        'https://github.com/cmarabate/gbclounge.com',
        'Definitely Not The Canonical Project Name'
      );
      expect(p?.projectName).toBe('Oasis Culture Lounge');
      expect(p?.githubRepo).toBe('cmarabate/gbclounge.com');
    });

    it('fails closed for the wrong schema or malformed state', () => {
      write(baseEntries(), 'unexpected-schema');
      expect(service.isHealthy()).toBe(false);
      expect(service.resolveProjectFromPage('https://github.com/cmarabate/adhdeploy')).toBeNull();

      fs.writeFileSync(tempRegistryPath, '{broken', 'utf8');
      const now = new Date(Date.now() + 40);
      fs.utimesSync(tempRegistryPath, now, now);
      expect(service.resolveProjectByRegistryKey('adhdeploy')).toBeNull();
      expect(service.isHealthy()).toBe(false);
    });

    it('observes registry changes without a service restart', () => {
      expect(service.resolveProjectFromPage('https://new.example.com')).toBeNull();
      write([
        ...baseEntries(),
        {
          registryKey: 'new-project',
          name: 'New Project',
          aliases: [],
          localRepoPath: null,
          githubRepo: null,
          relatedDomains: ['new.example.com'],
        },
      ]);
      expect(service.resolveProjectFromPage('https://new.example.com')?.registryKey).toBe(
        'new-project'
      );
    });

    it('fails closed for unrelated pages', () => {
      expect(service.resolveProjectFromPage('https://google.com')).toBeNull();
      expect(service.resolveProjectFromPage('https://disneyplus.com/play/12345')).toBeNull();
    });
  });
});
