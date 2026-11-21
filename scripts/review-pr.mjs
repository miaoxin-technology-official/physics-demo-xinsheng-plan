#!/usr/bin/env node
/**
 * review-pr.mjs — PR 自动初审（只读）
 *
 * 原则：
 *   - 只读：只通过 GitHub API 读 PR、读文件，不检出、不执行 PR 里的任何代码；
 *   - 只评论：结果发成一条 PR 评论，不改代码、不提交、不 approve、不合并；
 *   - 保守：物理正确性、版权判断只给「待人工」线索，不阻断。
 *
 * 确定性检查（脚本）：结构、必需文件、体积、禁止文件、许可、README 字段、
 * 交互特征、外部资源、索引改动、基础设施改动。
 * 语义检查（DeepSeek，可选）：README 与课件是否一致、物理表述疑点、版权线索。
 *
 * 环境变量：
 *   GITHUB_TOKEN        必填，只读即可评论（pull-requests: write）
 *   GITHUB_REPOSITORY   必填，owner/repo
 *   PR_NUMBER           必填
 *   DEEPSEEK_API_KEY    可选；没有就只跑脚本检查
 *   DRY_RUN=1           可选；只打印评论，不发到 GitHub
 */

const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const PR_NUMBER = Number(process.env.PR_NUMBER || 0);
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const MARKER = "<!-- ai-pr-review -->";

const STAGES = ["junior_high", "senior_high"];
const BLACKLIST = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)__MACOSX\//,
  /\.(exe|dll|msi|scr|com|pif)$/i,
];
const MAX_SIZE = 5 * 1024 * 1024;

if (!TOKEN || !REPO || !PR_NUMBER) {
  console.error("缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / PR_NUMBER");
  process.exit(2);
}

const [OWNER, NAME] = REPO.split("/");

