# NREKI vs VSCode - File Mode Benchmark Report

Generated: 2026-04-13T09:08:53.718Z
NREKI Kernel: v5.3.0
VSCode: latest (depth 1 clone)
Mode: hologram (auto-detected via detectMode)

## 1. Mode Detection

| Metric | Value |
|--------|-------|
| detectMode() result | hologram |
| Detection latency | 61.4ms |
| Expected mode | file (>1000 TS files) |

## 2. Boot Metrics

| Metric | Value |
|--------|-------|
| Boot Mode | hologram |
| Boot Time | 20.55s |
| Files Tracked | 3 |
| Baseline Errors | 0 |
| Heap Delta | 134.0 MB |
| RSS | 407.4 MB |

## 3. Simulated Edit Results

| Test | Description | Mode | Expected | Result | Errors | Files Affected | Latency |
|------|-------------|------|----------|--------|--------|----------------|---------|
| A | Safe edit (comment in types.ts) | hologram | safe: true | PASS | 0 | 0 | 2079.64ms |
| B | Local type break in event.ts (IDisposable -> number) | hologram | safe: false (local errors in event.ts) | CAUGHT | 24 | 1 | 3764.27ms |
| C | TTRD type weakening (isString -> any) | hologram | regression detected | CAUGHT (compilation errors) | 1 | 1 | 2537.25ms |
| D | Cross-file break / file mode limitation (IDisposable) | hologram | safe: true (file mode skips cascade) | CAUGHT | 29 | 1 | 4553.11ms |

## 4. Performance Comparison: File Mode vs Project Mode

| Metric | Project Mode (previous) | File Mode (this run) |
|--------|-------------------------|----------------------|
| Boot time | 111s | 20.55s |
| Test B latency | 644s | 3764.27ms |
| Test B errors | 6107 | 24 |
| Test D latency | 331s | 4553.11ms |
| Test D errors | 35704 | 29 |
| OOM crashes | yes | no |

## 5. Detailed Error Listings

### Test B - Local Type Break (event.ts)

- `vs/base/common/event.ts` (51,40): **TS2322** - Type 'unknown' is not assignable to type 'number'.
- `vs/base/common/event.ts` (97,3): **TS2322** - Type '(listener: (e: T) => unknown, thisArgs?: null, disposables?: DisposableStore | IDisposable[] | undefined) => IDisposable | undefined' is not assignable to type 'Event<T>'.
  Type 'IDisposable | 
- `vs/base/common/event.ts` (101,4): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (114,5): **TS18048** - 'result' is possibly 'undefined'.
- `vs/base/common/event.ts` (193,3): **TS2322** - Type '(listener: (e: T) => unknown, thisArgs?: null, disposables?: DisposableStore | IDisposable[] | undefined) => IDisposable' is not assignable to type 'Event<T>'.
  Type 'IDisposable' is not assign
- `vs/base/common/event.ts` (194,42): **TS2345** - Argument of type 'number' is not assignable to parameter of type 'IDisposable'.
- `vs/base/common/event.ts` (218,5): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (279,5): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (384,5): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (544,7): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (558,19): **TS2345** - Argument of type 'IDisposable | null' is not assignable to parameter of type 'IDisposable'.
  Type 'null' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (570,6): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (572,22): **TS2345** - Argument of type 'IDisposable | null' is not assignable to parameter of type 'IDisposable'.
  Type 'null' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (742,4): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (775,3): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (791,3): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (862,3): **TS2322** - Type '(listener: (e: void) => unknown, thisArgs: any, disposables: DisposableStore | IDisposable[] | undefined) => { dispose(): void; }' is not assignable to type 'Event<void>'.
  Type '{ dispose(): v
- `vs/base/common/event.ts` (1233,3): **TS2322** - Type '(callback: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) => unknown' is not assignable to type 'Event<T>'.
  Type 'unknown' is not assignable to type 'number'
- `vs/base/common/event.ts` (1683,3): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (1728,19): **TS2345** - Argument of type 'number' is not assignable to parameter of type 'IDisposable'.
- `vs/base/common/event.ts` (1733,19): **TS2345** - Argument of type 'number' is not assignable to parameter of type 'IDisposable'.
- `vs/base/common/event.ts` (1850,4): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (1865,4): **TS2322** - Type 'number' is not assignable to type 'IDisposable'.
- `vs/base/common/event.ts` (1920,12): **TS2345** - Argument of type 'number' is not assignable to parameter of type 'IDisposable'.

