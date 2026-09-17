#!/usr/bin/env node
// Single entry point for the regression probes.
//
//   node test/run_probes.mjs                 # default suites (probe_*.mjs and *_probe.mjs)
//   node test/run_probes.mjs --all           # also run *_cdp_driver.mjs / *shot*.mjs
//   node test/run_probes.mjs --only rotation # only files whose name contains "rotation"
//   node test/run_probes.mjs --list          # list what would run
//
// It owns everything a probe needs to run: static server, headless browser, CDP port,
// temp directory. Probes no longer require a manually prepared environment, and none of
// them may depend on absolute paths outside the repository.
//
// Serial execution is deliberate: probes share one origin (localStorage/IndexedDB) and a
// single-threaded rAF, so running them in parallel pollutes state and produces false failures.
//
// Environment:
//   PROBE_BROWSER   browser executable (default: auto-detect Edge/Chrome/Chromium)
//   PROBE_TIMEOUT   per-probe timeout in seconds (default 300)
//   PROBE_TMP       temp directory
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, TMP_DIR } from './probe_env.mjs';

const TEST_DIR = path.join(REPO_ROOT, 'test');
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT || 300) * 1000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const ALL = flag('--all');
const LIST_ONLY = flag('--list');
const ONLY = value('--only');

// Helper files that are not suites themselves.
const SKIP = new Set(['probe_env.mjs', 'run_probes.mjs']);
const NOT_A_SUITE = /(_cdp_driver|_shot)\.mjs$|^diag/i;

// 套件 = 源码里存在断言汇总（checks 数组、PASS/FAIL 行或 passed 计数）。
// 其余文件是诊断脚本：结果照打，但不决定退出码。
const SUITE_SOURCE = /\bchecks\b|\bpassed\b|console\.log\('(PASS|FAIL)/;
const suiteCache = new Map();
function isSuite(file) {
    if (!suiteCache.has(file)) {
        let src = '';
        try { src = readFileSync(file, 'utf8'); } catch { /* 读不到就按诊断处理 */ }
        suiteCache.set(file, SUITE_SOURCE.test(src));
    }
    return suiteCache.get(file);
}

// ---------------------------------------------------------------- browser discovery

function findBrowser() {
    if (process.env.PROBE_BROWSER) return process.env.PROBE_BROWSER;
    const candidates = process.platform === 'win32'
        ? [
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ]
            : [
                '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
                '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium', '/usr/bin/chromium-browser',
                '/snap/bin/chromium',
            ];
    return candidates.find(existsSync);
}

// ---------------------------------------------------------------- static server

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.zip': 'application/zip',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
};

// Grab the conventional ports used throughout the probes (static server 8123, CDP 9222)
// so historical probes that are not parameterised still run. If a port is taken we fall
// back to a random one, in which case only probes reading PROBE_SRV/PROBE_PORT work.
const PREFERRED_SRV = Number(process.env.PROBE_SRV || 8123);
const PREFERRED_CDP = Number(process.env.PROBE_PORT || 9222);

function startStaticServer(root, preferredPort) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const file = path.join(root, rel || 'index.html');
            if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
            const body = await readFile(file);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-store',
            });
            res.end(body);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        }
    });
    const listen = (port) => new Promise((resolve, reject) => {
        const onError = (e) => reject(e);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
        });
    });
    return (async () => {
        let port;
        let fallback = false;
        try {
            port = await listen(preferredPort);
        } catch {
            port = await listen(0);
            fallback = true;
        }
        return { server, port, fallback };
    })();
}

// ---------------------------------------------------------------- browser process

