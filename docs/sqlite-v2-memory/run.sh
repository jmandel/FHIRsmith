#!/bin/bash
# run.sh <label> <base dir main|v2> <port> <replay yes|no> <json overrides for modules.tx> [extra-replay-cold yes|no]
M=/home/jmandel/hobby/.agent-scratch/mem
label=$1; base=$2; port=$3; replay=$4; over=$5
D=$M/runs/$label; mkdir -p $D $M/results
cp -r $M/$base/terminology-cache $D/ 2>/dev/null || true
rm -rf $D/terminology-cache; ln -sfn $M/$base/terminology-cache $D/terminology-cache
python3 - <<PY
import json
c=json.load(open('$M/$base/config.json')); t=c['modules']['tx']
t.update(json.loads('''$over'''))
json.dump(c,open('$D/config.json','w'),indent=2)
PY
if [ "$COLD" = 1 ]; then
  python3 -I - <<'PY'
import os,glob
for f in glob.glob('/home/jmandel/hobby/.agent-scratch/mem/v2/terminology-cache/*.db')+glob.glob('/home/jmandel/hobby/.agent-scratch/mem/main/terminology-cache/*.cache')+glob.glob('/home/jmandel/hobby/.agent-scratch/mem/main/terminology-cache/*.db'):
    r=os.path.realpath(f); fd=os.open(r,os.O_RDONLY); os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED); os.close(fd)
print('dropped from page cache')
PY
fi
uptime >> $M/results/loadavg.txt; free -m | sed -n 2p >> $M/results/loadavg.txt
systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 timeout 3000 node $M/tools/measure.js $label $D $port $replay $M/results | tee -a $M/results/measure.jsonl
