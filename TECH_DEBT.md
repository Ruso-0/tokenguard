# NREKI Technical Debt Ledger

Registro formal de deuda técnica conocida y diferida. Cada entrada incluye:
ubicación, descripción, sprint que la registró, sprint donde se planifica
remediar.

---

## Testing / Mocks (Deferred for post-v10.19.0 Corpus)

- **Files**: `tests/router.test.ts`, `tests/backward-compat.test.ts`
- **Issue**: `mockEngine` utiliza escape de tipos (`as any`) para evitar
  implementar la interface completa de `NrekiEngine` (~30 métodos públicos).
- **Cause**: limitación de inferencia de tipos en `vi.fn()` de Vitest cuando
  se mockean interfaces complejas.
- **Risk**: si `NrekiEngine` evoluciona, los mocks no detectan el desfase
  en compile-time.
- **Remediation**: extraer factory type-safe (ej. `tests/helpers/mock-engine.ts`)
  con cobertura completa de la interface, importando tipos auxiliares
  (`RepoMap`, `DependencyGraph`, `ChunkRecord`, `FastGrepHit`, `SessionReport`,
  `IndexStats`, `ParseResult`).
- **Registered**: sprint v10.18.1
- **Planned remediation**: sprint dedicado post-v10.19.0 (Corpus Baseline)
- **Estimated effort**: 5-6 commits

---

## VFS Absolute Path Reliance (Deferred for post-v10.19.0 Corpus)

The kernel, persistence layer, and undo system all rely on strict string
equality of absolute filesystem paths as keys. This design choice manifests
as two related symptoms that share the same architectural root cause and
must be remediated together in a unified VFS canonicalization refactor.

- **Files**: `src/database.ts` (chunks/files/engrams tables), `src/undo.ts`
  (backups directory keys), `src/kernel/nreki-kernel.ts` (VFS keys, ~30 sites),
  `src/utils/to-posix.ts` (path normalization callsite)

### Symptom A: Path Stale γ

- **Issue**: SQLite stores absolute filesystem paths in `chunks`, `files`,
  and `engrams` tables. The `.nreki/backups/` directory uses base64url hashes
  derived from absolute paths. If a user moves the project folder to a
  different directory (or restores it on another machine with a different
  drive layout), all persisted paths become stale references and the index
  is effectively orphaned.
- **Risk**: cache miss + full reindex on project move. Backup recovery
  fails silently for renamed directories. Critical only if v10.19.x corpus
  begins using variable clone paths (current v10.19.0 plan uses fixed paths
  under `D:\Nreki\corpus\<repo>\`, mitigating immediate exposure).

### Symptom B: Drive Letter Asymmetry (Windows)

- **Issue**: On Windows, `path.resolve()` and related Node APIs may return
  drive letters in either case (`C:\` vs `c:\`) depending on how paths
  enter the system (terminal CWD, IDE plugin args, MCP client URIs).
  Because the kernel uses raw POSIX path strings as Set keys
  (`currentEditTargets`, `prunedTsLookup`, `jitClassifiedCache`), inputs
  that differ only in drive letter casing are treated as distinct entries,
  duplicating chunks and breaking VFS lookups.
- **Discovery**: empirically confirmed during sprint v10.18.1 / Commit #4.
  An attempt to canonicalize drive letters in `toPosix()` at the utility
  layer caused `tests/jit-holography.test.ts` Tests 9 and 15 to fail
  (regression confirmed via stash + isolated test run on clean HEAD).
  The fix was reverted in the same commit (signed Furia: retirada táctica).
  A characterization test in `tests/to-posix.test.ts` documents the current
  preserved-casing behavior and will fail intentionally when canonicalization
  lands.
- **Risk**: SQLite primary key duplication if two NREKI processes write
  paths with different drive letter casing concurrently. JIT cache misses
  when agents pass paths with different casing than the kernel produced.

### Shared Root Cause

Design choice that prioritized POSIX absolute paths as VFS keys for the
kernel and LSP sidecar communication (which require `file:///` URIs).
The persistence layer inherited this assumption. Canonicalization at the
utility boundary (`toPosix`) is insufficient because it desynchronizes
producer and consumer code paths in the kernel; the fix must be applied
uniformly across all VFS entry points.

### Remediation Plan (Unified)

- Refactor persistence layer to store paths relative to `projectRoot` in
  SQLite. Engine reconstructs absolutes at runtime via
  `path.join(projectRoot, path_relative)`. Add `path_relative` column to
  `chunks` table via ALTER TABLE migration.
- Update `undo.ts` to hash relative paths (eliminates Path Stale γ).
- Introduce a canonical path canonicalizer used by ALL VFS entry points
  in `nreki-kernel.ts` (~30 sites). The canonicalizer enforces lowercase
  drive letter on Windows and consistent slash direction (eliminates
  Drive Letter Asymmetry).
- Translate paths at I/O boundaries (kernel VFS, LSP URIs) rather than
  in storage.
- Replace `tests/to-posix.test.ts` characterization tests with assertions
  on the new canonical contract.

- **Registered**: sprint v10.18.1 (Commit #4)
- **Planned remediation**: sprint dedicado post-v10.19.0 (Corpus Baseline)
- **Estimated effort**: 8-12 turnos (blast radius incluye 30+ sitios en
  `nreki-kernel.ts`, 7+ queries SQL en `database.ts`, sistema de undo,
  utility canonicalizer, y suite de tests específica para transición
  de paths absolutos/relativos y casing)

---