function launchBrowser(binary, profileDir, preferredPort) {
    const child = spawn(binary, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${preferredPort}`,
        `--user-data-dir=${profileDir}`,
        'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const debugPort = new Promise((resolve, reject) => {
        let buf = '';
        const onData = (d) => {
            buf += d.toString();
            const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (m) resolve(Number(m[1]));
        };
        child.stderr.on('data', onData);
        child.stdout.on('data', onData);
        child.on('exit', (code) => reject(new Error(`browser exited early (code ${code})`)));
        setTimeout(() => reject(new Error('browser did not report a DevTools port')), 30000);
    });
    return { child, debugPort };
}

// ---------------------------------------------------------------- result parsing

/** Last parseable JSON object in the probe output that carries checks/failure info. */
function parseSummary(text) {
    for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
        const end = matchBrace(text, i);
        if (end < 0) continue;
        try {
            const obj = JSON.parse(text.slice(i, end + 1));
            if (obj && typeof obj === 'object' && (Array.isArray(obj.checks) || 'failed' in obj || 'failedCount' in obj)) {
                return obj;
            }
        } catch { /* keep scanning backwards */ }
        if (i === 0) break;
    }
    const m = text.match(/(\d+)\s*\/\s*(\d+)\s*passed/);
    if (m) return { passed: Number(m[1]), total: Number(m[2]) };
    return null;
}

/** Index of the '}' matching the '{' at text[start] (skips strings/escapes); -1 on failure. */
function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    return -1;
}

function counts(summary, text) {
    if (summary && Array.isArray(summary.checks)) {
        return { passed: summary.checks.filter(c => c.ok).length, total: summary.checks.length };
    }
    if (summary && typeof summary.passed === 'number' && typeof summary.total === 'number') {
        return { passed: summary.passed, total: summary.total };
    }
    const fails = (text.match(/^FAIL /gm) || []).length;
    const passes = (text.match(/^PASS /gm) || []).length;
    if (fails || passes) return { passed: passes, total: passes + fails };
    // "N/M passed" trailer, used by probes that print details instead of a checks array
    const trailer = text.match(/(\d+)\s*\/\s*(\d+)\s*passed/);
    if (trailer) return { passed: Number(trailer[1]), total: Number(trailer[2]) };
    return null;
}

// ---------------------------------------------------------------- main

async function main() {
    const entries = (await readdir(TEST_DIR))
        .filter(f => f.endsWith('.mjs') && !SKIP.has(f))
        .filter(f => ALL || !NOT_A_SUITE.test(f))
        .filter(f => !ONLY || f.includes(ONLY))
        .sort();
    const probes = entries.map(f => path.join(TEST_DIR, f));

    if (!probes.length) {
        console.error(ONLY ? `没有探针文件名包含 "${ONLY}"` : '没有找到探针');
        return 1;
    }
    if (LIST_ONLY) {
        for (const p of probes) console.log(path.relative(REPO_ROOT, p));
        console.log(`\n共 ${probes.length} 个`);
        return 0;
    }

    const browserBinary = findBrowser();
    if (!browserBinary) {
        console.error('找不到浏览器。安装 Edge/Chrome/Chromium，或用 PROBE_BROWSER 指向可执行文件。');
        return 1;
    }

    const { server, port: srvPort, fallback: srvFallback } = await startStaticServer(REPO_ROOT, PREFERRED_SRV);
    const profileDir = await mkdtemp(path.join(TMP_DIR, 'inkshader-probe-'));
    const { child: browser, debugPort } = launchBrowser(browserBinary, profileDir, PREFERRED_CDP);

    let cdpPort;
    try {
        cdpPort = await debugPort;
    } catch (e) {
        console.error(`浏览器启动失败：${e.message}`);
        browser.kill(); server.close();
        return 1;
    }

    console.log(`静态服务器 :${srvPort}   浏览器 CDP :${cdpPort}`);
    if (srvFallback) console.log(`（:${PREFERRED_SRV} 被占用，已改用随机端口；只读 PROBE_SRV 的探针仍可运行）`);
    console.log(`浏览器     ${browserBinary}`);
    console.log(`探针 ${probes.length} 个，串行执行（单个超时 ${TIMEOUT_MS / 1000}s）\n`);

    const results = [];
    for (const file of probes) {
        const name = path.basename(file);
        const started = Date.now();
        const r = await runProbe(file, { srvPort, cdpPort });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const c = counts(r.summary, r.out);
        const diagnostic = !isSuite(file);
        const crashed = r.code !== 0 || r.timeout;
        const failedChecks = c ? c.passed < c.total : false;
        // 诊断脚本（源码里没有任何断言汇总）永远不参与判定：它可能因为依赖手工
        // 打开的页面而超时，那不是回归失败。
        const status = diagnostic ? 'warn' : crashed || failedChecks ? 'FAIL' : 'ok';
        const entry = {
            name,
            status,
            ok: status === 'ok',
            code: r.code,
            timeout: r.timeout,
            seconds: Number(secs),
            passed: c?.passed ?? null,
            total: c?.total ?? null,
            tag: r.summary?.tag ?? null,
            stderr: r.err.trim().split('\n').slice(-3).join('\n') || null,
        };
        results.push(entry);
        const counted = c ? ` ${c.passed}/${c.total}` : ' 无断言';
        console.log(`${status.padEnd(5)}${name.padEnd(42)}${counted.padEnd(10)} ${secs}s`);
        if (status === 'FAIL') {
            const names = Array.isArray(r.summary?.checks)
                ? r.summary.checks.filter(ch => !ch.ok).map(ch => ch.name)
                : (Array.isArray(r.summary?.failed) ? r.summary.failed : []);
            if (names.length) console.log(names.slice(0, 8).map(n => `       失败断言：${n}`).join('\n'));
            const failLine = (r.out.match(/^FAIL .*/gm) || []).slice(0, 6);
            if (failLine.length) console.log(failLine.map(l => `       ${l}`).join('\n'));
            if (entry.stderr) console.log(`       stderr: ${entry.stderr.replace(/\n/g, ' | ')}`);
        }
        if (status === 'warn') {
            const tail = r.out.trim().split('\n').slice(-2).filter(Boolean);
            const why = r.timeout ? `超时 ${TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
            console.log(`       诊断脚本，不参与判定（${why}）：${tail.join(' / ').slice(0, 160) || '(无输出)'}`);
        }
    }

    browser.kill();
    server.close();
    await rm(profileDir, { recursive: true, force: true }).catch(() => { });

    const failed = results.filter(r => r.status === 'FAIL');
    const warned = results.filter(r => r.status === 'warn');
    const report = {
        when: new Date().toISOString(),
        browser: browserBinary,
        total: results.length,
        passed: results.length - failed.length - warned.length,
        warned: warned.map(r => r.name),
        failed: failed.map(r => r.name),
        results,
    };
    const reportPath = path.join(TMP_DIR, 'inkshader-probe-report.json');
    await (await import('node:fs/promises')).writeFile(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n${report.passed}/${report.total} 个探针通过`);
    if (warned.length) console.log(`无断言（仅诊断，未参与判定）：${warned.map(r => r.name).join(', ')}`);
    if (failed.length) console.log(`失败：${failed.map(r => r.name).join(', ')}`);
    console.log(`报告：${reportPath}`);
    return failed.length ? 1 : 0;
}

function runProbe(file, { srvPort, cdpPort }) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [file], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                PROBE_SRV: String(srvPort),
                PROBE_PORT: String(cdpPort),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '', timeout = false;
        const timer = setTimeout(() => {
            timeout = true;
            child.kill('SIGKILL');
        }, TIMEOUT_MS);
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: timeout ? 124 : code, timeout, out, err, summary: parseSummary(out) });
        });
    });
}

main().then(code => process.exit(code)).catch(e => {
    console.error('runner 异常：', e);
    process.exit(1);
});