async function api(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dsh-ai-pr-review",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function readFile(path, ref, limit = 200000) {
  try {
    const data = await api(`/repos/${OWNER}/${NAME}/contents/${encodeURIComponent(path)}?ref=${ref}`);
    if (Array.isArray(data) || !data.content) return "";
    const text = Buffer.from(data.content, "base64").toString("utf8");
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

/* ---------------- 确定性检查 ---------------- */

const items = [];
const add = (level, category, file, message, suggestion) =>
  items.push({ level, category, file, message, suggestion });

const LICENSE_RULES = [
  [/CC\s*BY-SA\s*4\.0|Attribution-ShareAlike\s*4\.0/i, "CC-BY-SA-4.0"],
  [/CC\s*BY\s*4\.0|Creative Commons Attribution\s*4\.0/i, "CC-BY-4.0"],
  [/CC0/i, "CC0-1.0"],
  [/Apache[- ]2\.0|Apache License,?\s*Version 2\.0/i, "Apache-2.0"],
  [/GNU GENERAL PUBLIC LICENSE\s*Version 3/i, "GPL-3.0"],
  [/MIT License|\bMIT\b/, "MIT"],
];

function detectLicense(text) {
  if (!text) return null;
  for (const [re, id] of LICENSE_RULES) if (re.test(text)) return id;
  return null;
}

function isCoursewarePath(p) {
  return STAGES.some((s) => p === s || p.startsWith(`${s}/`));
}

function parseCoursewareDir(p) {
  const seg = p.split("/");
  if (seg.length < 4) return null;
  return {
    stage: seg[0],
    subject: seg[1],
    topic: seg[2],
    dir: seg[3],
    root: seg.slice(0, 4).join("/"),
  };
}

const DIR_RE = /^[^()\s]+\([A-Za-z0-9][A-Za-z0-9_.-]*\)$/;

/* ---------------- 主流程 ---------------- */

const pr = await api(`/repos/${OWNER}/${NAME}/pulls/${PR_NUMBER}`);
const changed = [];
for (let page = 1; page <= 10; page += 1) {
  const batch = await api(`/repos/${OWNER}/${NAME}/pulls/${PR_NUMBER}/files?per_page=100&page=${page}`);
  changed.push(...batch);
  if (batch.length < 100) break;
}

const headSha = pr.head.sha;
const tree = await api(`/repos/${OWNER}/${NAME}/git/trees/${headSha}?recursive=1`);
const blobs = new Map();
for (const entry of tree.tree || []) {
  if (entry.type === "blob") blobs.set(entry.path, entry.size ?? 0);
}

const coursewareDirs = new Map();
const infraFiles = [];
const indexFiles = [];

for (const f of changed) {
  const p = f.filename;
  if (!isCoursewarePath(p)) {
    if (p.startsWith("index/")) indexFiles.push(p);
    else infraFiles.push(p);
    continue;
  }
  const parsed = parseCoursewareDir(p);
  if (!parsed) {
    add("block", "结构", p, "文件不在 <学段>/<学科>/<知识点>/<课件名>(<作者>)/ 下", "把它放进正确的四级目录");
    continue;
  }
  if (!coursewareDirs.has(parsed.root)) coursewareDirs.set(parsed.root, parsed);
}

if (indexFiles.length > 0) {
  add("warn", "仓库", indexFiles[0], "PR 改了 index/，索引由 Action 自动重建，这些改动会被覆盖", "不用手动改索引，交给工作流");
}
if (infraFiles.length > 0 && coursewareDirs.size === 0) {
  add("info", "维护", infraFiles[0], `这是非课件改动（${infraFiles.length} 个文件），跳过课件检查`, "由维护者人工审阅");
}

for (const [root, parsed] of coursewareDirs) {
  if (!DIR_RE.test(parsed.dir)) {
    add("block", "结构", root, `目录名「${parsed.dir}」不符合 <课件名>(<作者>) 格式`, "用英文括号，名字里不要有空格");
  }

  const children = [...blobs.keys()].filter((p) => p.startsWith(`${root}/`));
  const rel = children.map((p) => p.slice(root.length + 1));
  const htmls = rel.filter((p) => !p.includes("/") && /\.html?$/i.test(p));
  if (htmls.length === 0) add("block", "文件", root, "没有 .html 文件，课件打不开", "至少放一个能打开的 HTML");
  if (!rel.includes("README.md")) add("block", "文件", root, "缺少 README.md", "补一份中文说明");
  if (!rel.includes("LICENSE")) add("block", "文件", root, "缺少 LICENSE", "补许可文件（推荐 MIT 或 CC BY-SA 4.0）");

  const readme = await readFile(`${root}/README.md`, headSha);
  if (readme) {
    if (!/[\u4e00-\u9fa5]/.test(readme)) add("warn", "README", `${root}/README.md`, "README 不是中文", "用中文写，读者主要是中学老师");
    if (!/对应知识点|知识点/.test(readme)) add("block", "README", `${root}/README.md`, "没写「对应知识点」", "补一行：初中/高中 · 主题 · 知识点");
    if (!/适用年级|年级/.test(readme)) add("warn", "README", `${root}/README.md`, "没写「适用年级」", "补上年级；高中写明必修/选择性必修/选修");
    if (!/作者/.test(readme)) add("block", "README", `${root}/README.md`, "没写作者", "补作者与版权信息");
    if (!/版权|Copyright/i.test(readme)) add("block", "README", `${root}/README.md`, "没写版权说明", "补版权说明，并与 LICENSE 一致");
    if (!/使用|操作|交互/.test(readme)) add("warn", "README", `${root}/README.md`, "没写使用方法/交互说明", "写清怎么操作");
    if (!/简化假设|假设/.test(readme)) add("warn", "README", `${root}/README.md`, "没写简化假设", "有简化就注明，比如忽略摩擦");
    if (!/素材|来源/.test(readme)) add("warn", "README", `${root}/README.md`, "没写素材来源", "外部图片/音频要注明来源和许可");
    if (/AI/i.test(readme) === false) {
      const htmlText = htmls.length ? await readFile(`${root}/${htmls[0]}`, headSha, 4000) : "";
      if (/AI|generated/i.test(htmlText)) {
        add("info", "README", `${root}/README.md`, "代码里出现 AI 生成痕迹，但 README 没写 AI 说明", "补一段「AI 辅助 + 已核对」");
      }
    }
  }

  const licenseText = await readFile(`${root}/LICENSE`, headSha, 20000);
  const fromFile = detectLicense(licenseText);
  if (licenseText && !fromFile) {
    add("block", "许可", `${root}/LICENSE`, "认不出许可证类型", "用 MIT / CC BY-SA 4.0 等标准许可");
  }
  if (/All rights reserved|版权所有[，,]?\s*翻版必究/i.test(`${readme}\n${licenseText}`)) {
    add("block", "许可", `${root}/LICENSE`, "声明为「保留所有权利」，不可再分发", "换成 MIT 或 CC BY-SA 4.0");
  }
  const fromReadme = detectLicense(readme);
  if (fromFile && fromReadme && fromFile !== fromReadme) {
    add("block", "许可", `${root}/README.md`, `README 写的是 ${fromReadme}，LICENSE 是 ${fromFile}`, "两处改成一致");
  }

  const htmlText = htmls.length ? await readFile(`${root}/${htmls[0]}`, headSha, 300000) : "";
  if (htmlText) {
    const interactive =
      /<input|<button|<canvas|addEventListener|onclick|oninput|pointerdown|mousedown|touchstart|drag/i.test(htmlText);
    if (!interactive) add("warn", "交互", `${root}/${htmls[0]}`, "没发现明显的交互元素", "至少支持拖动/调参/开关/暂停复位之一");
    if (/login|sign in|登录|注册|付费|订阅|subscribe/i.test(htmlText)) {
      add("warn", "可用性", `${root}/${htmls[0]}`, "页面里出现登录/付费相关文字", "确认没有登录或付费门槛");
    }
    if (/https?:\/\//i.test(htmlText)) add("info", "资源", `${root}/${htmls[0]}`, "引用了外部资源/CDN", "在 README 里说明依赖");
  }

  for (const p of children) {
    const size = blobs.get(p) || 0;
    if (size > MAX_SIZE) add("warn", "体积", p, `文件 ${(size / 1024 / 1024).toFixed(1)} MB，偏大`, "音视频建议压缩或提供说明");
  }
}

for (const f of changed) {
  if (BLACKLIST.some((re) => re.test(f.filename))) {
    add("block", "禁止文件", f.filename, "提交了不应入库的文件", "删掉 .git/依赖目录/临时文件/可执行文件");
  }
}

/* ---------------- 语义检查（可选） ---------------- */

let aiNote = "";
if (DEEPSEEK_KEY && coursewareDirs.size > 0) {
  try {
    const first = [...coursewareDirs.keys()][0];
    const readme = await readFile(`${first}/README.md`, headSha, 12000);
    const htmlName = [...blobs.keys()].find((p) => p.startsWith(`${first}/`) && /\.html?$/i.test(p));
    const html = htmlName ? await readFile(htmlName, headSha, 12000) : "";
    const license = await readFile(`${first}/LICENSE`, headSha, 3000);

    const prompt = [
      "你是初高中物理课件仓库的初审助手，只做提示，不做最终判定。",
      "请阅读 PR 描述、README、LICENSE 和 HTML 片段，找出：",
      "1) 物理表述疑点（公式、方向、单位、正负号、标注）；",
      "2) README 与课件描述不一致的地方；",
      "3) 版权/素材来源的可疑点。",
      "只输出 JSON 数组，每项 {level:'warn'|'info', category:'物理'|'一致性'|'版权', file:'相对路径', message:'问题', suggestion:'建议'}。",
      "没有发现问题就输出 []。不要输出其他文字。",
      "",
      `PR 标题：${pr.title}`,
      `PR 描述：${(pr.body || "").slice(0, 3000)}`,
      `课件目录：${first}`,
      "README：",
      readme || "（空）",
      "LICENSE 开头：",
      license || "（空）",
      "HTML 片段：",
      html || "（空）",
    ].join("\n");

    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: "你只输出合法 JSON 数组，不要 markdown 代码块。" },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const it of parsed.slice(0, 10)) {
          const level = it.level === "warn" ? "warn" : "info";
          add(level, it.category || "一致性", it.file || first, String(it.message || "").slice(0, 300), String(it.suggestion || "").slice(0, 300));
        }
      }
    } else {
      aiNote = `AI 语义检查未执行（接口 ${res.status}）`;
    }
  } catch (error) {
    aiNote = `AI 语义检查失败：${error.message}`;
  }
} else if (!DEEPSEEK_KEY) {
  aiNote = "未配置 DEEPSEEK_API_KEY，本次只跑脚本检查";
}

