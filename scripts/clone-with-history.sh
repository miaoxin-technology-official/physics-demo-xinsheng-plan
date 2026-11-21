#!/usr/bin/env bash
# 分批克隆：先浅克隆，再一层层往前补历史，直到补完或到达你设定的上限。
# 适用于任意 Git 仓库（GitHub / GitLab / Gitee / 自建服务都行）。
#
# 特性：
#   - 默认取全部分支的历史；只想省流量可以用 --single-branch；
#   - 每层只传一小段，网络差也不容易整单失败；
#   - 成功一层自动继续下一层；
#   - 某层失败自动把每层条数减半重试（100 → 50 → … → 1），减到 1 条仍失败才停下；
#   - 停下后进度保留，重新运行同一条命令会接着补；
#   - 可以用 --max-commits 限制最多取多少条提交（默认不限，取完整历史；
#     Git 按分支深度补，实际条数可能比设定略多几条）。
#
# 用法：
#   bash clone-with-history.sh <仓库地址> [保存目录] [选项]
#
# 选项：
#   -b, --branch <分支>        只克隆指定分支（会自动切换成单分支模式）
#   -s, --step <条数>          每层补多少条提交（默认 100）
#   -r, --retries <次数>       每层失败重试几次（默认 3）
#   -m, --max-commits <条数>   最多取多少条提交（近似值），0 表示不限（默认 0）
#   -1, --single-branch        只取默认分支（默认取全部分支）
#   -a, --all-branches         取全部分支（默认行为，保留此参数便于书写）
#   -h, --help                 显示帮助
#
# 例子：
#   bash clone-with-history.sh https://github.com/owner/repo.git
#   bash clone-with-history.sh git@github.com:owner/repo.git my-repo -b main -s 50
#   bash clone-with-history.sh https://github.com/owner/repo.git -m 300
#   bash clone-with-history.sh https://github.com/owner/repo.git --single-branch

set -u

URL=""
DIR=""
BRANCH=""
STEP=100
RETRIES=3
MAX_COMMITS=0
ALL_BRANCHES=1
ROUND=0

say() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
用法：
  bash clone-with-history.sh <仓库地址> [保存目录] [选项]

选项：
  -b, --branch <分支>        只克隆指定分支（自动切换成单分支模式）
  -s, --step <条数>          每层补多少条提交（默认 100）
  -r, --retries <次数>       每层失败重试几次（默认 3）
  -m, --max-commits <条数>   最多取多少条提交（近似值），0 表示不限（默认 0 = 完整历史）
  -1, --single-branch        只取默认分支（默认取全部分支）
  -a, --all-branches         取全部分支（默认行为，保留此参数便于书写）
  -h, --help                 显示帮助

例子：
  bash clone-with-history.sh https://github.com/owner/repo.git
  bash clone-with-history.sh git@github.com:owner/repo.git my-repo -b main -s 50
  bash clone-with-history.sh https://github.com/owner/repo.git -m 300
EOF
}

die() { say "错误：$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -b|--branch) [ $# -ge 2 ] || die "--branch 后面要跟分支名"; BRANCH="$2"; ALL_BRANCHES=0; shift 2 ;;
    -s|--step) [ $# -ge 2 ] || die "--step 后面要跟数字"; STEP="$2"; shift 2 ;;
    -r|--retries) [ $# -ge 2 ] || die "--retries 后面要跟数字"; RETRIES="$2"; shift 2 ;;
    -m|--max-commits) [ $# -ge 2 ] || die "--max-commits 后面要跟数字"; MAX_COMMITS="$2"; shift 2 ;;
    -1|--single-branch) ALL_BRANCHES=0; shift ;;
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
case "$MAX_COMMITS" in ''|*[!0-9]*) die "--max-commits 必须是非负整数" ;; esac
[ "$STEP" -ge 1 ] || die "--step 至少为 1"

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

count_all() { git rev-list --count --all 2>/dev/null || echo 0; }

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

reached_limit() {
  [ "$MAX_COMMITS" -gt 0 ] && [ "$(count_all)" -ge "$MAX_COMMITS" ]
}

while is_shallow; do
  if reached_limit; then
    say "已达到上限 $MAX_COMMITS 条提交，停止补历史。"
    break
  fi

  ROUND=$((ROUND + 1))
  before=$(count_all)
  say ""
  say "第 $ROUND 层：再往前补 $STEP 条提交（当前 $before 条）"

  # 同一层内失败就减小步长再试：100 -> 50 -> 25 ... -> 1，
  # 每一步要传的包更小，成功率更高；到 1 条还失败才停下。
  ok=0
  while [ "$ok" -eq 0 ]; do
    use_step=$STEP
    if [ "$MAX_COMMITS" -gt 0 ]; then
      remaining=$((MAX_COMMITS - $(count_all)))
      [ "$remaining" -lt 1 ] && remaining=1
      [ "$remaining" -lt "$use_step" ] && use_step=$remaining
    fi

    i=1
    while [ "$i" -le "$RETRIES" ]; do
      if [ -n "$BRANCH" ]; then
        git fetch --deepen="$use_step" origin "$BRANCH" --progress && { ok=1; break; }
      else
        git fetch --deepen="$use_step" --progress && { ok=1; break; }
      fi
      say "用 $use_step 条/层失败（第 $i 次），等 $((i * 3)) 秒重试……"
      sleep $((i * 3))
      i=$((i + 1))
    done

    if [ "$ok" -eq 0 ]; then
      if [ "$STEP" -le 1 ]; then
        say ""
        say "已经减到每次 1 条还是失败。进度都保留着，不会丢。"
        say "等网络好一点，重新运行同一条命令，就会从当前进度继续。"
        exit 1
      fi
      STEP=$((STEP / 2))
      [ "$STEP" -lt 1 ] && STEP=1
      say "把每层减半到 $STEP 条，继续重试这一层……"
      sleep 3
    fi
  done

  after=$(count_all)
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
if is_shallow; then
  say "已按上限 $MAX_COMMITS 条提交停止，当前仍是浅克隆（实际约 $(count_all) 条）。"
  say "想要更多历史时，去掉 --max-commits（或把它调大）再运行一次即可继续补。"
  say "（Git 是按分支深度补历史的，实际条数可能比设定略多几条。）"
else
  say "历史已经完整：共 $(count_all) 条提交。"
fi
say "仓库位置：$(pwd)"
