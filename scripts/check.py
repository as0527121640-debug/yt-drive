#!/usr/bin/env python3
"""Static checks for yt-drive:  npm run check   (no network, no deploy, takes a few seconds).

  1. JavaScript syntax (node --check): worker/src/index.js, relay/src/index.js, worker/public/sw.js and the inline
     <script> of worker/public/index.html
  2. Workflows: every .github/workflows/*.yml parses as YAML and every `run:` step passes `bash -n`
  3. The helper scripts the download workflow writes out as heredocs (kan_name.py, kan_list.py, upload_one.sh) are
     extracted and syntax-checked; kan_name.py is also run on sample HTML - Hebrew names must survive
  4. data/kan-index.json parses and has a sane number of series

Exit code 1 if anything fails. PyYAML is needed for step 2 (pip install pyyaml); without it that step is skipped.
"""
import json, os, py_compile, re, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FAILS = []


def report(ok, what, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + what + (("  - " + detail) if detail and not ok else ""))
    if not ok:
        FAILS.append(what)


def find_bash():
    # Git's bash first: on Windows a bare `bash` can be the WSL launcher, which is not what we want
    for p in (os.environ.get("BASH_BIN"), r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if p and os.path.exists(p):
            return p
    return None


BASH = find_bash()


def bash_n(script):
    r = subprocess.run([BASH, "-n"], input=script.encode("utf-8"), capture_output=True)
    return r.returncode == 0, r.stderr.decode("utf-8", "replace").strip()


def node_check(path=None, text=None, label=""):
    node = shutil.which("node")
    if not node:
        return False, "node not found on PATH"
    if text is not None:
        fd, path = tempfile.mkstemp(suffix=".js")
        os.write(fd, text.encode("utf-8"))
        os.close(fd)
    r = subprocess.run([node, "--check", path], capture_output=True)
    if text is not None:
        os.remove(path)
    return r.returncode == 0, r.stderr.decode("utf-8", "replace").strip()[:300]


def main():
    print("1. JavaScript syntax")
    for rel in ("worker/src/index.js", "relay/src/index.js", "worker/public/sw.js"):
        ok, err = node_check(path=os.path.join(ROOT, rel))
        report(ok, rel, err)
    page = open(os.path.join(ROOT, "worker/public/index.html"), encoding="utf-8").read()
    ok, err = node_check(text=re.search(r"<script>(.*?)</script>", page, re.S).group(1))
    report(ok, "worker/public/index.html (inline script)", err)

    print("2. Workflows")
    try:
        import yaml
    except ImportError:
        yaml = None
        print("  skip  PyYAML not installed (pip install pyyaml)")
    wf_dir = os.path.join(ROOT, ".github", "workflows")
    download_steps = {}
    if yaml and BASH:
        for name in sorted(os.listdir(wf_dir)):
            if not name.endswith((".yml", ".yaml")):
                continue
            try:
                wf = yaml.safe_load(open(os.path.join(wf_dir, name), encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                report(False, name + " parses as YAML", str(e)[:200])
                continue
            report(True, name + " parses as YAML")
            for job in (wf.get("jobs") or {}).values():
                for step in job.get("steps", []):
                    if "run" not in step:
                        continue
                    ok, err = bash_n(step["run"])
                    report(ok, f"{name}: step '{step.get('name', '?')}' passes bash -n", err)
                    if name == "yt-drive.yml":
                        download_steps[step.get("name")] = step["run"]
    elif yaml and not BASH:
        print("  skip  bash not found (set BASH_BIN)")

    print("3. Embedded helper scripts")
    dl = download_steps.get("Download")
    if dl:
        for name in ("kan_name.py", "kan_list.py", "upload_one.sh"):
            m = re.search(r"cat > %s <<'(\w+)'\n(.*?)\n\1\n" % re.escape(name), dl, re.S)
            if not m:
                report(False, name + " is embedded in the Download step")
                continue
            body = m.group(2) + "\n"
            if name.endswith(".py"):
                fd, tmp = tempfile.mkstemp(suffix=".py")
                os.write(fd, body.encode("utf-8"))
                os.close(fd)
                try:
                    py_compile.compile(tmp, doraise=True)
                    report(True, name + " compiles")
                except py_compile.PyCompileError as e:
                    report(False, name + " compiles", str(e)[:200])
                if name == "kan_name.py":
                    env = dict(os.environ, PYTHONUTF8="1")
                    samples = [
                        ("<title>עלומים | פרק 1</title>", [], "עלומים - פרק 1"),
                        ('<script type="application/ld+json">{"@type":"VideoObject","name":"סדרה: &quot;בדיקה&quot; | פרק 2 - כותרת?"}</script>', [], "סדרה בדיקה - פרק 2 - כותרת"),
                        ("שם: עם | תווים?", ["--plain"], "שם עם - תווים"),
                    ]
                    for html, args, want in samples:
                        r = subprocess.run([sys.executable, tmp] + args, input=html.encode("utf-8"), capture_output=True, env=env)
                        got = r.stdout.decode("utf-8", "replace").strip()
                        report(got == want, f"kan_name.py {' '.join(args)} -> {want!r}", f"got {got!r}")
                os.remove(tmp)
            else:
                ok, err = bash_n(body)
                report(ok, name + " passes bash -n", err)
    else:
        print("  skip  Download step not found (needs PyYAML + bash)")

    print("4. Kan index")
    try:
        d = json.load(open(os.path.join(ROOT, "data", "kan-index.json"), encoding="utf-8"))
        items = d.get("items", [])
        report(len(items) >= 50, f"data/kan-index.json has {len(items)} series (updated {d.get('updated')})")
        report(all(x.get("t") and x.get("u") and x.get("i") for x in items), "every series has a title, url and poster")
    except Exception as e:  # noqa: BLE001
        report(False, "data/kan-index.json is readable", str(e)[:200])

    print()
    if FAILS:
        print(f"{len(FAILS)} check(s) FAILED")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