/* ---------------- 汇总与评论 ---------------- */

const order = { block: 0, warn: 1, info: 2 };
items.sort((a, b) => order[a.level] - order[b.level]);

const icon = { block: "🔴", warn: "🟡", info: "🔵" };
const label = { block: "必须改", warn: "建议改", info: "待人工" };
const counts = { block: 0, warn: 0, info: 0 };
for (const it of items) counts[it.level] += 1;

const lines = [];
lines.push(MARKER);
lines.push("## 🤖 AI 初审（只读，不合并）");
lines.push("");
lines.push(
  `**结论**：${counts.block} 项必须改 · ${counts.warn} 项建议 · ${counts.info} 项待人工` +
    (coursewareDirs.size === 0 ? "（未发现课件改动）" : `（涉及 ${coursewareDirs.size} 个课件目录）`),
);
lines.push("");

for (const level of ["block", "warn", "info"]) {
  const group = items.filter((i) => i.level === level);
  if (group.length === 0) continue;
  lines.push(`### ${icon[level]} ${label[level]}`);
  lines.push("");
  for (const it of group) {
    const where = it.file ? `\`${it.file}\` — ` : "";
    lines.push(`- **[${it.category}]** ${where}${it.message}${it.suggestion ? `\n  - 建议：${it.suggestion}` : ""}`);
  }
  lines.push("");
}

if (items.length === 0) {
  lines.push("脚本检查没有发现明显问题。");
  lines.push("");
}
if (aiNote) {
  lines.push(`> ${aiNote}`);
  lines.push("");
}

lines.push("---");
lines.push("> AI 初审只做初筛，不替代人工审校；它不会修改代码、不会 approve、也不会合并 PR。");
lines.push("> 物理正确性与版权归属请以教学审校/版权审校的意见为准。");

const body = lines.join("\n");

if (DRY_RUN) {
  console.log(body);
  process.exit(0);
}

const comments = await api(`/repos/${OWNER}/${NAME}/issues/${PR_NUMBER}/comments?per_page=100`);
const mine = comments.find((c) => c.user?.login === "github-actions[bot]" && (c.body || "").includes(MARKER));
if (mine) {
  await api(`/repos/${OWNER}/${NAME}/issues/comments/${mine.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  console.log("已更新初审评论");
} else {
  await api(`/repos/${OWNER}/${NAME}/issues/${PR_NUMBER}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  console.log("已发布初审评论");
}
