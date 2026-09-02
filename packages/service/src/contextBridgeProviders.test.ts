import { readProviderContext } from './contextBridgeProviders';

/**
 * The whole point of this module is what it REFUSES to conclude. A title that
 * reads like a project name, a slug that looks like a registry key, a custom
 * GPT whose id merely starts with `g-` — none of them prove project scope. Only
 * the `/g/g-p-.../` path does.
 */

describe('ChatGPT project evidence', () => {
  it('proves project scope from the URL path and preserves the id exactly', () => {
    const evidence = readProviderContext(
      'https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-oasis-culture-lounge/project'
    );

    expect(evidence).toEqual({
      provider: 'chatgpt',
      scope: 'project',
      externalProjectId: 'g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-oasis-culture-lounge',
      projectDisplayLabel: 'oasis-culture-lounge',
      conversationId: null,
      evidence: {
        proof: 'chatgpt-project-url-path',
        matchedPathSegment: 'g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-oasis-culture-lounge',
        labelSource: 'chatgpt-project-url-slug',
        conversationSource: null,
      },
    });
  });

  it('keeps the segment byte-for-byte rather than normalizing or slicing it', () => {
    const segment = 'g-p-68F0A1B2C3D4E5F6-Mixed_Case.Slug';
    const evidence = readProviderContext(`https://chatgpt.com/g/${segment}/project`);

    expect(evidence).toMatchObject({
      scope: 'project',
      externalProjectId: segment,
      projectDisplayLabel: 'Mixed_Case.Slug',
    });
  });

  it('reads a conversation id only from a well-formed project conversation path', () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const inProject = readProviderContext(
      `https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f6-demo/c/${uuid}`
    );
    expect(inProject).toMatchObject({
      scope: 'project',
      conversationId: uuid,
      evidence: { conversationSource: 'chatgpt-project-conversation-url-path' },
    });

    const malformed = readProviderContext(
      'https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f6-demo/c/not-a-uuid'
    );
    expect(malformed).toMatchObject({ scope: 'project', conversationId: null });
    expect(malformed).toMatchObject({ evidence: { conversationSource: null } });
  });

  it('reports no display label when the segment carries no slug', () => {
    const evidence = readProviderContext(
      'https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e'
    );
    expect(evidence).toMatchObject({
      scope: 'project',
      projectDisplayLabel: null,
      evidence: { labelSource: null },
    });
  });

  it('accepts the legacy chat.openai.com host and a www prefix', () => {
    for (const host of ['chat.openai.com', 'www.chatgpt.com']) {
      expect(readProviderContext(`https://${host}/g/g-p-abcd1234-demo/project`)).toMatchObject({
        scope: 'project',
        externalProjectId: 'g-p-abcd1234-demo',
      });
    }
  });
});

/**
 * The project id is OPAQUE.
 *
 * This reader once required the core after `g-p-` to be hexadecimal. That was a
 * fact about the ids OpenAI happens to mint today, not about the shape that
 * proves a project — and encoding it meant ContextBridge would have refused a
 * perfectly real project because it disagreed with the provider about what the
 * provider's own identifiers may contain. Only the `g-p-` prefix is proof; the
 * core is read and preserved, never interpreted.
 */
describe('opaque project ids', () => {
  it('recognizes a project id that is not hexadecimal', () => {
    const segment = 'g-p-68zx9QW3kv7ty2rs-roadmap';
    const evidence = readProviderContext(`https://chatgpt.com/g/${segment}/project`);

    expect(evidence).toEqual({
      provider: 'chatgpt',
      scope: 'project',
      externalProjectId: segment,
      projectDisplayLabel: 'roadmap',
      conversationId: null,
      evidence: {
        proof: 'chatgpt-project-url-path',
        matchedPathSegment: segment,
        labelSource: 'chatgpt-project-url-slug',
        conversationSource: null,
      },
    });
  });

  it('preserves a non-hex segment exactly, with and without a slug', () => {
    const withSlug = 'g-p-ZZ99xyQQ-StreamDockBridge_v2';
    const bare = 'g-p-ZZ99xyQQ';

    expect(readProviderContext(`https://chatgpt.com/g/${withSlug}/project`)).toMatchObject({
      externalProjectId: withSlug,
      projectDisplayLabel: 'StreamDockBridge_v2',
    });
    expect(readProviderContext(`https://chatgpt.com/g/${bare}`)).toMatchObject({
      externalProjectId: bare,
      projectDisplayLabel: null,
    });
  });

  it('still refuses a custom GPT whose id is likewise non-hexadecimal', () => {
    const evidence = readProviderContext('https://chatgpt.com/g/g-68zx9QW3kv7ty2rs-code-helper');
    expect(evidence).toMatchObject({ scope: 'none' });
    expect(JSON.stringify(evidence)).not.toContain('externalProjectId');
  });

  /**
   * Widening the character class must not widen the SHAPE. `g-p-` followed by
   * at least one alphanumeric character is the whole rule; everything else on
   * `/g/` stays unscoped.
   */
  it('does not turn arbitrary /g/ paths into projects', () => {
    for (const segment of ['g-p', 'g-p-', 'g-p_underscore', 'gizmos', 'g-project-demo', 'p-abcd1234']) {
      expect(readProviderContext(`https://chatgpt.com/g/${segment}/project`)).toMatchObject({
        provider: 'chatgpt',
        scope: 'none',
      });
    }
  });

  it('leaves ordinary conversation and title-shaped false positives unchanged', () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    // A conversation whose title reads exactly like a project name. The reader
    // never sees the title; the URL says conversation, so it is a conversation.
    expect(readProviderContext(`https://chatgpt.com/c/${uuid}`)).toEqual({
      provider: 'chatgpt',
      scope: 'conversation',
      conversationId: uuid,
      evidence: { proof: 'chatgpt-conversation-url-path', matchedPathSegment: uuid },
    });

    // A non-hex project segment somewhere that is not the proving path position.
    expect(
      readProviderContext(`https://chatgpt.com/c/${uuid}?ref=g-p-ZZ99xyQQ-roadmap`)
    ).toMatchObject({ scope: 'conversation' });
    expect(readProviderContext('https://chatgpt.com/#/g/g-p-ZZ99xyQQ-roadmap')).toMatchObject({
      scope: 'none',
    });
  });
});

