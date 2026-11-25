/**
 * When this package was built, epoch milliseconds: the stand-in for Chromium's base::GetBuildTime(), where the built-in
 * fallback CRL's 20-week window starts. It is `undefined` in the source; `npm run build` (scripts/stamp-build-time.mjs)
 * rewrites this one assignment in the emitted dist files, so source checkouts and tests fall back to the date in
 * trust-data.ts and the working tree stays clean.
 */
export const BUILD_TIME: number | undefined = undefined;
