import { readFileSync } from 'node:fs';

interface PackageJson {
  name?: string;
  version?: string;
}

function readPackage(): PackageJson {
  // src/core/version.ts and dist/core/version.js both sit two levels below the package root.
  const path = new URL('../../package.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

const pkg = readPackage();

export const APP_NAME = pkg.name ?? 'td-csq-backend';
export const APP_VERSION = pkg.version ?? '0.0.0';
