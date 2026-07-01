/**
 * check_spec.js — InkShader spec and coding guide validation script.
 *
 * Purpose: AI runs this before and after code changes to enforce spec rules.
 *   The rules are read dynamically from [RULE:...] blocks in SPECIFICATION.md
 *   and CODEGUIDE.md — NOT hardcoded here.
 *
 * Usage:
 *   node check_spec.js [--changed=file1,file2,...] [--spec-refs=S001a,G006a,...]
 *   --changed:     check only modified files (faster, for post-change)
 *   --spec-refs:   verify that specific spec rules exist and apply to changed files
 *   Without flags: scan all js/ + css/ (full audit)
 *
 * Returns: 0 = pass, 1 = violations found
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const JS_DIR = path.join(ROOT, 'js');

// ============================================================
// 规则解析器 — 从 SPECIFICATION.md 和 CODEGUIDE.md 中读取 [RULE:...] 块
// ============================================================

/**
 * 从 markdown 文件中提取 [RULE:id] ... [ENDRULE] 块并解析为规则对象。
 * @param {string} filePath - spec 文件路径
 * @returns {Array<{id: string, type: string, path: string, forbid?: string, message: string, severity: string, specRef?: string}>}
 */
function parseRulesFromFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const rules = [];
    // 匹配 [RULE:id] ... [ENDRULE] 块
    const blockRe = /\[RULE:(\S+)\]\s*\n([\s\S]*?)\n\[ENDRULE\]/g;
    let match;
    while ((match = blockRe.exec(content)) !== null) {
        const id = match[1];
        const body = match[2];
        const rule = { id, rawLines: [] };
        for (const line of body.split('\n')) {
            const trimmed = line.trim();
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx > 0) {
                const key = trimmed.slice(0, colonIdx).trim();
                const value = trimmed.slice(colonIdx + 1).trim();
                if (key === 'type') rule.type = value;
                else if (key === 'path') rule.rawPath = value;
                else if (key === 'forbid') rule.forbid = value;
                else if (key === 'message') rule.message = value;
                else if (key === 'severity') rule.severity = value;
                else if (key === 'spec-ref') rule.specRef = value;
            }
        }
        if (rule.id && rule.type) {
            // Parse the rule path into include/exclude conditions
            rule.pathConditions = parsePathConditions(rule.rawPath || '');
            rules.push(rule);
        }
    }
    return rules;
}

/**
 * 解析路径条件字符串。
 * 格式: "js/ $exclude js/vendor/" 或 "js/core/ $and js/domain/"
 * 支持 $and (必须匹配所有), $or (匹配任一), $exclude (排除)
 */
function parsePathConditions(raw) {
    const condition = { includes: [], excludes: [], mode: 'any' };
    if (!raw) return condition;

    const parts = raw.split(/\s+/);
    let currentMode = 'include';
    for (const part of parts) {
        if (part === '$and') { condition.mode = 'all'; currentMode = 'include'; continue; }
        if (part === '$or') { currentMode = 'include'; continue; }
        if (part === '$exclude') { currentMode = 'exclude'; continue; }
        if (part.startsWith('$')) continue;
        if (currentMode === 'exclude') condition.excludes.push(part);
        else condition.includes.push(part);
    }
    return condition;
}

/**
 * 检查文件路径是否匹配规则路径条件。
 */
function matchesPathConditions(relPath, conditions) {
    // 先检查排除
    for (const exc of conditions.excludes) {
        if (relPath.includes(exc)) return false;
    }
    // 没有 include = 匹配所有
    if (conditions.includes.length === 0) return true;
    if (conditions.mode === 'all') {
        return conditions.includes.every(inc => relPath.startsWith(inc));
    }
    // 'any' mode (default, also for $or)
    return conditions.includes.some(inc => relPath.startsWith(inc));
}

/** 从两个 spec 文件中读取所有规则 */
function loadAllRules() {
    const rules = [];
    rules.push(...parseRulesFromFile(path.join(ROOT, 'SPECIFICATION.md')));
    rules.push(...parseRulesFromFile(path.join(ROOT, 'CODEGUIDE.md')));
    return rules;
}

// ============================================================
// 文件收集
// ============================================================

