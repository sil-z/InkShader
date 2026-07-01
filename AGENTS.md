# InkShader — AI Knowledge Base Root

## Project

InkShader is a Web-based font editor that uses Paper.js for Bezier curve rendering. Pure frontend (no backend dependency).

## Quick Start

Before modifying any code, AI **MUST** read:

1. **[SPECIFICATION.md](SPECIFICATION.md)** — Functional spec (module responsibilities, data flow, constraints)
2. **[CODEGUIDE.md](CODEGUIDE.md)** — Coding standards
3. Related module `AGENTS.md` files (if they exist)

## Modification Workflow

Every AI modification MUST follow this process:

```
=== PRE-IMPLEMENTATION GATE (MANDATORY) ===
Step 1: Read SPECIFICATION.md + related AGENTS.md
Step 2: Declare spec references — list the rule IDs this change relates to
        e.g.: "Spec refs: S001a, C001, G006a" (from [RULE:...] blocks in spec files)
Step 3: RUN: node check_spec.js --spec-refs=S001a,C001,G006a --changed=<files>
        This verifies:
          • All declared rule IDs exist in SPECIFICATION.md or CODEGUIDE.md
          • The changed files fall under those rules' path conditions
          • PASS = gate cleared, proceed to implementation
Step 4: If gate fails → fix declarations (wrong refs) or read the correct spec rules
Step 5: READ the files to be modified, understand current implementation
Step 6: Check if modification violates SPECIFICATION.md functional rules

=== IMPLEMENTATION ===
Step 7: Implement changes (follow CODEGUIDE.md ALL rules)

=== POST-CHANGE VERIFICATION ===
Step 8: RUN: node check_spec.js --changed=<files>
        Fix all ERRORS reported by check_spec.js
Step 9: Address all WARNINGS (or confirm harmless)
Step 10: Verify no functional deviation from SPECIFICATION.md
```

### Pre-implementation Gate Details

The `--spec-refs` flag is a **hard gate**. Before writing any code, AI MUST:

1. Identify which [RULE:...] blocks in SPECIFICATION.md and CODEGUIDE.md apply
2. Declare them via `--spec-refs=ID1,ID2,...`
3. Run `check_spec.js` to verify:
   - Each ID exists in a spec file
   - The changed files are within the rule's scope
4. **If the gate fails, DO NOT proceed to implementation** — fix the declaration or re-read the relevant spec sections first

Example:
```bash
# Before implementing a change to js/core/bezier/curve.js:
node check_spec.js --spec-refs=S001a,C001,C003,G001,G006a --changed=js/core/bezier/curve.js
```

## Commit Summary

After completing modifications, report in your response:

```
## Summary
- Files: xxx.js, yyy.js
- Goal: [brief description of modification purpose]
- Spec ref: [Related S00x items]

## Verification
- check_spec.js: PASS (or list remaining warnings with reasons)
- Functional deviation check: No deviation
- LSP diagnostics: No errors
```

## File Structure

```
InkShader/                     <- Git repository root
+-- AGENTS.md                  <- This file: AI knowledge base root
+-- SPECIFICATION.md           <- Functional spec
+-- CODEGUIDE.md               <- Coding standards
+-- check_spec.js              <- Spec validation script (run after every change)
+-- index.html                 <- Entry point
+-- css/style.css              <- All styles
+-- cursor.js                  <- Custom cursor (IIFE module)
|
+-- js/
    +-- core/              <- Pure geometry (Bezier, boolean ops)
    +-- domain/            <- Domain logic (commands, selection, history, sequence)
    +-- app/               <- Glue layer (Store, EventBus, Dispatcher)
    +-- presentation/      <- Presentation layer (Canvas controllers, tools)
    +-- canvas/            <- Canvas rendering and services
    +-- ui/                <- Web Component UI
    +-- services/          <- Cross-cutting services (i18n, theme, storage)
    +-- vendor/            <- Third-party libs (JSZip, Paper.js)
```
