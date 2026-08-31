import * as fs from 'fs';
import * as path from 'path';
import { ProjectRegistryService, DEFAULT_AGENTOS_REGISTRY_PATH } from './projectRegistry';

describe('ProjectRegistryService', () => {
  it('loads real AgentOS project registry if present', () => {
    const service = new ProjectRegistryService(DEFAULT_AGENTOS_REGISTRY_PATH);
    const entries = service.getEntries();
    if (fs.existsSync(DEFAULT_AGENTOS_REGISTRY_PATH)) {
      expect(entries.length).toBeGreaterThan(0);
      const keys = entries.map((e) => e.registryKey);
      expect(keys).toContain('adhdeploy');
      expect(keys).toContain('ideaforge');
      expect(keys).toContain('gbc-lounge');
    }
  });

  describe('project resolution with mock registry', () => {
    let tempRegistryPath: string;
    let service: ProjectRegistryService;

    beforeEach(() => {
      tempRegistryPath = path.join(
        process.env.TEMP || 'C:\\Windows\\Temp',
        `test-project-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );

      const mockData = {
        schemaVersion: 'project-registry-state-1',
        entries: [
          {
            registryKey: 'adhdeploy',
            name: 'ADHDeploy',
            aliases: ['ChatGPT: ADHDeploy'],
            localRepoPath: 'D:\\_Dev\\Apps\\adhdeploy',
            githubRepo: 'cmarabate/adhdeploy',
            relatedDomains: ['adhdeploy.vercel.app'],
          },
          {
            registryKey: 'gbc-lounge',
            name: 'Oasis Culture Lounge',
            aliases: ['ChatGPT: GBC Lounge'],
            localRepoPath: 'D:\\_Dev\\Websites\\gbclounge.com',
            githubRepo: 'cmarabate/gbclounge.com',
            relatedDomains: ['gbclounge.com', 'greenbeanoasis.com'],
          },
          {
            registryKey: 'ideaforge',
            name: 'IdeaForge',
            aliases: ['ChatGPT: IdeaForge'],
            localRepoPath: 'D:\\_Dev\\Apps\\IdeaForge',
            githubRepo: 'cmarabate/IdeaForge',
            relatedDomains: [],
          },
        ],
      };

      fs.writeFileSync(tempRegistryPath, JSON.stringify(mockData, null, 2), 'utf8');
      service = new ProjectRegistryService(tempRegistryPath);
    });

    afterEach(() => {
      try {
        if (fs.existsSync(tempRegistryPath)) fs.unlinkSync(tempRegistryPath);
      } catch (e) {
        // Cleanup
      }
    });

    it('resolves project from GitHub URL with owner/repo parsing', () => {
      const p1 = service.resolveProjectFromPage('https://github.com/cmarabate/adhdeploy/pull/42');
      expect(p1).not.toBeNull();
      expect(p1?.registryKey).toBe('adhdeploy');
      expect(p1?.projectName).toBe('ADHDeploy');
      expect(p1?.githubOwner).toBe('cmarabate');
      expect(p1?.githubRepoName).toBe('adhdeploy');
      expect(p1?.matchedBy).toContain('github-url');

      const p2 = service.resolveProjectFromPage('https://github.com/cmarabate/gbclounge.com.git');
      expect(p2).not.toBeNull();
      expect(p2?.registryKey).toBe('gbc-lounge');
      expect(p2?.githubRepoName).toBe('gbclounge.com');
    });

    it('resolves project from ChatGPT project URL slug', () => {
      const p1 = service.resolveProjectFromPage(
        'https://chatgpt.com/g/g-p-6a2dd799c9d88191a5636f7ccee42ece-oasis-culture-lounge/c/6a9281c2-2afc-83e9-ab83-46004e792376'
      );
      expect(p1).not.toBeNull();
      expect(p1?.registryKey).toBe('gbc-lounge');
      expect(p1?.projectName).toBe('Oasis Culture Lounge');

      const p2 = service.resolveProjectFromPage(
        'https://chat.openai.com/g/g-p-99999999-ideaforge'
      );
      expect(p2).not.toBeNull();
      expect(p2?.registryKey).toBe('ideaforge');
    });

    it('resolves project from ChatGPT page title when URL has no project slug', () => {
      const p1 = service.resolveProjectFromPage(
        'https://chatgpt.com/c/conv-1234',
        'Oasis Culture Lounge - Reconcile StoryForge Repository Truth'
      );
      expect(p1).not.toBeNull();
      expect(p1?.registryKey).toBe('gbc-lounge');

      const p2 = service.resolveProjectFromPage(
        'https://chatgpt.com/c/conv-5678',
        'ChatGPT - IdeaForge'
      );
      expect(p2).not.toBeNull();
      expect(p2?.registryKey).toBe('ideaforge');

      const p3 = service.resolveProjectFromPage(
        'https://chatgpt.com/c/conv-9999',
        'GBC Lounge - Architecture Discussion'
      );
      expect(p3).not.toBeNull();
      expect(p3?.registryKey).toBe('gbc-lounge');
    });

    it('resolves project from Vercel dashboard URL', () => {
      const p = service.resolveProjectFromPage('https://vercel.com/cmarabate/adhdeploy/deployments');
      expect(p).not.toBeNull();
      expect(p?.registryKey).toBe('adhdeploy');
    });

    it('resolves project from related domains', () => {
      const p = service.resolveProjectFromPage('https://gbclounge.com/menu/drinks');
      expect(p).not.toBeNull();
      expect(p?.registryKey).toBe('gbc-lounge');
    });

    it('fails closed (returns null) for unrelated or ambiguous pages', () => {
      expect(service.resolveProjectFromPage('https://google.com')).toBeNull();
      expect(service.resolveProjectFromPage('https://disneyplus.com/play/12345')).toBeNull();
      expect(
        service.resolveProjectFromPage(
          'https://chatgpt.com/c/generic-chat',
          'Explain Quantum Mechanics - ChatGPT'
        )
      ).toBeNull();
    });

    it('does not synthesize unverified production domains when relatedDomains is empty', () => {
      const p = service.resolveProjectFromPage('https://chat.openai.com/g/g-p-99999999-ideaforge');
      expect(p).not.toBeNull();
      expect(p?.registryKey).toBe('ideaforge');
      expect(p?.projectDomain).toBeUndefined();
    });
  });
});
