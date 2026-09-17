// Shared path resolution for every probe. Probes must never hardcode absolute
// paths: that breaks on other machines, other user names, Linux and CI.
//
// Example project resolution order:
//   1. PROBE_EXAMPLE environment variable (explicit override)
//   2. test/fixtures/<name>       — in-repo copy, keeps the suite self-contained
//   3. <repo>/../example/<name>   — the developer's local example directory
//   4. <repo>/example/<name>
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

/** Repository root (the parent of test/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Temp directory (override with PROBE_TMP). Use this or tmpFile() for scratch files. */
export const TMP_DIR = process.env.PROBE_TMP || os.tmpdir();

/** A path inside the temp directory, with forward slashes for in-page embedding. */
export function tmpFile(name) {
    return path.join(TMP_DIR, name).replace(/\\/g, '/');
}

/** A path inside the repository, with forward slashes. */
export function repoPath(...parts) {
    return path.join(REPO_ROOT, ...parts).replace(/\\/g, '/');
}

/** Example project path (default: InkShader_Roundhand.json); throws when none is found. */
export function exampleProject(name = 'InkShader_Roundhand.json') {
    const candidates = [
        process.env.PROBE_EXAMPLE,
        repoPath('test', 'fixtures', name),
        repoPath('..', 'example', name),
        repoPath('example', name),
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    throw new Error(
        `Example project ${name} not found.\nPut it in test/fixtures/${name}, ` +
        `or point PROBE_EXAMPLE at it.\nTried:\n  ${candidates.join('\n  ')}`
    );
}

/** CDP port and static-server port for a probe, as numbers. */
export function probePorts(defaultCdp = 9222, defaultSrv = 8123) {
    return {
        port: Number(process.env.PROBE_PORT || defaultCdp),
        srv: Number(process.env.PROBE_SRV || defaultSrv),
    };
}