function collectFiles(changedArg) {
    if (changedArg) {
        return changedArg.split(',').map(f => {
            const full = path.resolve(__dirname, f.trim());
            return fs.existsSync(full) ? full : null;
        }).filter(Boolean);
    }

    const files = [];
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'vendor' && entry.name !== 'node_modules') walk(full);
            } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
                files.push(full);
            }
        }
    }
    walk(JS_DIR);
    const cssDir = path.join(ROOT, 'css');
    if (fs.existsSync(cssDir)) {
        const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => path.join(cssDir, f));
        files.push(...cssFiles);
    }
    return files;
}

// ============================================================
// 检查器
// ============================================================

class SpecChecker {
    constructor(rules) {
        this.rules = rules;
        this.errors = [];
        this.warnings = [];
    }

    /**
     * 对单个文件应用所有匹配的规则。
     * @param {string} filePath - 绝对路径
     * @param {string} content - 文件内容
     */
    applyRules(filePath, content) {
        const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');

        for (const rule of this.rules) {
            if (!matchesPathConditions(relPath, rule.pathConditions)) continue;

            const severity = rule.severity === 'error' ? 'errors' : 'warnings';
            try {
                this._applySingleRule(rule, relPath, content, severity);
            } catch (e) {
                // Rule check error — report as warning to avoid breaking the audit
                this.warnings.push(`[RULE-ERROR] ${relPath}: rule ${rule.id} check failed: ${e.message}`);
            }
        }
    }

    /**
     * 应用单条规则到文件
     */
    _applySingleRule(rule, relPath, content, severity) {
        switch (rule.type) {
            case 'import-restriction': {
                if (!rule.forbid) break;
                const re = new RegExp(rule.forbid, 'i');
                if (re.test(content)) {
                    this[severity].push(`[${rule.id}] ${relPath}: ${rule.message}`);
                }
                break;
            }

            case 'import-extension': {
                const noExtRe = /from\s+['"](\..*?[^.])(?<!\.js)['"]/g;
                let m;
                while ((m = noExtRe.exec(content)) !== null) {
                    this[severity].push(`[${rule.id}] ${relPath}: import "${m[1]}" ${rule.message}`);
                }
                break;
            }

            case 'pattern': {
                if (!rule.forbid) break;
                // Detect if pattern needs unicode flag (\u{...} syntax)
                const flags = rule.forbid.includes('\\u{') ? 'giu' : 'gi';
                const re = new RegExp(rule.forbid, flags);
                const matches = content.match(re);
                if (matches && matches.length > 0) {
                    this[severity].push(`[${rule.id}] ${relPath}: ${rule.message} (${matches.length} 处匹配)`);
                }
                break;
            }

            case 'no-tabs': {
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('\t')) {
                        this[severity].push(`[${rule.id}] ${relPath}:${i + 1} ${rule.message}`);
                        break;
                    }
                }
                break;
            }

            case 'file-header': {
                if (!relPath.endsWith('.js') && !relPath.endsWith('.mjs')) break;
                if (relPath.endsWith('.min.js')) break;
                const firstLine = content.split('\n')[0].trim();
                if (!firstLine.startsWith('//') && !firstLine.startsWith('/*')) {
                    this[severity].push(`[${rule.id}] ${relPath}: ${rule.message}`);
                }
                break;
            }

            case 'event-literal': {
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const m = lines[i].match(/\.(emit|on|dispatchEvent)\(\s*['"]([a-z][a-z0-9_:-]*)['"]/i);
                    if (m) {
                        this[severity].push(`[${rule.id}] ${relPath}:${i + 1} 事件名 "${m[2]}" ${rule.message}`);
                    }
                }
                break;
            }

            case 'hardcoded-color': {
                if (!relPath.endsWith('.css')) break;
                const colorRe = /#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/;
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.includes('--') && (line.includes(':root') || line.includes('[data-theme') || line.trim().startsWith('--'))) continue;
                    if (line.trim().startsWith('/*') || line.trim().startsWith('*')) continue;
                    // Skip exempted CSS keyword values
                    if (/\b(transparent|currentColor|inherit|none)\b/.test(line)) continue;
                    if (colorRe.test(line)) {
                        this[severity].push(`[${rule.id}] ${relPath}:${i + 1} ${rule.message}`);
                    }
                }
                break;
            }

            default:
                this.warnings.push(`[RULE-UNKNOWN] ${rule.id}: 未知规则类型 "${rule.type}"`);
        }
    }
}

// ============================================================
// 前置声明验证（--spec-refs 模式）
// ============================================================

