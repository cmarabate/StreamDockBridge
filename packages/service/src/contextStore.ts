export interface ContextRecord {
  url: string;
  hostname: string;
  rawTitle: string;
  documentTitle: string;
  ogTitle: string;
  twitterTitle: string;
  jsonLdTitle: string;
  canonicalTitle: string;
  tabId: number;
  windowId: number;
  timestamp: number;
}

export class ContextStore {
  private current: ContextRecord | null = null;

  public updateContext(record: ContextRecord): boolean {
    if (this.current) {
      // Guard against stale/out-of-order updates
      if (record.timestamp < this.current.timestamp) {
        return false;
      }
      // Guard against overwriting a valid title with an empty title for the same page URL
      if (this.current.url === record.url && this.current.canonicalTitle && !record.canonicalTitle) {
        return false;
      }
    }
    this.current = { ...record };
    return true;
  }

  public getContext(): ContextRecord | null {
    if (!this.current || !this.current.canonicalTitle) {
      return null;
    }
    return this.current;
  }

  public clear(): void {
    this.current = null;
  }
}

export const contextStore = new ContextStore();
