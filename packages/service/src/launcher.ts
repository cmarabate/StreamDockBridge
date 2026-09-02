/**
 * Launcher types.
 *
 * The URL builders that used to live here were a second, divergent template
 * authority — buildImdbUrl emitted `imdb.com/find/?q=` with an extra slash
 * while the live path emits `find?q=`. Nothing imported them. URL construction
 * now belongs solely to urlTemplate.ts.
 */
export type LauncherFn = (url: string) => void | Promise<boolean>;
