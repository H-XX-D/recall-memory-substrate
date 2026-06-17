#!/usr/bin/env python3
"""
recall_code_extract_js.py — Recall extractor for JavaScript & TypeScript.

Companion to `recall_code_extract.py` (Python). Same proposal shape, same
cell-kind conventions, so the linker (`recall_code_link.py`) and `--rebuild`
flow work for JS/TS cells without code changes.

Implementation: **regex-based scan** (no external deps). This is the v1
trade-off — pure stdlib over tree-sitter dependency. The extractor catches
the common 80% of declarations cleanly: top-level `function`, `class`,
`const fn = () => ...`, `export function`, `import ... from`, `require(...)`.

What it misses (documented limits):

- Computed property names: `class { [key]() { ... } }`
- Decorators on methods/classes (legacy or TC39): `@decorator class X {}`
- Complex destructuring in const declarations
- Functions defined inside an IIFE or other top-level expression
- Type-only constructs in `.ts` files that don't follow standard declaration syntax
- Symbols defined via dynamic computation (e.g., `Object.defineProperty`)

For high-fidelity multi-language extraction in v2, a tree-sitter pass is
the planned upgrade. For v1 the regex extractor covers most production
codebases acceptably and ships with zero new dependencies.

File extensions handled: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`.

Entity tag namespace: `js-sym:`, `js-ref:`, `js-import:` for JavaScript;
`ts-sym:`, `ts-ref:`, `ts-import:` for TypeScript. The linker
(`recall_code_link.py`) auto-discovers all language prefixes.

Usage parallels the Python extractor:

    # JSONL to stdout:
    python3 recall_code_extract_js.py --path src/ --project my-repo

    # Admit directly:
    python3 recall_code_extract_js.py --path src/ --project my-repo --admit

    # Idempotent re-extraction:
    python3 recall_code_extract_js.py --path src/ --project my-repo --admit --rebuild

After admitting, run the linker (it auto-handles js-/ts- prefixes):

    python3 recall_code_link.py --project my-repo --apply
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

# Reuse helper for proposal construction + rebuild support from extractor
sys.path.insert(0, str(Path(__file__).parent))
from recall_helper import build_proposal, DEFAULT_DB  # noqa: E402
from recall_code_extract import (  # noqa: E402
    DEFAULT_EXCLUDES,
    TEST_PATTERNS,
    MAX_BODY_EXCERPT_CHARS,
    _is_test_path,
    _body_excerpt,
    _admit_proposal,
    _query_existing_cells_for_path,
    _supersede_old_with_new,
)


# ---- Language detection ----

JS_EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs")
TS_EXTENSIONS = (".ts", ".tsx")
ALL_EXTENSIONS = JS_EXTENSIONS + TS_EXTENSIONS


def file_language(path: Path) -> str:
    """Return 'javascript' or 'typescript' based on extension."""
    return "typescript" if path.suffix in TS_EXTENSIONS else "javascript"


def entity_prefix(language: str) -> str:
    """Return the entity-tag prefix for the language (e.g., 'js-' or 'ts-')."""
    return "ts-" if language == "typescript" else "js-"


# ---- Regex patterns ----

# Top-level function declaration: optional export, optional default, optional async
TOP_FUNC = re.compile(
    r'^(?P<export>export\s+(?:default\s+)?)?'
    r'(?P<async>async\s+)?'
    r'function\s*\*?\s+'   # function or function* (generator)
    r'(?P<name>\w+)'
    r'\s*(?P<sig>\([^)]*\))',
    re.MULTILINE,
)

# Top-level class declaration
TOP_CLASS = re.compile(
    r'^(?P<export>export\s+(?:default\s+)?)?'
    r'(?P<abstract>abstract\s+)?'
    r'class\s+(?P<name>\w+)'
    r'(?:\s+extends\s+(?P<base>\w+(?:\.\w+)*(?:<[^>]+>)?))?'
    r'(?:\s+implements\s+(?P<impl>\w+(?:\s*,\s*\w+)*))?'
    r'\s*\{',
    re.MULTILINE,
)

# Top-level const/let/var bound to an arrow function or function expression
TOP_FN_BINDING = re.compile(
    r'^(?P<export>export\s+(?:default\s+)?)?'
    r'(?:const|let|var)\s+(?P<name>\w+)'
    r'\s*(?::\s*[^=]+?)?'  # optional TS type annotation
    r'\s*=\s*'
    r'(?:'
    r'(?P<async>async\s+)?'
    r'(?:'
    r'function\s*\*?\s*(?:\w+)?\s*\([^)]*\)'   # = function() or = function name()
    r'|'
    r'(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?\s*=>'  # = () => or = name =>
    r')'
    r')',
    re.MULTILINE,
)

# Top-level exported const/let/var bound to data (object/array/literal) —
# plan catalogs, config maps, enums-as-objects. Function-valued bindings are
# TOP_FN_BINDING's job; extract_file skips RHS that begins like a function.
TOP_CONST_DATA = re.compile(
    r'^(?P<export>export\s+)'
    r'(?:const|let|var)\s+(?P<name>\w+)'
    r'\s*(?::\s*[^=\n]+?)?'   # optional TS type annotation
    r'\s*=(?P<eq>)',
    re.MULTILINE,
)

# RHS shapes that mean "this is a function binding, not data"
_FUNCTION_RHS = re.compile(
    r'^(?:async\b|function\b|\([^)]*\)\s*(?::[^=]{0,40}?)?\s*=>|[\w$]+\s*=>)'
)

# import statements (ES modules)
ES_IMPORT = re.compile(
    r'^import\s+'
    r'(?P<spec>(?:[\w$]+|\*\s+as\s+[\w$]+|\{[^}]+\})'
    r'(?:\s*,\s*(?:[\w$]+|\*\s+as\s+[\w$]+|\{[^}]+\}))*)?'
    r'\s*(?:from\s+)?[\'"](?P<mod>[^\'"]+)[\'"]',
    re.MULTILINE,
)

# CommonJS require
CJS_REQUIRE = re.compile(
    r'(?:const|let|var)\s+(?P<spec>\{[^}]+\}|[\w$]+)'
    r'\s*=\s*require\s*\(\s*[\'"](?P<mod>[^\'"]+)[\'"]\s*\)',
)

# TypeScript interface declaration
TS_INTERFACE = re.compile(
    r'^(?P<export>export\s+)?'
    r'interface\s+(?P<name>\w+)'
    r'(?:\s+extends\s+[\w,\s.<>]+?)?'
    r'\s*\{',
    re.MULTILINE,
)

# TypeScript type alias
TS_TYPE = re.compile(
    r'^(?P<export>export\s+)?'
    r'type\s+(?P<name>\w+)'
    r'\s*(?:<[^>]+>)?'
    r'\s*=',
    re.MULTILINE,
)

# Reference scan: identifier followed by ( or .
# Crude but cheap; matches references inside body excerpts.
REF_NAME = re.compile(r'\b([A-Za-z_$][\w$]*)\b')

JS_KEYWORDS = frozenset({
    "abstract", "any", "as", "async", "await", "boolean", "break", "case",
    "catch", "class", "const", "continue", "debugger", "declare", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally",
    "for", "from", "function", "get", "if", "implements", "import", "in",
    "instanceof", "interface", "is", "keyof", "let", "module", "namespace",
    "never", "new", "null", "number", "object", "of", "package", "private",
    "protected", "public", "readonly", "require", "return", "set", "static",
    "string", "super", "switch", "symbol", "this", "throw", "true", "try",
    "type", "typeof", "undefined", "unknown", "var", "void", "while", "with",
    "yield",
})


# ---- Data classes ----

@dataclass
class JSExtractedSymbol:
    file_path: str
    name: str
    kind: str  # function | async-function | class | const-function | interface | type-alias
    lineno: int
    end_lineno: int
    signature: str
    decorators: list[str] = field(default_factory=list)
    body_excerpt: str = ""
    extends: str | None = None
    implements: list[str] = field(default_factory=list)
    is_exported: bool = False
    is_default_export: bool = False
    is_test: bool = False
    refs: list[str] = field(default_factory=list)


@dataclass
class JSExtractedModule:
    file_path: str
    language: str  # 'javascript' or 'typescript'
    line_count: int
    imports: list[str] = field(default_factory=list)
    symbol_names: list[str] = field(default_factory=list)
    is_test_module: bool = False


# ---- Parsing helpers ----

def _line_number_at(source: str, char_offset: int) -> int:
    """Return 1-based line number at a char offset in source."""
    return source.count("\n", 0, char_offset) + 1


def _find_matching_brace(source: str, open_brace_offset: int) -> int:
    """Given offset of '{', return offset of matching '}' (or end-of-string).

    Naive brace matcher that ignores nesting in strings/comments — sufficient
    for v1 body-excerpt extraction; off-by-one cases get truncated bodies.
    """
    depth = 0
    i = open_brace_offset
    in_string: str | None = None
    in_line_comment = False
    in_block_comment = False
    n = len(source)
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
        elif in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                i += 1
        elif in_string is not None:
            if c == "\\":
                i += 1  # skip escape
            elif c == in_string:
                in_string = None
        else:
            if c == "/" and nxt == "/":
                in_line_comment = True
                i += 1
            elif c == "/" and nxt == "*":
                in_block_comment = True
                i += 1
            elif c in ("'", '"', "`"):
                in_string = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return n - 1


def _find_decl_end(source: str, decl_start_offset: int) -> int:
    """Find the end offset of a declaration starting at decl_start_offset.

    For function/class with a body, returns offset of closing brace.
    For const-fn / type-alias with an expression body, returns offset of
    matching semicolon or newline.
    """
    # Look for first '{' or ';' after the declaration start
    i = decl_start_offset
    n = len(source)
    in_string: str | None = None
    in_line_comment = False
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
                # End at end-of-statement for non-brace decls
                return i
        elif in_string is not None:
            if c == "\\":
                i += 1
            elif c == in_string:
                in_string = None
        else:
            if c == "/" and nxt == "/":
                in_line_comment = True
                i += 1
            elif c in ("'", '"', "`"):
                in_string = c
            elif c == "{":
                return _find_matching_brace(source, i)
            elif c == ";":
                return i
            elif c == "\n":
                # No brace, no semi — could be single-line const decl
                return i
        i += 1
    return n - 1


# ---- Extraction ----

def _query_project_code_paths(project: str, db: str) -> set[str]:
    """All scope.paths present on the project's code cells (any generation)."""
    result = subprocess.run(
        ["recall", "subgraph", "--project", project, "--category", "code", "--db", db],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return set()
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return set()
    return {
        p for cell in payload.get("results", [])
        if (p := cell.get("scope", {}).get("path"))
    }


def extract_imports(source: str) -> list[str]:
    """Collect module names from ES import and CommonJS require statements."""
    out: list[str] = []
    seen: set[str] = set()
    for pat in (ES_IMPORT, CJS_REQUIRE):
        for m in pat.finditer(source):
            mod = m.group("mod")
            if mod and mod not in seen:
                seen.add(mod)
                out.append(mod)
    return out


def extract_refs_from_body(body: str) -> list[str]:
    """Extract identifier references from a code body excerpt."""
    found: set[str] = set()
    for m in REF_NAME.finditer(body):
        name = m.group(1)
        if name in JS_KEYWORDS:
            continue
        if name.startswith("$") and len(name) < 3:
            continue  # skip noise like $, $_
        found.add(name)
    return sorted(found)[:30]


def extract_file(path: Path, repo_root: Path) -> tuple[JSExtractedModule, list[JSExtractedSymbol]]:
    """Parse a JS/TS file via regex, return (module info, symbols)."""
    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        rel = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
        return (
            JSExtractedModule(file_path=rel, language=file_language(path),
                              line_count=0),
            [],
        )

    lang = file_language(path)
    rel = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
    is_test_module = _is_test_path(rel)
    source_lines = source.splitlines()
    symbols: list[JSExtractedSymbol] = []
    seen_names: set[str] = set()

    def _record(name: str, kind: str, m: re.Match, sig: str, *, extends=None, implements=None):
        if name in seen_names:
            return  # ignore re-declarations in v1
        seen_names.add(name)
        start_off = m.start()
        end_off = _find_decl_end(source, m.end())
        lineno = _line_number_at(source, start_off)
        end_lineno = _line_number_at(source, end_off)
        excerpt = _body_excerpt(source_lines, lineno, end_lineno)
        is_exported = bool(m.groupdict().get("export"))
        is_default = bool(m.groupdict().get("export") and "default" in m.group("export"))
        sym = JSExtractedSymbol(
            file_path=rel,
            name=name,
            kind=kind,
            lineno=lineno,
            end_lineno=end_lineno,
            signature=sig,
            body_excerpt=excerpt,
            extends=extends,
            implements=implements or [],
            is_exported=is_exported,
            is_default_export=is_default,
            is_test=is_test_module or name.startswith("test_") or name.lower().startswith("test"),
            refs=extract_refs_from_body(excerpt),
        )
        symbols.append(sym)

    # function declarations
    for m in TOP_FUNC.finditer(source):
        name = m.group("name")
        is_async = bool(m.group("async"))
        sig_args = m.group("sig")
        kind = "async-function" if is_async else "function"
        prefix = "async function" if is_async else "function"
        sig = f"{prefix} {name}{sig_args}"
        _record(name, kind, m, sig)

    # class declarations
    for m in TOP_CLASS.finditer(source):
        name = m.group("name")
        extends = m.group("base")
        impl_raw = m.group("impl")
        implements = [s.strip() for s in impl_raw.split(",")] if impl_raw else []
        sig_parts = [f"class {name}"]
        if extends:
            sig_parts.append(f"extends {extends}")
        if implements:
            sig_parts.append(f"implements {', '.join(implements)}")
        _record(name, "class", m, " ".join(sig_parts),
                extends=extends, implements=implements)

    # const fn = () => ...
    for m in TOP_FN_BINDING.finditer(source):
        name = m.group("name")
        is_async = bool(m.group("async"))
        kind = "async-const-function" if is_async else "const-function"
        sig = f"const {name} = " + ("async " if is_async else "") + "(...) => ..."
        _record(name, kind, m, sig)

    # export const DATA = {...} — exported data bindings (catalogs, configs).
    # Runs after TOP_FN_BINDING so function bindings are already in seen_names;
    # the RHS check catches any that slipped through.
    for m in TOP_CONST_DATA.finditer(source):
        name = m.group("name")
        rhs = source[m.end("eq"):m.end("eq") + 80].lstrip()
        if _FUNCTION_RHS.match(rhs):
            continue
        decl_line = source_lines[_line_number_at(source, m.start()) - 1].strip()
        sig = decl_line[:80] + ("…" if len(decl_line) > 80 else "")
        _record(name, "const-data", m, sig)

    # TS interfaces
    if lang == "typescript":
        for m in TS_INTERFACE.finditer(source):
            name = m.group("name")
            _record(name, "interface", m, f"interface {name}")
        for m in TS_TYPE.finditer(source):
            name = m.group("name")
            _record(name, "type-alias", m, f"type {name}")

    # Sort symbols by line number for stable output
    symbols.sort(key=lambda s: s.lineno)

    module = JSExtractedModule(
        file_path=rel,
        language=lang,
        line_count=len(source_lines),
        imports=extract_imports(source),
        symbol_names=[s.name for s in symbols],
        is_test_module=is_test_module,
    )
    return module, symbols


def iter_js_ts_files(
    root: Path,
    excludes: Iterable[str] = DEFAULT_EXCLUDES,
    include_tests: bool = True,
    extensions: tuple[str, ...] = ALL_EXTENSIONS,
) -> Iterator[Path]:
    """Yield JS/TS files under root, respecting exclude patterns."""
    excludes_set = set(excludes)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in excludes_set]
        for fn in filenames:
            if not any(fn.endswith(ext) for ext in extensions):
                continue
            full = Path(dirpath) / fn
            rel = full.relative_to(root) if full.is_relative_to(root) else full
            rel_str = str(rel)
            if not include_tests and _is_test_path(rel_str):
                continue
            yield full


