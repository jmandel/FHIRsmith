# Deploying `sqlite-v2-next` to the demo (fhirsmith-v2.exe.xyz)

`sqlite-v2-next` is the sqlite-v2 engine on top of `proposal-base`: upstream main (which has #333,
#337, #338, #345, #346, #347, #348, #349, #350, #351, #354, #355 and #356) with our open PRs merged
(#334, #342). It
contains:
- native post-coordination as the only SNOMED CT path (the adapter is gone);
- the sqlite-v2 content store: package CodeSystems, package ValueSets and VSAC are read from sqlite-v2
  files (`docs/sqlite-v2-content-store.md`). **Default: value sets + code systems on.**
- cluster-lite (#342, `cluster.md`) as the only multi-process mode. The first cluster mode (X1, #336:
  `cluster.js` with N identical workers, the background-jobs lock, `cluster-state.db`, the group
  memory guard of #336, the shared SQLite resource cache under `modules.tx.resourceCache`) is gone,
  and so is the `lanes` prototype (`FHIRSMITH_MAX_INFLIGHT` and the other `lanes.conf` variables).

Sections 1-6 below are from the first deploy of the content store (`sqlite-v2-aligned`, 2 Nov) and
still apply. Section 0 is what changes for a demo that runs the old cluster mode.

## 0. From the old cluster mode to cluster-lite

`node cluster.js` is still the command, but it now runs a master (every module, the VSAC sync,
`$closure`) on `port + 1` and tx-workers on `port + 2 ...`, behind a small proxy on `port`
(`cluster.md`). Caddy keeps proxying to `server.port`.

**config.json: take out**

| Key | Why |
|---|---|
| `server.memory.limit`, `server.memory.measure` | The group limit is the cgroup's (`MemoryMax` on the unit). `limit` still works as an override, `measure` is gone. |
| `server.memory.recycleAfterSeconds`, `server.memory.drainSeconds` | They are now `server.cluster.recycleSeconds` and `server.cluster.drainSeconds`. |
| `server.sharedState` | Gone: logins and secrets live in the master, which runs every module but tx. |
| `server.backgroundJobs` (`lock`, `lockFile`) | Gone: the master runs the background jobs; workers run none. |
| `modules.tx.resourceCache` (`store`, `path`, `maxBytes`, `touchIntervalSeconds`) | Gone. Each process keeps its own `$cache-control` caches (the proxy routes a cache-id to its owner), or set `server.cluster.sharedCache`. |
| `modules.tx.sqliteV2.sctPostcoordination` | Gone (since 2 Nov); ignored if left. |

**config.json: keep or add**

| Key | Value for the demo | Notes |
|---|---|---|
| `server.cluster.workers` | 2 | Same key and meaning as before. `FHIRSMITH_WORKERS` still overrides it. Unset, cluster-lite picks a number from the CPUs by the engine's rule, then fewer if memory is short. It must be a whole number; 0 now means the master alone. |
| `server.cluster.internalPort` | 8002 (default `port + 1`) | The master is on this port and the workers on the next ones (8003, 8004). They now listen on 127.0.0.1 only (`server.cluster.bindAddress`, default `127.0.0.1`; leave it unset). Caddy reaches the launcher at 127.0.0.1:8001, and the launcher reaches the processes over loopback. |
| `server.cluster.recycleSeconds` | 30 (default) | Replaces `recycleAfterSeconds`. |
| `server.cluster.drainSeconds` | 30 (default) | Moved from `server.memory`. |
| `server.cluster.maxOutstanding`, `queueSeconds`, `ownerQueueSeconds`, `cooldownSeconds`, `fastLaneExtra`, `fastLaneMaxBytes`, `normalMinSlots`, `memoryHeadroomGB` | defaults | Admission and the fast lane (`cluster.md`, "The launcher"); the effective values are logged at start. |
| `server.cluster.sharedCache`, `sharedCacheMaxMB`, `cacheAffinity`, `sharedClosure` | leave off | Opt-in (`cluster.md`, "Options"). `sharedCacheMaxMB` now defaults to 256 when `sharedCache` is on. |
| `server.memory.rejectFraction`, `abortFraction`, `trimAllocator` | defaults (0.85, 0.92, true) | Now measured over the whole cgroup. `trimAllocator` defaults to true with a role (as here), false without one. |
| `modules.tx.instanceCode` | `m0` (default) | The master's code; workers are `tx1`, `tx2`. Cache-ids now start with the code of the process that issued them. |
| `modules.tx.cacheMaxConcepts`, `cacheMaxTotalConcepts`, `usageTrackerMaxCodes`, `usageTrackerMaxCodeLength`, `languageTagCacheSize` | defaults | New limits from #350; logged at start (`Limits: ...`). |
| `modules.tx.sqliteV2` | `{ "content": { "valueSets": true, "codeSystems": true } }` | Unchanged. |

**systemd**

- `ExecStart=/usr/bin/node --expose-gc cluster.js`, `KillMode=mixed` and `MemoryMax=7G` stay. On
  7 GB, cluster-lite's memory-aware default may choose fewer than 2 workers. It logs the choice. With
  `workers: 2` set explicitly, it starts 2 and warns if they don't fit.
- Remove the `lanes.conf` drop-in. Its variables do nothing now.
- Start-up: the launcher now takes a process as ready when it says so over IPC (from its listen
  callback), not from `/health`. A master that exits `server.cluster.maxStartFailures` (6) times in
  a row without ever being ready makes `cluster.js` exit 1; the unit's `Restart=always` (5 s) then
  restarts it.
- Set `OOMPolicy=continue`. With systemd's default (`stop`), a kernel OOM kill of one worker took
  down the whole unit in the 5 Nov abort-policy runs; with `continue`, the launcher restarts the
  worker. `cluster.md` doesn't say this yet.
- The content files (`v2/*.db`, `vsac/vsac-v2.db`) are already on the VM and are reused. Only the
  master writes them; the workers open them read-only (`docs/sqlite-v2-content-store.md` 6.1).

## 1. Code

- Deploy this branch to `~/fhirsmith` as the current code was deployed. `package.json` and
  `package-lock.json` are the same as `sqlite-v2-native`, so `node_modules` is unchanged.
- Behaviour that changes from today's demo, whatever the content setting (from #334 and the
  adapter removal):
  - Expansions answered by the engine are capped at main's response limit: 3,000 codes, since the
    demo sets no `modules.tx.externalLimit`, or the client's `limit` when lower. Today's demo serves
    up to 10,000. A larger `count`, or an unpaged expansion over the limit, is now a 422 too-costly,
    as on main.
  - Value set imports and cross-version excludes are expanded as main expands them; today's demo
    evaluates them as sets on the engine.
- `library.yml` is unchanged. The `npm:` and `internal:vsac` sources switch to content files by config.

## 2. Files to build

All of these go under `~/fhirsmith-data/terminology-cache/`. Nothing is served from that folder: the
syndication feed is off and `server.webBase` is unset. Keep both that way.

| file | from | how | size | time (12-core dev box) | peak RSS |
|---|---|---|---:|---:|---:|
| `vsac/vsac-v2.db` (**private, UMLS-licensed**) | `vsac/vsac-valuesets.db` on the VM | build on the VM, see below | ~520 MiB | 10 s | 0.55 GiB |
| `v2/hl7.terminology#7.5.0.db` | the unpacked package already there | the server builds it at first start, or see below | 44 MiB | 2.3 s | 0.3 GiB |
| `v2/fhir.tx.support#1.0.4.db` | 〃 | 〃 | 259 MiB | 12.5 s | 0.9 GiB |
| `v2/us.cdc.phinvads#0.12.0.db` | 〃 | 〃 | 131 MiB | 4.3 s | 0.5 GiB |
| `v2/fhir.dicom#2025.3.20250714.db` | 〃 | 〃 | 9 MiB | 0.4 s | |
| `v2/{hl7.fhir.us.core#9.0.0, hl7.fhir.uv.sdc#4.0.0, hl7.fhir.uv.ips#2.0.1, ihe.formatcode.fhir#1.6.0}.db` | 〃 | 〃 | < 0.5 MiB each | < 0.1 s each | |

SNOMED CT: nothing to build. The v4 files the demo already has (rebuilt 2026-11-02, with
`concept_normal_form`) are the files this branch reads. LOINC, RxNorm, CPT and the rest are unchanged.

**VSAC.** Build the file on the VM, from the VM's own database, straight into place. Never copy it off the
VM or into a served folder. The importer creates it with mode 0600. The running server does not read this
file, so it can be built before the restart:

```sh
cd ~/fhirsmith   # the new code
node tx/importers/content-v2/import-content-v2.js vsac \
  ~/fhirsmith-data/terminology-cache/vsac/vsac-valuesets.db \
  ~/fhirsmith-data/terminology-cache/vsac/vsac-v2.db
```

If `vsac-v2.db` is missing at start-up, the server converts `vsac-valuesets.db` itself. That takes about
10–20 s, during which the event loop is blocked.

From then on, the server's daily VSAC sync (`refreshIntervalHours: 24`) writes to `vsac-v2.db`, and
`vsac-valuesets.db` is no longer updated. Switching the content store back off later serves that older
snapshot until the next sync. `~/vsac-sync.js` and anything else that writes `vsac-valuesets.db` are not
read while the content store is on.

**Packages.** These are public data. Either let the first start build the files (about +20 s here; allow
+40–60 s on the VM's 2 cores), or build them before the restart while the old server keeps running:

```sh
cd ~/fhirsmith; C=~/fhirsmith-data/terminology-cache; mkdir -p $C/v2
for p in 'hl7.terminology#7.5.0' 'fhir.tx.support#1.0.4' 'ihe.formatcode.fhir#1.6.0' 'fhir.dicom#2025.3.20250714' \
         'hl7.fhir.us.core#9.0.0' 'us.cdc.phinvads#0.12.0' 'hl7.fhir.uv.sdc#4.0.0' 'hl7.fhir.uv.ips#2.0.1'; do
  node tx/importers/content-v2/import-content-v2.js package "$C/$p" "$C/v2/$p.db"
done
```

The server reuses a file when its recorded package hashes and format match, and rebuilds it otherwise.
`hl7.fhir.r4.core` and `r5.core` stay on main's in-memory path; they get no file.

Building the files next to the running demo is fine. The demo uses 2.5 GB RSS, 5.6 GB is available, and
the largest build peaks at 0.9 GiB.

## 3. Config (`~/fhirsmith-data/config.json`, `modules.tx.sqliteV2`)

```json
"sqliteV2": {
  "content": { "valueSets": true, "codeSystems": true }
}
```

- Remove `"sctPostcoordination": "native"` from today's config. The key no longer exists (native is the
  only path), and a key left in place is ignored.

- With no `content` key, both halves are on. Writing it out is still recommended, so the config says what
  runs.
- Value sets only (for comparison): `"content": { "valueSets": true }`. An object means exactly what it
  says, so an omitted half is off.
- Off: `"content": false`. Packages and VSAC are then loaded as main loads them, and the built files
  are ignored. Rolling back the content store needs only this change and a restart. (Rolling back to
  today's code means deploying `sqlite-v2-native` again.)
- No other keys change. `vsacCfg` (key file mode 0600) and the systemd unit stay as they are.

## 4. Start-up and memory

Measured with the demo's own `library.yml` and data (all 9 SNOMED CT files, 3 LOINC, VSAC with 40,267
value sets, the 10 packages), Node 24.16, no `--max-old-space-size` (as the demo's unit file), 12-core
dev box, warm page cache. Memory is taken after a forced GC.

| | content off (= today) | value sets + code systems |
|---|---:|---:|
| start → first answer, files already built | 13.2 s | 12.3 s |
| … first start, files built by the server | — | + about 20 s packages, + 10 s VSAC |
| heap after start | 1,283–1,355 MiB | **367 MiB** |
| anonymous RSS after start | 2,028–2,155 MiB | **696–717 MiB** |
| file-backed RSS (shared, reclaimable page cache) | 77 MiB | 520 MiB |
| peak RSS during start | 2.3–2.4 GiB | 1.3 GiB |

**On the 7 GB VM (2 cores, no swap, Node default heap limit 2,240 MiB):**

- **Start-up.** Today the VM reaches "Server running" 17 s after start. Expect about the same with
  prebuilt files, since start-up here is 1 s faster with the content store. Allow +40–60 s on the first
  start if the server builds the files itself. A start with a cold page cache (right after boot) is slower
  in both configurations, because the SNOMED CT files are read from disk; on the dev box that took up
  to 36 s.
- **Memory.**
  - Today the demo process holds 2.08 GB anonymous RSS. With the content store, expect about 0.7 GB after
    start: roughly 1.35 GB less, plus about 0.45 GB more page cache, which the kernel can reclaim.
  - Under load, most of the growth is upstream's expansion cache (`expansionCacheSize: 1000`), in both
    configurations.
  - Heap headroom under the 2,240 MiB limit goes from about 0.9 GB to about 1.9 GB.
  - With the default heap limit, today's code ran out of heap at about call 16,400 of the IG replay. Value
    sets + code systems finished all 48,002 calls with a heap peak of 1,782 MiB
    (`docs/sqlite-v2-content-store.md` 10.6). No heap flag is needed.

## 5. Checks after the restart

- The log shows `ConceptUsageTracker scan complete` and no `sqlite-v2 content file … built` lines (when
  the files were prebuilt).
- `GET /r4/ValueSet?url=http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.103.12.1001&_elements=url,version`
  finds the VSAC value set.
- `ls -l ~/fhirsmith-data/terminology-cache/vsac/` shows `vsac-v2.db` as `-rw-------`.

## 6. What was verified on this branch (`sqlite-v2-aligned`)

- **HL7 tx-ecosystem suite.** Same harness and data as native's run (validator 7.0.3). The `current`
  test package was refreshed on 2026-11-02, so native was re-run on the same package.
  - Content on and content off each fail 15 distinct tests (43 instances across R4, R5 and cached).
  - Native fails 26 on this package. All 15 are among them; the other 11 pass here (LOINC
    expansions and `*-of-any` ECL, through #334's processCodes). No test fails here that passes on
    native.
- **IG-corpus replay**, 48,002 calls, content on, against `sqlite-v2-integrated` content on. The
  demo's sources, VSAC and v4 SNOMED CT were used.
  - 47,643 calls are identical.
  - In 337 more, the replayed call is identical. Only the tool's follow-up pages differ: it asks for
    10,000 codes at a time, which is now over the response limit.
  - In 21, the request's value set imports other value sets. #334 hands only import-free composes
    to the provider, so these are expanded as main expands them: different version echoes, and a
    too-costly at main's nested-import limit where the engine used to answer.
  - In 1, a filter carries a modifier extension. This is now refused, as main's usual path refuses
    it; integrated answered with an empty expansion.
- **Unit suites.**
  - `tests/vs` 52/52, `tests/tx` (without the tx-ecosystem suite) 1,205/1,205, and `tests/cs`
    1,354 pass.
  - The one failure is `cs-loinc.test.js` "should import LOINC test data", which times out at 120 s
    on `sqlite-v2-native` too.
- **Start-up and memory** (section 4) were measured on `sqlite-v2-integrated`. The aligned branch does
  not change the content store or what is loaded.
