#!/usr/bin/env bash
# 分批克隆：先浅克隆最新一版，再一层层往前补历史，直到完整。
# 适用于任意 Git 仓库（GitHub / GitLab / Gitee / 自建服务都行）。
#
# 特性：
#   - 每层只传一小段，网络差也不容易整单失败；
#   - 成功一层自动继续下一层；
#   - 某层失败就停下并保留进度，重新运行同一条命令会接着补；
#   - 补完自动确认历史是否完整。
#
# 用法：
#   bash clone-with-history.sh <仓库地址> [保存目录] [选项]
#
# 选项：
#   -b, --branch <分支>    只克隆某个分支（默认用仓库的默认分支）
#   -s, --step <条数>      每层补多少条提交（默认 100）
#   -r, --retries <次数>   每层失败重试几次（默认 3）
#   -a, --all-branches     所有分支都取（更慢，能看到全部分支的历史）
#   -h, --help             显示帮助
#
# 例子：
#   bash clone-with-history.sh https://github.com/owner/repo.git
#   bash clone-with-history.sh git@github.com:owner/repo.git my-repo -b main -s 50
#
# 注意：这是「完整历史」方案；如果只想快速看文件，直接 git clone --depth 1 即可。

set -u

URL=""
DIR=""
BRANCH=""
STEP=100
RETRIES=3
ALL_BRANCHES=0
ROUND=0

say() { printf '%s\n' "$*"; }

usage() {
  sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
}

die() { say "错误：$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -b|--branch) [ $# -ge 2 ] || die "--branch 后面要跟分支名"; BRANCH="$2"; shift 2 ;;
    -s|--step) [ $# -ge 2 ] || die "--step 后面要跟数字"; STEP="$2"; shift 2 ;;
    -r|--retries) [ $# -ge 2 ] || die "--retries 后面要跟数字"; RETRIES="$2"; shift 2 ;;
    -a|--all-branches) ALL_BRANCHES=1; shift ;;
    -*) die "未知选项 $1（用 -h 看帮助）" ;;
    *)
      if [ -z "$URL" ]; then URL="$1"
      elif [ -z "$DIR" ]; then DIR="$1"
      else die "多余的参数：$1"
      fi
      shift ;;
  esac
done

[ -n "$URL" ] || { usage; die "请提供仓库地址"; }

case "$STEP" in ''|*[!0-9]*) die "--step 必须是正整数" ;; esac
case "$RETRIES" in ''|*[!0-9]*) die "--retries 必须是非负整数" ;; esac

command -v git >/dev/null 2>&1 || die "没有找到 git，请先安装 Git，或使用 Miaoxin Git GUI 的终端。"

if [ -z "$DIR" ]; then
  base=$(basename "$URL")
  DIR="${base%.git}"
fi

# 网络不稳时更耐用的传输设置（只影响本机全局配置，对 SSH 无副作用）
git config --global http.version HTTP/1.1 2>/dev/null || true
git config --global http.postBuffer 524288000 2>/dev/null || true
git config --global http.lowSpeedLimit 1000 2>/dev/null || true
git config --global http.lowSpeedTime 60 2>/dev/null || true

# ---------- 第 1 步：浅克隆 ----------
if [ ! -e "$DIR" ]; then
  say "第 1 步：浅克隆 $URL"
  clone_args="--depth 1"
  [ "$ALL_BRANCHES" -eq 1 ] && clone_args="$clone_args --no-single-branch"
  [ -n "$BRANCH" ] && clone_args="$clone_args --branch $BRANCH"

  ok=0
  i=1
  while [ "$i" -le "$RETRIES" ]; do
    # shellcheck disable=SC2086
    if git clone $clone_args --progress "$URL" "$DIR"; then ok=1; break; fi
    say "浅克隆失败（第 $i 次），清理半成品后重试……"
    rm -rf "$DIR"
    sleep $((i * 3))
    i=$((i + 1))
  done
  [ "$ok" -eq 1 ] || die "浅克隆没有成功，等网络好一些再运行一次。"
elif [ -d "$DIR/.git" ]; then
  say "检测到已有仓库目录：$DIR（从当前进度继续）"
else
  die "$DIR 已存在但不是 Git 仓库，请换一个目录名或先把它移走。"
fi

cd "$DIR" || die "进不去目录 $DIR"

# ---------- 第 2 步：一层层补历史 ----------
# 用 git 自己的判断，而不是看 .git/shallow 文件是否存在：
# 补到根提交时文件可能还在，但 git 已经认为历史完整。
is_shallow() {
  [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]
}

while is_shallow; do
  ROUND=$((ROUND + 1))
  before=$(git rev-list --count HEAD 2>/dev/null || echo 0)
  say ""
  say "第 $ROUND 层：再往前补 $STEP 条提交（当前 $before 条）"

  ok=0
  i=1
  while [ "$i" -le "$RETRIES" ]; do
    if [ -n "$BRANCH" ]; then
      git fetch --deepen="$STEP" origin "$BRANCH" --progress && { ok=1; break; }
    else
      git fetch --deepen="$STEP" --progress && { ok=1; break; }
    fi
    say "这一层失败（第 $i 次），等 $((i * 3)) 秒重试……"
    sleep $((i * 3))
    i=$((i + 1))
  done

  if [ "$ok" -ne 1 ]; then
    say ""
    say "这一层没成功。已经下载的内容都保留着，不会丢。"
    say "等网络好一点，重新运行同一条命令，就会从当前进度继续。"
    exit 1
  fi

  after=$(git rev-list --count HEAD 2>/dev/null || echo 0)
  if [ "$after" -le "$before" ]; then
    say "这一层没有新增提交，尝试一次性补齐剩余历史……"
    if [ -n "$BRANCH" ]; then
      git fetch --unshallow origin "$BRANCH" --progress 2>/dev/null || true
    else
      git fetch --unshallow --progress 2>/dev/null || true
    fi
    if is_shallow; then
      say "补齐失败，进度已保留，稍后重新运行本脚本即可。"
      exit 1
    fi
  fi
done

# ---------- 第 3 步：确认 ----------
say ""
say "历史已经完整：共 $(git rev-list --count HEAD 2>/dev/null || echo 0) 条提交。"
say "仓库位置：$(pwd)"
say "下一步可以进入目录：cd \"$(pwd)\""
