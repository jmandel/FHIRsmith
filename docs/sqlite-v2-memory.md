# sqlite-v2 memory and the cache layers

**Headline** (same machine, same releases). sqlite-v2 holds no terminology in process memory:
the files are opened, not loaded.

| | main's providers | sqlite-v2 `default` | sqlite-v2 `none` (no app caches) |
|---|---:|---:|---:|
| RSS after startup | 4,315 MiB (external 2,864: SNOMED caches) | 1,222 MiB | 1,047 MiB |
| of which the four big terminologies | 3,137 MiB | — | 89 MiB |
| RSS after the full catalog | 4,735 MiB | 1,420 MiB (313 file-backed) | 1,418 MiB (313 file-backed) |
| another SNOMED CT edition | +1,266 to +1,599 MiB | about +2 MiB at startup (file pages on demand) | same |
| startup | 14–19 s | 10 s | 11 s |
| server-side time, first pages: median / p90 / worst | 43 / 605 / 11,727 ms | 3 / 72 / 1,077 ms | 3 / 75 / 1,044 ms |
| server-side time, later pages: median / p90 | 178 / 2,035 ms | 1 / 12 ms | 2 / 86 ms |
| refused pages | 57 of 299 | 6 of 322 | 6 of 322 |

**The pathological request is fixed.** The first matrix (rows without `-2`) predates the
cross-edition fix. In it, one request, `sct-us-minus-intl-whole`, took 18 s on expand.js's
usual path, and the RSS peak it left (+930 MiB) dominated the "after replay" numbers. That
request now runs in the engine in 0.95 s, which gives the `-2` rows. Both main columns are from
the matrix.

The 683 MiB of npm packages and small providers is the same in every column.

## After the owner's decision: no caches at all (run `ours-nocaches`)

The stored-set, result and code caches, the cross-edition id map and the supplement-layer cache
are removed. Every request plans and evaluates from SQLite. Upstream's expansion cache is
unchanged. The main column repeats the matrix numbers: the same machine, but measured earlier.

| | main (`main-cold`) | sqlite-v2 before (`ours-default-2`) | **sqlite-v2 now (`ours-nocaches`)** |
|---|---:|---:|---:|
| RSS after startup | 4,405 MiB | 1,222 MiB | 1,483 MiB (anon 955, file 528) |
| RSS after the catalog | 5,253 MiB | 1,420 MiB | 1,955 MiB (anon 1,317, file 639) |
| server-side first pages: median / p90 / worst | 43 / 605 / 11,727 ms | 3 / 72 / 1,077 ms | **3 / 72 / 1,532 ms** |
| server-side later pages: median / p90 / worst | 178 / 2,035 / 5,751 ms | 1 / 12 / 723 ms | **2 / 90 / 1,553 ms** |
| refused pages | 57 of 299 | 6 of 322 | 6 of 322 |

Notes on the new run:

- **File-backed RSS** is higher at startup (528 MiB) because load-time data reads whole tables:
  the LOINC rank, and the designation languages of each file. Those pages are file-backed and the
  OS can reclaim them.
- **Anonymous memory** after the catalog is 1,317 MiB, against 1,106 MiB with caches. The run
  had 10 GiB available on a shared machine.