### Test D - Cross-file Break (IDisposable)

- `vs/base/common/lifecycle.ts` (378,7): **TS2420** - Class 'FunctionDisposable' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'FunctionDisposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (385,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'FunctionDisposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (396,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'FunctionDisposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (407,2): **TS2741** - Property '__nrekiTestProperty' is missing in type 'FunctionDisposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (417,14): **TS2420** - Class 'DisposableStore' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableStore' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (425,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableStore' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (438,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableStore' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (476,28): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable | null'.
  Property '__nrekiTestProperty' is missing in type 'DisposableStore' but required in type 'IDisposable'.
    Type 
- `vs/base/common/lifecycle.ts` (527,23): **TS2420** - Class 'Disposable' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'Disposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (534,52): **TS2345** - Argument of type '{ dispose(): void; }' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type '{ dispose(): void; }' but required in type 'IDisposab
- `vs/base/common/lifecycle.ts` (539,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'Disposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (540,25): **TS2345** - Argument of type 'DisposableStore' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableStore' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (544,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'Disposable' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (566,14): **TS2420** - Class 'MutableDisposable<T>' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'MutableDisposable<T>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (571,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'MutableDisposable<T>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (600,33): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable | null'.
  Property '__nrekiTestProperty' is missing in type 'MutableDisposable<T>' but required in type 'IDisposable'.
    
- `vs/base/common/lifecycle.ts` (614,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'MutableDisposable<T>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (637,14): **TS2420** - Class 'MandatoryMutableDisposable<T>' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'MandatoryMutableDisposable<T>' but required in type 'IDisposa
- `vs/base/common/lifecycle.ts` (709,3): **TS2741** - Property '__nrekiTestProperty' is missing in type '{ object: T; dispose: () => void; }' but required in type 'IReference<T>'.
- `vs/base/common/lifecycle.ts` (730,4): **TS2741** - Property '__nrekiTestProperty' is missing in type '{ object: Awaited<T>; dispose: () => void; }' but required in type 'IReference<T>'.
- `vs/base/common/lifecycle.ts` (741,14): **TS2420** - Class 'ImmortalReference<T>' incorrectly implements interface 'IReference<T>'.
  Property '__nrekiTestProperty' is missing in type 'ImmortalReference<T>' but required in type 'IReference<T>'.
- `vs/base/common/lifecycle.ts` (758,14): **TS2420** - Class 'DisposableMap<K, V>' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableMap<K, V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (765,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableMap<K, V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (774,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableMap<K, V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (816,32): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable | null'.
  Property '__nrekiTestProperty' is missing in type 'DisposableMap<K, V>' but required in type 'IDisposable'.
    T
- `vs/base/common/lifecycle.ts` (856,14): **TS2420** - Class 'DisposableSet<V>' incorrectly implements interface 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableSet<V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (863,19): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableSet<V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (872,18): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable'.
  Property '__nrekiTestProperty' is missing in type 'DisposableSet<V>' but required in type 'IDisposable'.
- `vs/base/common/lifecycle.ts` (906,32): **TS2345** - Argument of type 'this' is not assignable to parameter of type 'IDisposable | null'.
  Property '__nrekiTestProperty' is missing in type 'DisposableSet<V>' but required in type 'IDisposable'.
    Type

## 6. TTRD Regression Details (Test C)

No regressions detected.


#### Compilation Errors

- `vs/base/common/types.ts` (19,26): **TS2345** - Argument of type '(str: unknown) => any' is not assignable to parameter of type '(item: unknown) => item is unknown'.
  Signature '(str: unknown): any' must be a type predicate.

## 7. File Mode Tradeoffs

**What file mode catches:**
- Syntax errors in edited files
- Semantic errors local to edited files (e.g., wrong return type)
- Type regressions (TTRD) in edited files' exports

**What file mode misses:**
- Cascade errors in downstream consumers (e.g., 35,704 IDisposable implementors)
- Cross-file type incompatibilities that only manifest in importing files

**When to use file mode:**
- Large codebases (>1000 files) where project mode causes OOM or multi-minute latencies
- Rapid iteration where local correctness is sufficient
- When combined with periodic project-mode verification

## 8. VSCode Integrity Verification

| Check | Result |
|-------|--------|
| Modified files | 0 |
| Status | VERIFIED: VSCode repo untouched |