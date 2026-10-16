#!/usr/bin/env python3
"""One-shot, no-refresh import of complete published leaderboard snapshots."""
import csv
import io
import json 
import os
from pathlib import Path
from datetime import datetime, timezone
import requests

OUT = Path(os.environ.get("BENCHMARK_OUT", "./benchmark-snapshots"))
OUT.mkdir(parents=True, exist_ok=True)
S = requests.Session()
S.headers.update({"User-Agent": "rr-benchmark-one-shot-import/1.0"})

def get(url):
    r = S.get(url, timeout=120)
    r.raise_for_status()
    return r

def save(name, source, rows, extra=None):
    path = OUT / name
    if path.exists():
        print(f"EXISTS (not refreshed): {path}")
        return
    if not rows:
        raise RuntimeError(f"Empty source: {source}")
    doc = {"source":source,"captured_at":datetime.now(timezone.utc).isoformat(),
           "complete":True,"record_count":len(rows),"records":rows}
    if extra:
        doc.update(extra)
    temp=path.with_suffix(".json.tmp")
    with temp.open("w", encoding="utf-8") as f:
        json.dump(doc,f,ensure_ascii=False,indent=2,allow_nan=False)
    temp.replace(path)
    print(f"SAVED {path}: {len(rows)} records")

def arena(config):
    name=f"arena-{config}.json"
    if (OUT/name).exists():
        print(f"EXISTS (not refreshed): {OUT/name}")
        return
    try:
        import pyarrow.parquet as pq
    except ImportError:
        raise SystemExit("Install dependency first: python -m pip install requests pyarrow")
    source=f"https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/{config}/latest-00000-of-00001.parquet"
    data=get(source).content
    table=pq.read_table(io.BytesIO(data))
    rows=table.to_pylist()
    save(name,source,rows,{"arena_subset":config,"split":"latest"})

def livebench():
    name="livebench-latest.json"
    if (OUT/name).exists():
        print(f"EXISTS (not refreshed): {OUT/name}")
        return
    api="https://api.github.com/repos/LiveBench/new-livebench/contents/public"
    entries=get(api).json()
    tables=sorted(x["name"] for x in entries if x["name"].startswith("table_") and x["name"].endswith(".csv"))
    if not tables:
        raise RuntimeError("LiveBench release table not found")
    table=tables[-1]
    date=table.removeprefix("table_").removesuffix(".csv")
    base="https://raw.githubusercontent.com/LiveBench/new-livebench/main/public/"
    source=base+table
    rows=list(csv.DictReader(io.StringIO(get(source).text)))
    cats=get(base+f"categories_{date}.json").json()
    save(name,source,rows,{"release":date,"categories":cats,"score_note":"Raw per-task scores, as published"})

if __name__=="__main__":
    errors=[]
    for config in ("text","text_style_control","webdev","agent","search"):
        try: arena(config)
        except Exception as exc:
            errors.append(f"arena/{config}: {exc}")
            print("FAILED:",errors[-1])
    try: livebench()
    except Exception as exc:
        errors.append(f"livebench: {exc}")
        print("FAILED:",errors[-1])
    if errors:
        raise SystemExit("Incomplete import:\n"+"\n".join(errors))
    print("All snapshots saved. Future runs will not re-download existing files.")