describe('ChatGPT non-project pages', () => {
  it('treats an ordinary conversation as a conversation, never a project', () => {
    const uuid = '9b2c1d0e-3a4b-4c5d-8e6f-70819a2b3c4d';
    expect(readProviderContext(`https://chatgpt.com/c/${uuid}`)).toEqual({
      provider: 'chatgpt',
      scope: 'conversation',
      conversationId: uuid,
      evidence: {
        proof: 'chatgpt-conversation-url-path',
        matchedPathSegment: uuid,
      },
    });
  });

  it('does not mistake a custom GPT for a project', () => {
    const evidence = readProviderContext(
      'https://chatgpt.com/g/g-68f0a1b2c3d4e5f6-oasis-culture-lounge'
    );
    expect(evidence).toMatchObject({ scope: 'none' });
    expect(JSON.stringify(evidence)).not.toContain('externalProjectId');
  });

  it('reports scope none for the ChatGPT root and for unknown paths', () => {
    expect(readProviderContext('https://chatgpt.com/')).toMatchObject({
      provider: 'chatgpt',
      scope: 'none',
      evidence: { proof: 'chatgpt-host-without-project-path', observedPath: '/' },
    });
    expect(readProviderContext('https://chatgpt.com/gpts/editor')).toMatchObject({
      scope: 'none',
    });
  });

  it('proves nothing from a host that merely resembles ChatGPT', () => {
    expect(readProviderContext('https://chatgpt.com.evil.example/g/g-p-abcd1234-demo')).toBeNull();
    expect(readProviderContext('https://notchatgpt.com/g/g-p-abcd1234-demo')).toBeNull();
    expect(readProviderContext('https://github.com/cmarabate/StreamDockBridge')).toBeNull();
  });
});

describe('title-shaped false positives', () => {
  /**
   * There is no title parameter, and that is the design. A page called
   * "StreamDockBridge — Reconcile roadmap" on an ordinary conversation URL
   * yields conversation scope and no project id, no matter how much the title
   * looks like an identity.
   */
  it('cannot be told about a title at all', () => {
    expect(readProviderContext.length).toBe(1);
  });

  it('a project-shaped string in the query or fragment proves nothing', () => {
    expect(
      readProviderContext('https://chatgpt.com/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301?q=g-p-abcd1234-demo')
    ).toMatchObject({ scope: 'conversation' });
    expect(readProviderContext('https://chatgpt.com/#/g/g-p-abcd1234-demo')).toMatchObject({
      scope: 'none',
    });
  });
});

describe('bounded and malformed input', () => {
  it('returns null rather than throwing for input that is not a usable URL', () => {
    for (const input of [
      undefined,
      null,
      42,
      {},
      '',
      'not a url',
      '://',
      'javascript:alert(1)',
      'file:///C:/Windows/System32',
      'chrome-extension://abc/page.html',
    ]) {
      expect(() => readProviderContext(input as never)).not.toThrow();
      expect(readProviderContext(input as never)).toBeNull();
    }
  });

  it('refuses an absurdly long URL outright', () => {
    const long = `https://chatgpt.com/g/g-p-abcd1234-${'a'.repeat(9_000)}`;
    expect(readProviderContext(long)).toBeNull();
  });

  it('bounds every string it does emit', () => {
    const slug = 'b'.repeat(400);
    const evidence = readProviderContext(`https://chatgpt.com/g/g-p-abcd1234-${slug}`);
    // The over-long segment is not accepted as proof of project scope at all.
    expect(evidence).toMatchObject({ scope: 'none' });
    const path = `/x/${'c'.repeat(2_000)}`;
    const unscoped = readProviderContext(`https://chatgpt.com${path}`) as {
      evidence: { observedPath: string };
    };
    expect(unscoped.evidence.observedPath.length).toBeLessThanOrEqual(512);
  });
});

describe('identity authority', () => {
  it('never emits a registry key, project name, or local path', () => {
    const encoded = JSON.stringify(
      readProviderContext('https://chatgpt.com/g/g-p-abcd1234-streamdockbridge/project')
    );
    for (const forbidden of ['registryKey', 'projectKey', 'projectName', 'localRepoPath', 'githubRepo']) {
      expect(encoded).not.toContain(forbidden);
    }
  });
});
