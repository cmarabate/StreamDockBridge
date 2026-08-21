export interface ContextRecord {
  url: string;
  hostname: string;
  rawTitle: string;
  documentTitle?: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
  canonicalTitle: string;
  tabId: number;
  windowId: number;
  timestamp: number;
}

class ContextStore {
  private current: ContextRecord | null = null;

  public getContext(): ContextRecord | null {
    return this.current;
  }

  public updateContext(record: ContextRecord): boolean {
    if (this.current) {
      // Guard against stale/out-of-order updates
      if (record.timestamp < this.current.timestamp) {
        return false;
      }
    }
    this.current = { ...record };
    return true;
  }

  public clear(): void {
    this.current = null;
  }
}

export const contextStore = new ContextStore();