# ---- Proposal construction ----

def module_to_proposal(mod: JSExtractedModule, *, project: str, repo_label: str) -> dict:
    prefix = entity_prefix(mod.language)
    body_parts = [
        f"# Module: {mod.file_path}",
        "",
        f"Language: {mod.language}",
        f"Line count: {mod.line_count}",
    ]
    if mod.imports:
        body_parts.extend(["", "## Imports", ""])
        body_parts.extend(f"- `{imp}`" for imp in mod.imports[:40])
    if mod.symbol_names:
        body_parts.extend(["", "## Top-level symbols", ""])
        body_parts.extend(f"- `{name}`" for name in mod.symbol_names[:50])
    body = "\n".join(body_parts)

    entities = [repo_label, Path(mod.file_path).stem]
    entities.extend(f"{prefix}import:{i}" for i in mod.imports[:10])
    entities.extend(f"{prefix}sym:{s}" for s in mod.symbol_names[:15])

    topics = ["code", mod.language, "module"]
    if mod.is_test_module:
        topics.append("test-module")

    lifecycle = ["active", "code"]
    if mod.is_test_module:
        lifecycle.append("test")

    return build_proposal(
        kind="artifact",
        title=f"module: {mod.file_path}",
        body=body,
        confidence=0.9,
        topics=topics,
        source_files=[mod.file_path],
        project=project,
        rings=["runtime"],
        lifecycle=lifecycle,
        category=["code"],
        idea=[f"{prefix.rstrip('-')}-module-{Path(mod.file_path).stem}"],
        extra_entities=entities,
        path=mod.file_path,
        verification="checked",
        stability="volatile",
    )


