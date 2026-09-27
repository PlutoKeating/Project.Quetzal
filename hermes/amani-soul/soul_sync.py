#!/usr/bin/env python3
"""Hermes 一侧的灵魂同步：init / sync / journal。只依赖 git 与 Python 标准库。
合并规则与 Amani 运行基座（runtime/src/memory/soul-sync.ts）一致。"""
import datetime, os, re, shutil, subprocess, sys

HERMES = os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))
SOUL = os.path.expanduser(os.environ.get("AMANI_SOUL_DIR", "~/amani-soul"))
BODY = os.environ.get("AMANI_BODY", "hermes")
LINKS = {"SOUL.md": "SOUL.md", "memories/MEMORY.md": "memories/MEMORY.md", "memories/USER.md": "memories/USER.md"}


def git(*a, check=True):
    r = subprocess.run(["git", "-C", SOUL, *a], capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f"git {' '.join(a)} 失败：{r.stderr.strip()}")
    return r


def entries(s):
    return [e.strip() for e in re.split(r"\n?§\n?", s or "") if e.strip()]


def join(e):
    return "\n§\n".join(e) + ("\n" if e else "")


def merge_entries(base, ours, theirs):
    b, o, t = set(entries(base)), entries(ours), entries(theirs)
    out = []
    for e in o + t:
        if e in b and (e not in o or e not in t):
            continue
        if e not in out:
            out.append(e)
    return join(out)


def read(p):
    try:
        return open(p, encoding="utf-8").read()
    except FileNotFoundError:
        return ""


def commit(msg):
    git("add", "-A")
    git("commit", "-m", f"{msg}（{BODY}）", check=False)


def sync():
    commit("会话同步")
    if git("fetch", "origin", check=False).returncode:
        print("拉取失败（离线或无权限），稍后再试"); return
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if git("rev-parse", "--verify", f"origin/{branch}", check=False).returncode == 0:
        m = git("merge", "--no-edit", "--allow-unrelated-histories", f"origin/{branch}", check=False)
        if m.returncode:
            for f in git("diff", "--name-only", "--diff-filter=U").stdout.split():
                show = lambda n: git("show", f":{n}:{f}", check=False).stdout
                path = os.path.join(SOUL, f)
                if f.startswith("memories/"):
                    open(path, "w", encoding="utf-8").write(merge_entries(show(1), show(2), show(3)))
                elif f == "SOUL.md":
                    open(path, "w", encoding="utf-8").write(show(2))
                    open(os.path.join(SOUL, "SOUL.incoming.md"), "w", encoding="utf-8").write(show(3))
                else:
                    open(path, "w", encoding="utf-8").write(show(2))
            commit("合并来自其他身体的记忆")
    git("push", "origin", f"HEAD:{branch}", check=False)
    print("已同步")


def init(url):
    if not os.path.isdir(os.path.join(SOUL, ".git")):
        r = subprocess.run(["git", "clone", url, SOUL], capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f"克隆失败：{r.stderr.strip()}")
    git("config", "user.name", f"Amani ({BODY})")
    git("config", "user.email", f"amani@{BODY}.local")
    if git("rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip() in ("", "HEAD"):
        git("checkout", "-b", "main", check=False)
    backup = os.path.join(HERMES, "backup-amani-soul-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    for src, dst in LINKS.items():
        h, s = os.path.join(HERMES, src), os.path.join(SOUL, dst)
        if os.path.islink(h):
            continue
        local = read(h)
        os.makedirs(os.path.dirname(s), exist_ok=True)
        if src.startswith("memories/"):
            open(s, "w", encoding="utf-8").write(merge_entries("", read(s), local))
        elif local.strip() and not read(s).strip():
            open(s, "w", encoding="utf-8").write(local)
        elif local.strip() and local != read(s):
            open(os.path.join(SOUL, "SOUL.incoming.md"), "w", encoding="utf-8").write(local)
        if os.path.exists(h):
            os.makedirs(os.path.dirname(os.path.join(backup, src)), exist_ok=True)
            shutil.move(h, os.path.join(backup, src))
        os.makedirs(os.path.dirname(h), exist_ok=True)
        os.symlink(s, h)
    commit("接入灵魂仓库")
    sync()
    print(f"完成。原文件备份在 {backup}")


def journal(title, text):
    now = datetime.datetime.now()
    p = os.path.join(SOUL, "journal", BODY, now.strftime("%Y-%m-%d") + ".md")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    head = "" if os.path.exists(p) else f"# {now:%Y-%m-%d} · {BODY}\n"
    open(p, "a", encoding="utf-8").write(f"{head}\n## {now:%H:%M} {title}\n\n{text.strip()}\n")
    print("已写入日记")


if __name__ == "__main__":
    cmd = sys.argv[1:] or ["sync"]
    {"init": lambda: init(cmd[1]), "sync": sync, "journal": lambda: journal(cmd[1], cmd[2])}[cmd[0]]()
