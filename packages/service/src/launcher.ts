import { exec } from 'child_process';

export type LauncherFn = (url: string) => Promise<boolean>;

export const defaultSystemLauncher: LauncherFn = (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    // Windows default browser launch command: start "" "url"
    const command = `start "" "${url.replace(/"/g, '%22')}"`;
    exec(command, (error) => {
      if (error) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
};

export function buildImdbUrl(title: string): string {
  return `https://www.imdb.com/find/?q=${encodeURIComponent(title)}`;
}

export function buildCastUrl(title: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(title + ' cast')}`;
}

export function buildJustWatchUrl(title: string): string {
  return `https://www.justwatch.com/us/search?q=${encodeURIComponent(title)}`;
}

export function buildRedditUrl(title: string): string {
  return `https://www.reddit.com/search/?q=${encodeURIComponent(title)}`;
}