def symbol_to_proposal(sym: JSExtractedSymbol, *, language: str,
                       project: str, repo_label: str) -> dict:
    prefix = entity_prefix(language)
    body_parts = [
        f"# {sym.kind}: {sym.name}",
        "",
        f"**File:** `{sym.file_path}`",
        f"**Language:** {language}",
        f"**Lines:** {sym.lineno}–{sym.end_lineno}",
        f"**Signature:** `{sym.signature}`",
    ]
    if sym.is_exported:
        body_parts.append(f"**Exported:** yes" + (" (default)" if sym.is_default_export else ""))
    if sym.extends:
        body_parts.append(f"**Extends:** `{sym.extends}`")
    if sym.implements:
        body_parts.append(f"**Implements:** {', '.join('`'+i+'`' for i in sym.implements)}")
    if sym.is_test:
        body_parts.append("**Is test:** yes")
    if sym.refs:
        body_parts.extend(["", "## References (identifier scan)", ""])
        body_parts.extend(f"- `{r}`" for r in sym.refs[:20])
    if sym.body_excerpt:
        body_parts.extend(["", "## Source excerpt", "", f"```{language[:2]}", sym.body_excerpt, "```"])
    body = "\n".join(body_parts)

    entities = [
        repo_label,
        Path(sym.file_path).stem,
        f"{prefix}sym:{sym.name}",
    ]
    if sym.extends:
        entities.append(f"{prefix}sym:{sym.extends.split('<')[0]}")
    entities.extend(f"{prefix}ref:{r}" for r in sym.refs[:10])

    topics = ["code", language, sym.kind]
    if sym.is_test:
        topics.append("test")

    lifecycle = ["active", "code"]
    if sym.is_test:
        lifecycle.append("test")

    return build_proposal(
        kind="artifact",
        title=f"{sym.kind}: {sym.file_path}::{sym.name}",
        body=body,
        confidence=0.85,  # slightly lower than Python (regex parsing is best-effort)
        topics=topics,
        source_files=[f"{sym.file_path}#L{sym.lineno}-L{sym.end_lineno}"],
        project=project,
        rings=["runtime"],
        lifecycle=lifecycle,
        category=["code"],
        idea=[f"{prefix.rstrip('-')}-{sym.kind}-{sym.name}"],
        subject=f"{Path(sym.file_path).stem}-{sym.name}",
        extra_entities=entities,
        path=sym.file_path,
        verification="checked",
        stability="volatile",
    )


