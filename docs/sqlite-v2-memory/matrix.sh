#!/bin/bash
M=/home/jmandel/hobby/.agent-scratch/mem; R=$M/tools/run.sh
: > $M/results/measure.jsonl
COLD=1 $R ours-none-cold v2 8094 yes '{"sqliteV2":{"cacheProfile":"none"}}'
$R ours-none v2 8094 yes '{"sqliteV2":{"cacheProfile":"none"}}'
$R ours-sets v2 8094 yes '{"sqliteV2":{"resultCacheMB":0,"codeCacheEntries":0},"expansionCacheSize":0}'
$R ours-results v2 8094 yes '{"sqliteV2":{"setCacheMB":0,"codeCacheEntries":0},"expansionCacheSize":0}'
$R ours-codes v2 8094 yes '{"sqliteV2":{"setCacheMB":0,"resultCacheMB":0},"expansionCacheSize":0}'
$R ours-expansion v2 8094 yes '{"sqliteV2":{"setCacheMB":0,"resultCacheMB":0,"codeCacheEntries":0}}'
$R ours-default v2 8094 yes '{"sqliteV2":{}}'
$R main-default main 8093 yes '{}'
$R main-noexp main 8093 yes '{"expansionCacheSize":0}'
COLD=1 $R main-cold main 8093 yes '{"expansionCacheSize":0}'
$R base-node v2 8094 no "{\"librarySource\":\"$M/lib-node-baseline.yml\"}"
$R small-only v2 8094 no "{\"librarySource\":\"$M/lib-small-only.yml\"}"
$R v2-only v2 8094 no "{\"librarySource\":\"$M/lib-v2-only.yml\"}"
$R ours-no-us v2 8094 no "{\"librarySource\":\"$M/lib-v2-no-us.yml\"}"
$R main-big-only main 8093 no "{\"librarySource\":\"$M/lib-main-big-only.yml\"}"
$R main-no-us main 8093 no "{\"librarySource\":\"$M/lib-main-no-us.yml\"}"
$R main-plus-us2023 main 8093 no "{\"librarySource\":\"$M/lib-main-plus-us2023.yml\"}"
echo MATRIX DONE
