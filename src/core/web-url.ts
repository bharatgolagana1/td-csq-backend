// Joins PUBLIC_WEB_URL and a path in the web app. The app may live under a
// base path (https://dev.csq.aero/app) and the variable may or may not end
// in a slash; every link the API hands out (assessment invitation,
// registration form, reviewer screen) goes through here so none of them
// ever reads `…/app//assess/…` or `…/appassess/…`.

/** `webAppUrl('https://dev.csq.aero/app/', '/assess/t')` → `https://dev.csq.aero/app/assess/t`. */
export function webAppUrl(base: string, path: string): string {
  const root = base.trim().replace(/\/+$/, '');
  const relative = path.replace(/^\/+/, '');
  return relative ? `${root}/${relative}` : root;
}
