#!/usr/bin/env python3
"""Build data/kan-index.json: every series / program card on Kan's VOD lobby pages (title, url, poster).

Kan's own site search is a third-party widget (HeyDay) with no usable public API, but its VOD lobby pages list the
whole catalogue as plain HTML cards, so the search runs over this small index instead (the Worker filters it).

Fetching uses curl on purpose: Kan sits behind Cloudflare's bot protection and answers Python's urllib with 403,
while curl passes. If a network is blocked anyway and RELAY_URL / RELAY_KEY are set, the page is fetched through the
Israeli relay Worker instead.
"""
import datetime, html, json, os, re, subprocess, sys, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
BASE = "https://www.kan.org.il"
LOBBIES = [BASE + "/lobby/kan-box/", BASE + "/lobby/kan11/"]
CURL = os.environ.get("CURL_BIN", "curl")      # Windows' System32 curl.exe gets challenged by Kan; Git's curl passes
RELAY = os.environ.get("RELAY_URL", "").rstrip("/")
RELAY_KEY = os.environ.get("RELAY_KEY", "")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "kan-index.json")

CARD = re.compile(r'<a[^>]+href="(https://www\.kan\.org\.il/content/kan/([^"/]+)/p-(\d+)/)"[^>]*>(.*?)</a>', re.S)


def curl(url):
    r = subprocess.run([CURL, "-sL", "--max-time", "90", "-A", UA, url], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""


def fetch(url):
    page = curl(url)
    if len(page) < 20000 and RELAY and RELAY_KEY:
        print(f"  direct fetch too small ({len(page)} bytes), retrying through the relay", file=sys.stderr)
        page = curl(f"{RELAY}/r/page?k={RELAY_KEY}&u={urllib.parse.quote(url, safe='')}")
    return page


def attr(tag, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', tag)
    return html.unescape(m.group(1)) if m else ""


def clean_title(t):
    t = html.unescape(t or "").strip()
    t = re.sub(r"^Poster Image\s+\w+\s+\d+X\d+\s*", "", t)      # "Poster Image Small 239X360 <name>"
    t = re.sub(r"\s*[-.]\s*כאן\s*11\s*$", "", t)               # "<name> - כאן 11" / "<name>.כאן 11"
    return re.sub(r"\s+", " ", t).strip(" .-")


JUNK = re.compile(r"\d{3,4}\s*[xX_ ]\s*\d{3,4}|poster|image[_ ]small", re.I)   # an image file name, not a title


def series_title(url):
    """The real program name from the series page itself (used when a card's image alt is just a file name)."""
    page = fetch(url)
    for pat in (r"npawData\.program\s*=\s*decodeEntities\('([^']*)'\)",
                r'<meta property="og:title" content="([^"]*)"', r"<title>([^<]*)"):
        m = re.search(pat, page)
        if m:
            t = clean_title(re.sub(r"\s*[-|]\s*(פרקים מלאים.*|כאן.*)$", "", html.unescape(m.group(1))))
            if t and not JUNK.search(t):
                return t
    return ""


def main():
    found = {}
    for lobby in LOBBIES:
        page = fetch(lobby)
        n0 = len(found)
        for m in CARD.finditer(page):
            url, section, pid, inner = m.groups()
            if url in found:
                continue
            img = re.search(r"<img[^>]+>", inner)
            if not img:
                continue
            title = clean_title(attr(img.group(0), "alt")) or clean_title(attr(img.group(0), "title"))
            src = attr(img.group(0), "src")
            if not title or not src:
                continue
            found[url] = {"t": title, "u": url, "i": urllib.parse.urljoin(BASE, src), "s": section}
        print(f"{lobby}: {len(page)} bytes, +{len(found) - n0} series", file=sys.stderr)
    fixed = 0
    for it in list(found.values()):
        if JUNK.search(it["t"]):
            real = series_title(it["u"])
            if real:
                it["t"] = real
                fixed += 1
            else:
                del found[it["u"]]            # no usable name anywhere: better absent than shown as "1800X1200"
    print(f"resolved {fixed} titles from series pages", file=sys.stderr)
    items = sorted(found.values(), key=lambda x: x["t"])
    if len(items) < 50:                     # a broken parse must never overwrite a good index
        print(f"only {len(items)} series found - keeping the existing index", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"updated": datetime.date.today().isoformat(), "items": items}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(items)} series -> data/kan-index.json", file=sys.stderr)


if __name__ == "__main__":
    main()