/**
 * 验证 AI 声明的 spec-refs：
 * 1. 所有引用的规则 ID 必须存在于规则文件中
 * 2. 如果提供了 --changed，验证被改文件是否在规则路径范围内
 * 3. 输出验证报告
 */
function verifySpecRefs(rules, declaredRefs, changedFiles) {
    const ruleMap = new Map(rules.map(r => [r.id, r]));
    const errors = [];
    const warnings = [];

    for (const ref of declaredRefs) {
        const rule = ruleMap.get(ref);
        if (!rule) {
            errors.push(`[SPEC-REF] 声明的规则 "${ref}" 不存在于 SPECIFICATION.md 或 CODEGUIDE.md 中`);
            continue;
        }

        // 如果有 changed file，验证文件在规则路径范围内
        if (changedFiles.length > 0) {
            const covered = changedFiles.some(f => {
                const relPath = path.relative(ROOT, f).replace(/\\/g, '/');
                return matchesPathConditions(relPath, rule.pathConditions);
            });
            if (!covered) {
                warnings.push(`[SPEC-REF] 规则 ${ref} 的路径条件 (${rule.rawPath}) 未覆盖任何被改文件`);
            }
        }
    }

    // 报告
    if (errors.length > 0 || warnings.length > 0) {
        console.log('\n=== 前置声明验证 ===');
        if (errors.length > 0) {
            console.log(`\n✗ 声明错误 (${errors.length} 项):`);
            for (const e of errors) console.log(`  ${e}`);
        }
        if (warnings.length > 0) {
            console.log(`\n⚠ 声明警告 (${warnings.length} 项):`);
            for (const w of warnings) console.log(`  ${w}`);
        }
        console.log('');
    } else {
        console.log(`\n✓ 前置声明验证通过 (${declaredRefs.length} 条规则引用)`);
    }

    return errors.length === 0;
}

// ============================================================
// 主流程
// ============================================================

function main() {
    const changedArg = process.argv.find(a => a.startsWith('--changed='));
    const specRefsArg = process.argv.find(a => a.startsWith('--spec-refs='));

    const changedFilesStr = changedArg ? changedArg.replace('--changed=', '') : null;
    const specRefsStr = specRefsArg ? specRefsArg.replace('--spec-refs=', '') : null;

    // 加载规则（始终从 spec 文件读取，无硬编码）
    const rules = loadAllRules();
    if (rules.length === 0) {
        console.error('[ERROR] 未从 SPECIFICATION.md 或 CODEGUIDE.md 中读取到任何 [RULE:...] 块');
        return 1;
    }

    // 前置声明验证模式
    if (specRefsStr) {
        const declaredRefs = specRefsStr.split(',').map(s => s.trim()).filter(Boolean);
        const changedFiles = changedFilesStr
            ? changedFilesStr.split(',').map(f => path.resolve(__dirname, f.trim())).filter(f => fs.existsSync(f))
            : [];
        const refsOk = verifySpecRefs(rules, declaredRefs, changedFiles);
        // In spec-refs mode, only return 1 if refs are invalid
        if (!refsOk) return 1;
        // If only spec-refs is requested (no --changed), stop here
        if (!changedFilesStr) return 0;
    }

    // 文件验证模式
    const files = collectFiles(changedFilesStr);
    const checker = new SpecChecker(rules);

    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            checker.applyRules(file, content);
        } catch (err) {
            const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
            console.error(`[ERROR] 无法读取 ${relPath}: ${err.message}`);
        }
    }

    // 报告
    if (checker.errors.length === 0 && checker.warnings.length === 0) {
        console.log(`\n✓ 规约验证通过 (${files.length} 文件, ${rules.length} 条规则)`);
        return 0;
    }

    if (checker.errors.length > 0) {
        console.log(`\n✗ 违规 (${checker.errors.length} 项):`);
        for (const err of checker.errors) {
            console.log(`  ${err}`);
        }
    }

    if (checker.warnings.length > 0) {
        console.log(`\n⚠ 警告 (${checker.warnings.length} 项):`);
        for (const warn of checker.warnings) {
            console.log(`  ${warn}`);
        }
    }

    console.log(`\n检查文件数: ${files.length}, 匹配规则数: ${rules.length}`);
    return checker.errors.length > 0 ? 1 : 0;
}

const exitCode = main();
process.exit(exitCode);
