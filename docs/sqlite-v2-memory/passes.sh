#!/bin/bash
# start one server, run the catalog N times, RssAnon after a forced GC after each pass
M=/home/jmandel/hobby/.agent-scratch/mem; R=${REPO:-/home/jmandel/hobby/.agent-scratch/fhirsmith-sqlite-v2-provider}; D=$M/runs/nocacheL-r1
uptime; free -m | sed -n 2p
cd $R && (FHIRSMITH_DATA_DIR=$D systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 node --expose-gc server.js > $D/passes.log 2>&1 &)
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" localhost:8094/r4/metadata 2>/dev/null | grep -q 200 && break; sleep 1; done
PID=$(ss -ltnpH "sport = :8094" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)
anon(){ curl -s "localhost:8094/r4/sqlite-v2/stats?gc=1" >/dev/null; sleep 1; grep RssAnon /proc/$PID/status | awk '{print int($2/1024)}'; }
echo "start $(anon)"
for p in ${PASSES:-1 2 3 4 5 6}; do node tx/sqlite-v2/catalog/replay.js --base http://localhost:8094/r4 ${CAT:+--category $CAT} > /dev/null 2>&1; echo "pass $p $(anon)"; done
kill $PID