# ---- CLI ----

def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Extract Recall write proposals from a JavaScript/TypeScript codebase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  # JSONL to stdout:\n"
            "  recall_code_extract_js.py --path src/ --project my-repo\n\n"
            "  # Admit directly:\n"
            "  recall_code_extract_js.py --path src/ --project my-repo --admit\n\n"
            "  # Idempotent re-extraction:\n"
            "  recall_code_extract_js.py --path src/ --project my-repo --admit --rebuild\n"
        ),
    )
    ap.add_argument("--path", required=True, help="File or directory to extract from.")
    ap.add_argument("--project", required=True, help="Project name for scope.project tag.")
    ap.add_argument("--repo-label", default=None)
    ap.add_argument("--include-tests", action="store_true")
    ap.add_argument("--exclude-tests", action="store_true")
    ap.add_argument("--out", default="-")
    ap.add_argument("--stats-only", action="store_true")
    ap.add_argument("--admit", action="store_true")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--rebuild", action="store_true",
                    help="Idempotent re-extraction (see Python extractor docs).")
    args = ap.parse_args()

    if args.include_tests and args.exclude_tests:
        print("ERROR: --include-tests and --exclude-tests are mutually exclusive",
              file=sys.stderr)
        return 2
    if args.rebuild and not args.admit:
        print("--rebuild requires --admit.", file=sys.stderr)
        return 2

    include_tests = not args.exclude_tests
    repo_label = args.repo_label or args.project

    root = Path(args.path).resolve()
    if not root.exists():
        print(f"ERROR: path does not exist: {root}", file=sys.stderr)
        return 2

    if root.is_file():
        if not any(root.name.endswith(ext) for ext in ALL_EXTENSIONS):
            print(f"ERROR: {root} is not a JS/TS file", file=sys.stderr)
            return 2
        files = [root]
        repo_root = root.parent
    else:
        files = list(iter_js_ts_files(root, include_tests=include_tests))
        repo_root = root

    out_file = sys.stdout if args.out == "-" else open(args.out, "w")
    try:
        n_modules = 0
        n_symbols = 0
        n_admitted = 0
        n_failed = 0
        emitted = 0
        n_sup_matched = 0
        n_sup_fallback = 0
        n_sup_failed = 0
        scanned_paths: set[str] = set()

        for f in files:
            mod, syms = extract_file(f, repo_root)
            scanned_paths.add(mod.file_path)
            n_modules += 1
            n_symbols += len(syms)

            if args.stats_only:
                continue

            old_cells: list[dict] = []
            if args.rebuild:
                old_cells = _query_existing_cells_for_path(args.project, mod.file_path, args.db)

            new_id_by_title: dict[str, str] = {}
            new_module_id: str | None = None

            if args.limit is None or emitted < args.limit:
                mod_prop = module_to_proposal(mod, project=args.project, repo_label=repo_label)
                if args.admit:
                    ok, result = _admit_proposal(mod_prop, args.db)
                    if ok:
                        n_admitted += 1
                        if isinstance(result, dict):
                            new_id = result.get("node", {}).get("id")
                            if new_id:
                                new_module_id = new_id
                                new_id_by_title[mod_prop["content"]["title"]] = new_id
                    else:
                        n_failed += 1
                        print(f"ADMIT FAIL ({mod.file_path}): {result}", file=sys.stderr)
                else:
                    out_file.write(json.dumps(mod_prop) + "\n")
                emitted += 1

            for sym in syms:
                if args.limit is not None and emitted >= args.limit:
                    break
                sym_prop = symbol_to_proposal(sym, language=mod.language,
                                              project=args.project, repo_label=repo_label)
                if args.admit:
                    ok, result = _admit_proposal(sym_prop, args.db)
                    if ok:
                        n_admitted += 1
                        if isinstance(result, dict):
                            new_id = result.get("node", {}).get("id")
                            if new_id:
                                new_id_by_title[sym_prop["content"]["title"]] = new_id
                    else:
                        n_failed += 1
                        print(f"ADMIT FAIL ({sym.file_path}::{sym.name}): {result}", file=sys.stderr)
                else:
                    out_file.write(json.dumps(sym_prop) + "\n")
                emitted += 1

            if args.rebuild and old_cells:
                new_ids = set(new_id_by_title.values())
                old_to_supersede = [c for c in old_cells if c["id"] not in new_ids]
                m, fb, fl = _supersede_old_with_new(
                    old_to_supersede, new_id_by_title, new_module_id, args.db,
                )
                n_sup_matched += m
                n_sup_fallback += fb
                n_sup_failed += fl
    finally:
        if out_file is not sys.stdout:
            out_file.close()

    # Orphan sweep: paths that still have code cells in the graph but no
    # longer exist in the scanned tree. Title-match supersedure cannot see
    # renames or deletions, so those cells stay active and stale (dogfood
    # finding F7). Detection-only for now — retirement semantics are a
    # roadmap item.
    orphaned: list[str] = []
    if args.admit and args.rebuild and scanned_paths:
        orphaned = sorted(_query_project_code_paths(args.project, args.db) - scanned_paths)

    print("--- recall_code_extract_js summary ---", file=sys.stderr)
    print(f"  files scanned:    {n_modules}", file=sys.stderr)
    print(f"  symbols extracted: {n_symbols}", file=sys.stderr)
    if args.admit:
        print(f"  cells admitted:   {n_admitted}", file=sys.stderr)
        print(f"  failures:         {n_failed}", file=sys.stderr)
        if args.rebuild:
            print(f"  old cells superseded (title match): {n_sup_matched}", file=sys.stderr)
            print(f"  old cells superseded (fallback to module): {n_sup_fallback}", file=sys.stderr)
            print(f"  supersede edges failed: {n_sup_failed}", file=sys.stderr)
            if orphaned:
                print(
                    f"  WARNING: {len(orphaned)} path(s) have code cells but are "
                    "missing from the scanned tree (renamed or deleted files "
                    "leave stale active cells):",
                    file=sys.stderr,
                )
                for p in orphaned[:20]:
                    print(f"    - {p}", file=sys.stderr)
        return 1 if (n_failed > 0 or n_sup_failed > 0) else 0
    elif not args.stats_only:
        print(f"  proposals emitted: {emitted}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
