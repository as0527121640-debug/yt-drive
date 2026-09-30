#!/usr/bin/env python3
"""Build data/c13-index.json: every Reshet 13 series that has full episodes (title, url, poster, genres, date, count).

13tv.co.il sits behind a bot wall, but its catalogue is a Kaltura OTT back end that answers the anonymous session every
visitor's browser opens. The full series list is ~850 KB of JSON (long summaries included) - too heavy to parse inside
the free Worker's 10 ms CPU budget - so this daily job boils it down to a small index, as build_kan_index.py does for
Kan. Series without a single full episode (only clips) are left out.
"""
import concurrent.futures, datetime, json, os, sys, urllib.request

B = "https://5031.frp1.ott.kaltura.com/api_v3/service/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "c13-index.json")
SERIES, EPISODE = 1259, 1268


def call(svc, body):
    req = urllib.request.Request(B + svc, json.dumps(dict(body, apiVersion="5.4.0")).encode(),
                                 {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    res = json.load(urllib.request.urlopen(req, timeout=60))["result"]
    if isinstance(res, dict) and res.get("error"):
        raise RuntimeError(res["error"].get("message"))
    return res


def main():
    ks = call("ottuser/action/anonymousLogin", {"partnerId": 5031})["ks"]

    def lst(ksql, n, props, order="START_DATE_DESC"):
        return call("asset/action/list", {"ks": ks, "pager": {"pageSize": n, "pageIndex": 1},
                    "filter": {"objectType": "KalturaSearchAssetFilter", "kSql": ksql, "orderBy": order},
                    "responseProfile": {"objectType": "KalturaOnDemandResponseProfile", "retrievedProperties": props}})

    series = lst("asset_type='%d'" % SERIES, 500, "id,name,metas,images,tags").get("objects") or []
    print(f"{len(series)} series in the catalogue", file=sys.stderr)

    def meta(o, k):
        return ((o.get("metas") or {}).get(k) or {}).get("value")

    def count(o):
        sid = meta(o, "SeriesID")
        return lst("(and SeriesID='%s' asset_type='%d')" % (sid, EPISODE), 1, "id").get("totalCount", 0) if sid else 0

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        counts = list(pool.map(count, series))

    items = []
    for o, n in zip(series, counts):
        sid = meta(o, "SeriesID")
        if not sid or not n:
            continue
        imgs = o.get("images") or []
        im = next((i for i in imgs if i.get("ratio") == "2x3"), imgs[0] if imgs else None)
        genres = [v["value"] for v in (((o.get("tags") or {}).get("Genre") or {}).get("objects") or []) if v.get("value")]
        items.append({"t": (o.get("name") or "").strip(), "u": f"https://13tv.co.il/allshows/series/{sid}/",
                      "i": f"{im['url']}/width/240/height/360" if im and im.get("url") else "",
                      "g": genres, "d": meta(o, "CatalogStartDateTime") or o.get("startDate") or 0, "n": n})
    if len(items) < 50:                     # a broken run must never overwrite a good index
        print(f"only {len(items)} series found - keeping the existing index", file=sys.stderr)
        sys.exit(1)
    items.sort(key=lambda x: -int(x["d"] or 0))     # newest first, like the site's own lobby
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"updated": datetime.date.today().isoformat(), "items": items}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(items)} series -> data/c13-index.json ({len(series) - len(items)} without full episodes)", file=sys.stderr)


if __name__ == "__main__":
    main()