- **The worst case** is the whole US Edition minus whole International, now translated per request
  (1.6 s; it was 0.95 s with the id map, and 18 s on expand.js's usual path).
- **Later pages** cost a re-evaluation: p90 90 ms, against 12 ms with the result cache. That is
  the price of having no cache, and still about 20 times faster than main's 2,035 ms.

## Why RSS rose after removing the caches, and the fix (repeated runs, under the measurement lock)

**Method.**

- Every run: a fresh process under `flock MEASURE.lock`, capped with `systemd-run -p MemoryMax=8G`.
- Each number is RssAnon or RssFile after a forced full GC (`--expose-gc`, `/sqlite-v2/stats?gc=1`),
  in MiB.
- Runs of each build:
  - `cached` = commit 73ed7d7, 3 runs;
  - `no cache` = the build before this fix, 3 runs;
  - `no cache, fixed` = the build after it, 2 runs (the third did not start within 10 minutes on the
    shared machine).
- Load average was 0.4–4.0 and free memory 2–15 GiB, recorded per run in `loadavg.txt`.

**RssAnon after GC, median (range):**

| build | after startup | after the catalog | after a second catalog pass (`_trace=cold`) |
|---|---:|---:|---:|
| cached (73ed7d7) | 947 (943–961) | 1,082 (1,079–1,123) | 1,176 (1,174–1,350) |
| no cache, before the fix | 954 (949–972) | 1,267 (1,254–1,285) | 1,522 (1,502–1,533) |
| **no cache, fixed** | 990 (955–1,024) | **1,094 (1,053–1,134)** | **1,168 (1,156–1,179)** |

**Other columns:**

- **RssFile** after the catalog: 335 MiB (cached), 342 (no cache), 330 (fixed).
- **heapUsed** is the same in all three builds: 669 MiB after startup, 673–689 after the catalog.
- **external and arrayBuffers** are 2–8 MiB in all three.
- **SQLite settings** were the same in every run: `cache_size` 2 MiB per connection, `mmap_size`
  256 MiB per file.

**What it was.** Two things, neither of them a lost cache:

1. **The startup file-backed jump (+450 MiB) was load-time data.** It came from the new load-time
   reads: the designation-language list and the LOINC rank scanned whole tables through the mmap
   window. They now read through SQLite's small page cache (`withoutMmap`): startup RssFile is
   77 MiB again.
2. **The anon rise was one request's peak working set.** A probe of 6 passes over the catalog on
   one process gave 976 → 1,400 → 1,404 → 1,406 … MiB: high-water after the first pass, then flat,
   so it is not a leak. By category:
   - the cross-edition request alone (`multi-system-versions`): +317 MiB;
   - the other ten categories together: +107 MiB.

   Its per-request translation held whole row objects for all 519k ids. It now works in 20k-id
   chunks of codes only: +0 MiB, and faster (whole US minus International 0.83 s instead of 1.6 s;
   `<< 404684003` 0.21 s instead of 0.36 s).

The supplement layers built per request are now built only when a filter names a property that
supplement defines. They are closed at the end of the request (`opContext.closeProviders`) and
never registered globally.

**Conclusion.** With the fix, the no-cache build sits at the cached build's memory: 1,094 against
1,082 MiB anon after the catalog, within run-to-run range. Server-side times (run 1 of each):

| build | first pages: median / p90 / worst | later pages: median / p90 |
|---|---|---|
| no cache, fixed | 2 / 78 / 1,024 ms | 2 / 89 ms |
| cached | 3 / 74 / 1,019 ms | 1 / 12 ms |

The only remaining cost of having no caches is later-page latency.

## Output-heavy requests (`oh-*` catalog entries)

These requests cost little to select and a lot to build rows for. Each was measured on the first
page, locally, under `MEASURE.lock` (load 0.5; 7 GiB free), on a freshly started server with
`_trace=cold`.

- **Server time** is the trace's `wallUs`. It ends when the response object is handed to
  `res.json`, so JSON serialisation is outside it, and it is also the longest synchronous stretch.
- **"first"** is the entry's first request after start; **"repeat"** is the same request again.
- **Memory** is the RssAnon and VmHWM change across the request.

Before this round, properties in expansions and RxNorm lookup properties were missing; this round
added them.

| entry | rows | response bytes | SQL rows | server ms, first / repeat | longest sync ms | RssAnon / VmHWM change, MiB |
|---|---:|---:|---:|---|---:|---|
| oh-deep-designations-properties-100k | 500 | 329,684 | 11,061 | 101.2 / 55.3 | 100.6 | 2 / 0 |
| oh-deep-designations-properties | 500 | 329,679 | 11,061 | 54.5 / 48.6 | 54.4 | 0 / 0 |
| oh-loinc-designation-filter | 845 | 418,082 | 15,093 | 66.6 / 57.4 | 66.5 | 0 / 0 |
| oh-loinc-designations-all-languages-1000 | 1000 | 1,304,073 | 13,652 | 68.3 / 60.3 | 68.2 | 11 / 0 |
| oh-loinc-designations-weighted-languages | 845 | 1,377,998 | 15,093 | 65.7 / 56.9 | 65.5 | -4 / 0 |
| oh-loinc-expand-many-properties | 75 | 172,513 | 3,047 | 22.2 / 21 | 22.1 | 0 / 0 |
| oh-loinc-include-definition | 845 | 110,101 | 848 | 20.6 / 22 | 20.5 | 0 / 0 |
| oh-loinc-property-star-1000 | 1000 | 4,949,867 | 34,444 | 230 / 219.3 | 229.9 | 42 / 10 |
| oh-lookup-loinc-panel-star | – | 7,209 | 36 | 2.8 / 1.1 | 2.6 | 0 / 1 |
| oh-lookup-rxnorm-sbd-star | – | 3,920 | 32 | 1.4 / 0.8 | 1.3 | 0 / 1 |
| oh-lookup-sct-default | – | 7,562 | 49 | 1.4 / 1.2 | 1.3 | 0 / 1 |
| oh-lookup-sct-property-star | – | 5,829 | 39 | 0.8 / 0.6 | 0.7 | 0 / 0 |
| oh-rxnorm-expand-properties | 15 | 4,099 | 71 | 4 / 3.4 | 3.9 | 0 / 1 |
| oh-rxnorm-property-star | 366 | 1,063,062 | 9,180 | 29.4 / 27.4 | 29.3 | -11 / 3 |
| oh-sct-compose-property | 131 | 102,640 | 4,133 | 15.3 / 15 | 15.2 | 0 / 0 |
| oh-sct-designation-filter-fsn | 1000 | 288,814 | 5,341 | 20.8 / 20 | 20.8 | -1 / 0 |
| oh-sct-designations-1000 | 1000 | 436,848 | 5,341 | 18.2 / 20.6 | 18.2 | 1 / 0 |
| oh-sct-expand-many-properties | 124 | 198,183 | 3,145 | 17.5 / 16.2 | 17.5 | 1 / 0 |
| oh-sct-expand-property-star | 124 | 274,066 | 3,757 | 16.5 / 16.5 | 16.4 | 1 / 0 |
| oh-sct-include-definition | 1000 | 117,428 | 1,003 | 9 / 10.9 | 8.9 | 0 / 0 |

- **The most expensive case** is `property=*` on 1,000 LOINC terms: 230 ms server time, 4.9 MB of
  JSON, 34k SQL rows, and +42 MiB anon RSS.
- **Why it is slow.** Properties are read per code (about three statements per code), so they
  dominate. A batched property read for the page would be the next step.
- **Response size.** Large responses (1–5 MB) are where streaming JSON would help; that work is on
  `sqlite-v2-perf`.
- **On the VM** the same requests take 1.6–74 ms, and `oh-loinc-property-star-1000` takes 213–217
  ms.

## Method

**Hardware and load.** One workstation: AMD Ryzen 5 3600, 62 GiB, NVMe, Node 24. Load average
was about 2.1 throughout. Another agent was doing light I/O on the machine.

**Releases.** The same releases on both sides:

- SNOMED CT International 2025-02-01 and US Edition 2025-09-01;
- LOINC 2.83;
- RxNorm 03022026.

**main's configuration.** tx.fhir.org's files:

- `sct_intl_20250201.cache`;
- `sct_us_20250901b.cache`, downloaded from the bucket;
- `Loinc_2.83.db`;
- `rxnorm_03022026.db`;

plus the smaller sources of `tx/sqlite-v2/demo.yml` and the Uzbek supplement.

**Our configuration.** `demo.yml` and the same supplement.

**Procedure** (`docs/sqlite-v2-memory/run.sh`, `measure.js`, `matrix.sh`, `report.js`):

1. Start the server with `--expose-gc`, and time it until `/r4/metadata` answers.
2. Sample `/proc/<pid>/status` (VmRSS, RssAnon, RssFile) and `process.memoryUsage()` through
   `/r4/sqlite-v2/stats?gc=1`, which forces a full GC first. Heap is `heapUsed`.
3. Run the full catalog replay (139 entries, 299–322 pages), then sample again.
4. Run a replay with `_trace=cold`, then sample again.

Each configuration ran once, in a fresh process.

**Cold runs.** "cold" means the database files were dropped from the OS page cache
(`posix_fadvise(DONTNEED)`) before the process started. Only the first pass of each query is cold.

**Times.** Times are measured by the client over local HTTP. "first pages" are the first page of
each pattern; "deep/later pages" are every later page. Refused pages (too-costly or errors) are
counted separately and left out of the times.

**Cache profiles** in the matrix (settings since removed; see the section above):

| run | stored sets | results | codes | expansion cache |
|---|---|---|---|---|
| `none` | off | off | off | off |
| `sets` | on | off | off | off |
| `results` | off | on | off | off |
| `codes` | off | off | on | off |
| `expansion` | off | off | off | on |
| `default` | on | on | on | on |

Budgets when on: 64 MiB for stored sets, 64 MiB for results, 100,000 code entries; the expansion
cache is main's, 1,000 entries.

**Under every profile:**

- SQLite: `cache_size` 2 MiB per connection, `mmap_size` 256 MiB per file;
- prepared statements, which are structural;
- per-file metadata: property definitions and designation uses;
- the LOINC rank arrays: 2.0 MiB of data, not cache.

## Results

The `-2` rows were measured after the cross-edition fix; the others are the first matrix.

### Memory (MiB; "after GC" = after a forced full GC)

| run | startup s | RSS | anon | file | heap | external | RSS after replay | anon | file | heap | external | RSS after GC | caches after replay | RSS after cold-trace replay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ours-none-cold | 9.0 | 1019 | 943 | 77 | 669 | 6 | 3200 | 2676 | 524 | 673 | 6 | 3121 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 3236 |
| ours-none | 8.9 | 1036 | 959 | 77 | 669 | 6 | 3215 | 2689 | 526 | 673 | 6 | 3136 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 3232 |
| ours-sets | 8.8 | 1044 | 967 | 77 | 669 | 6 | 3134 | 2620 | 514 | 698 | 6 | 3093 | sets 64 MiB/185557; results 0 MiB/0; codes 0 | 3248 |
| ours-results | 12.4 | 1026 | 950 | 77 | 669 | 6 | 2768 | 2242 | 527 | 676 | 6 | 2732 | sets 0 MiB/0; results 7 MiB/68; codes 0 | 2753 |
| ours-codes | 8.4 | 1236 | 1160 | 77 | 669 | 6 | 3230 | 2703 | 527 | 677 | 6 | 3148 | sets 0 MiB/0; results 0 MiB/0; codes 35692 | 3259 |
| ours-expansion | 9.2 | 1045 | 968 | 77 | 669 | 8 | 2421 | 1894 | 527 | 672 | 6 | 2385 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 3201 |
| ours-default | 9.9 | 1051 | 974 | 77 | 669 | 8 | 2611 | 2092 | 518 | 704 | 6 | 2550 | sets 64 MiB/185661; results 7 MiB/68; codes 35692 | 2938 |
| main-default | 19.0 | 4315 | 4239 | 76 | 764 | 2864 | 4735 | 4659 | 77 | 936 | 2878 | 4675 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 4822 |
| main-noexp | 14.1 | 4383 | 4307 | 76 | 764 | 2865 | 5277 | 5200 | 77 | 936 | 2878 | 5002 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 5016 |
| main-cold | 14.6 | 4405 | 4328 | 76 | 764 | 2865 | 5253 | 5177 | 77 | 936 | 2878 | 4975 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 5257 |
| base-node | 3.8 | 346 | 270 | 76 | 93 | 4 |  |  |  |  |  |  |  |  |
| small-only | 8.6 | 1029 | 953 | 76 | 669 | 4 |  |  |  |  |  |  |  |  |
| v2-only | 4.1 | 435 | 358 | 77 | 93 | 6 |  |  |  |  |  |  |  |  |
| ours-no-us | 9.2 | 1049 | 973 | 77 | 669 | 8 |  |  |  |  |  |  |  |  |
| main-big-only | 8.4 | 3483 | 3406 | 76 | 188 | 2864 |  |  |  |  |  |  |  |  |
| main-no-us | 11.9 | 3049 | 2972 | 76 | 752 | 1647 |  |  |  |  |  |  |  |  |
| main-plus-us2023 | 16.1 | 5914 | 5837 | 76 | 766 | 4481 |  |  |  |  |  |  |  |  |
| ours-none-arena2 | 8.8 | 1217 | 1141 | 77 | 669 | 6 | 3164 | 2639 | 526 | 673 | 6 | 3086 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 3185 |
| ours-none-2 | 11.0 | 1047 | 970 | 77 | 669 | 8 | 1418 | 1104 | 313 | 676 | 8 | 1416 | sets 0 MiB/0; results 0 MiB/0; codes 0 | 1471 |
| ours-default-2 | 10.3 | 1222 | 1145 | 77 | 669 | 6 | 1420 | 1106 | 313 | 689 | 8 | 1403 | sets 19 MiB/54378; results 7 MiB/70; codes 35692 | 1530 |

### Per-request time (ms, client-measured, local HTTP)

| run | first pages: n | median | p90 | worst | deep/later pages: n | median | p90 | worst | refused pages | replay s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ours-none-cold | 117 | 8.0 | 99 | 19221 | 92 | 3.0 | 86 | 722 | 7 of 322 | 48.7 |
| ours-none | 117 | 5.0 | 98 | 18355 | 92 | 3.0 | 82 | 684 | 7 of 322 | 46.4 |
| ours-sets | 116 | 6.0 | 100 | 1028 | 92 | 3.0 | 51 | 706 | 8 of 321 | 51.2 |
| ours-results | 117 | 5.0 | 90 | 19193 | 92 | 2.0 | 14 | 684 | 7 of 322 | 46.4 |
| ours-codes | 117 | 5.0 | 99 | 18538 | 92 | 3.0 | 89 | 720 | 7 of 322 | 47.0 |
| ours-expansion | 117 | 6.0 | 94 | 19161 | 92 | 3.0 | 85 | 740 | 7 of 322 | 28.2 |
| ours-default | 116 | 5.0 | 100 | 1040 | 92 | 2.0 | 14 | 693 | 8 of 321 | 49.1 |
| main-default | 103 | 54 | 826 | 11842 | 44 | 178 | 2009 | 5378 | 57 of 299 | 92.3 |
| main-noexp | 103 | 52 | 647 | 10453 | 44 | 192 | 1970 | 5103 | 57 of 299 | 120.5 |
| main-cold | 103 | 56 | 904 | 11729 | 44 | 180 | 2037 | 5754 | 57 of 299 | 124.7 |
| ours-none-arena2 | 117 | 9.0 | 105 | 20008 | 92 | 4.0 | 85 | 710 | 7 of 322 | 50.7 |
| ours-none-2 | 117 | 6.0 | 91 | 1046 | 93 | 4.0 | 87 | 700 | 6 of 322 | 11.2 |
| ours-default-2 | 117 | 6.0 | 109 | 1079 | 93 | 3.0 | 14 | 723 | 6 of 322 | 8.6 |

### Server-side time, main vs ours (identical requests)

Server time comes from each server's own request log (the same FHIRsmith logging code on both). Lines are paired in order with the replay's pages. `main-cold` ran with the expansion cache off, in a fresh process, after the files were dropped from the page cache. `main-default` has the expansion cache on. Its second pass is not a warm pass: `_trace=cold` makes the cache key unique, so main also missed. main caches only expansions that took more than 250 ms in any case.

#### Server-side time per page (ms, from the request log)

| run | first: n | median | p90 | worst | deep: n | median | p90 | worst | refused (4xx/5xx) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ours-none-2 | 137 | 3 | 75 | 1044 | 93 | 2 | 86 | 696 | 6 of 322 |
| ours-default-2 | 137 | 3 | 72 | 1077 | 93 | 1 | 12 | 723 | 6 of 322 |
| main-cold | 122 | 43 | 605 | 11727 | 44 | 178 | 2035 | 5751 | 57 of 299 |
| main-default | 122 | 39 | 594 | 11840 | 44 | 176 | 2007 | 5375 | 57 of 299 |

#### First pages by category: median / worst server ms (refused)

| category | ours-none-2 | ours-default-2 | main-cold | main-default |
| --- | --- | --- | --- | --- |
| enumerated-nested | 7 / 332 (0) | 6 / 333 (0) | 26 / 5687 (2) | 28 / 6105 (2) |
| exclusion-inactive | 2 / 5 (0) | 2 / 5 (0) | 432 / 2887 (1) | 452 / 2996 (1) |
| hierarchy | 3 / 24 (0) | 3 / 25 (0) | 24 / 442 (1) | 28 / 440 (1) |
| languages-supplements | 3 / 161 (1) | 2 / 213 (1) | 8 / 150 (2) | 9 / 160 (2) |
| limits-paging | 1 / 106 (1) | 2 / 109 (1) | 62 / 1365 (2) | 65 / 1267 (2) |
| mixed-providers | 24 / 163 (0) | 23 / 171 (0) | 31 / 355 (0) | 29 / 180 (0) |
| multi-system-versions | 11 / 950 (0) | 11 / 959 (0) | 9 / 456 (1) | 8 / 457 (1) |
| properties-attributes | 5 / 113 (0) | 4 / 116 (0) | 447 / 11727 (2) | 442 / 11840 (2) |
| refsets-implicit-ecl | 1 / 1044 (0) | 2 / 1077 (0) | 52 / 397 (2) | 51 / 382 (2) |
| text | 11 / 292 (0) | 11 / 283 (0) | 183 / 2413 (3) | 187 / 2426 (3) |
| validate-lookup-subsumes | 1 / 3 (0) | 1 / 2 (0) | 1 / 471 (1) | 1 / 475 (1) |

## Attribution (RSS after startup, MiB)

| configuration | RSS | difference |
|---|---:|---|
| Node and FHIRsmith with internal providers and UCUM only | 346 | baseline |
| + our four sqlite-v2 files only | 435 | **+89** (connections, metadata, LOINC rank 2 MiB; data pages stay in the files) |
| + main's four big sources only | 3,483 | **+3,137** (SNOMED caches in ArrayBuffers: external 2,864) |
| + smaller sources only (NDC, UNII, CPT, OMOP, npm packages, supplement) | 1,029 | +683, the same for both designs (heap 669) |
| ours, full | 1,051 | |
| main, full | 4,315 | |

## Scaling with one more SNOMED CT edition (RSS after startup, MiB)

| design | without the US Edition | with it | with a further US Edition (2023-03-01) |
|---|---:|---:|---:|
| main | 3,049 | 4,315 (**+1,266**) | 5,914 (**+1,599**) |
| ours | 1,049 | 1,051 (**+2**) | not measured; one more file is likewise about +2 MiB at startup |

Our files only add RSS as their pages are read. Those pages are file-backed (RssFile): the OS can
drop them and they are shared between processes. After the full replay, RssFile was about
520 MiB in total.

## Per layer: does it earn its memory?

These verdicts come from the `-2` runs, after the cross-edition fix.

| layer | verdict |
|---|---|
| **Stored-set cache** | 19 MiB held 54k sets after the catalog. First-page times did not change (median 3 ms server-side, either way): the sets are read in one batched statement per (kind, property) anyway. Keep a small budget (16–32 MiB) for repeated value-set fan-outs. It does not earn 64 MiB. |
| **Result cache** | 7 MiB, 70 entries. It makes later pages cheap: server-side p90 86 → 12 ms. Clearly worth it. |
| **Code cache** | No measurable effect on time (code lookups are single indexed reads) and small memory (36k entries). It could be 0. |
| **Expansion cache** (main's) | It only caches expansions that took more than 250 ms, so with the engine it holds almost nothing. Its budget is entries, not bytes, unless `expansionCacheMemoryThreshold` is set. Recommended for the demo: `expansionCacheSize` 200 and `expansionCacheMemoryThreshold` 1500 (MiB of heap). That bounds main's own slow providers, at the cost of their repeat requests. |

## The no-cache baseline (`cacheProfile: "none"`, run `ours-none-2`)

| | value |
|---|---|
| server-side first pages (warm OS cache): median / p90 / worst | 3 / 75 / 1,044 ms |
| client-side first pages, cold OS cache (first matrix, `ours-none-cold`): median | 8 ms (warm: 5 ms) |
| server-side later pages: median / p90 | 2 / 86 ms |
| RSS after startup | 1,047 MiB |
| RSS after the catalog | 1,418 MiB, of which 313 MiB is file-backed |

Its cost, against `default`, is deep-page latency: p90 86 ms against 12 ms. It is an honest
default for the explorer.

## Caveats

- Each number is a single run, not a distribution. RSS after GC includes heap that V8 has freed
  but not returned to the OS, and the glibc arenas. `MALLOC_ARENA_MAX=2` made no difference
  (3,164 against 3,215 MiB).
- Before the fix, a per-category probe pinned the growth on the cross-edition query: the
  `multi-system-versions` category took RssAnon from 1,052 to 1,984 MiB. The other ten
  categories together added about 140 MiB.
- Load average and free memory were recorded before each later run (`loadavg.txt`): 1.5–2.1, and
  7–9 GiB free. Another agent was running FHIRsmith processes on the machine; the `-2` runs ran
  under `systemd-run --scope -p MemoryMax=8G`.
- main's numbers include its own startup-time indexes and its sqlite3 connections. main
  refuses 57 of 299 pages (too-costly and unsupported); those pages are not in its times.
