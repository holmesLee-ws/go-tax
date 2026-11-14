#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 수치 없음(R2), 국내 근거·글로벌 비교 칸(R10),
// 출처 키·공식 도메인·조회일(R11), 경계 영역 허용 목록(R13), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const OPTIONAL = ["경계·연결"];
// 공식 기관 도메인(R11 정본). 하위 도메인 포함.
const OFFICIAL_DOMAINS = ["law.go.kr", "nts.go.kr", "hometax.go.kr", "wetax.go.kr", "tt.go.kr", "moef.go.kr", "q-net.or.kr", "oecd.org", "doi.org", "un.org", "europa.eu", "irs.gov", "uscode.house.gov", "nta.go.jp", "gov.uk", "assembly.go.kr", "lawmaking.go.kr"];
// 시리즈 영역(R13). 디스패처 브리프가 있는 영역 + go-develop.
const SERIES = ["go-develop", "go-accounting", "go-ai", "go-compliance-and-legal", "go-control", "go-data-analytics", "go-economics", "go-esg", "go-finance", "go-hr", "go-leadership-negotiation", "go-marketing", "go-mis", "go-operations", "go-product", "go-project-management", "go-sales", "go-scm", "go-security", "go-startup-agile", "go-strategy", "go-valuation"];
const STALE_DAYS = 395; // 13개월
const NO_COMPARE = /^비교 실익 적음 — .+/;

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const refs = new Set();
  const body = text.split(/^## 출처/m)[0];
  const blocks = body.split(/^### /m).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/^## /m)[0];
    const head = block.split("\n")[0];
    const m = head.match(/^([FCPSGX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) {
        if (!FIELDS.includes(f[1]) && !OPTIONAL.includes(f[1])) problems.push(`${id}: 모르는 칸 「${f[1]}」`);
        fields[f[1]] = f[2];
      }
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    for (const [name, v] of Object.entries(fields)) {
      for (const r of v.matchAll(/\[([KG]\d+)\]/g)) refs.add(r[1]);
      if (/%|퍼센트/.test(v) || /\d[\d,.]*\s*(원|만원|억원|억|조원)/.test(v)) problems.push(`${id}: 「${name}」에 세율·금액 표기 금지`);
      if (name === "경계·연결") {
        const names = v.match(/go-[a-z-]+/g) || [];
        if (!names.length) problems.push(`${id}: 경계·연결에 go-* 영역 없음`);
        for (const n of names) if (!SERIES.includes(n)) problems.push(`${id}: 시리즈에 없는 영역 ${n}`);
      }
    }
    if (fields["국내 근거"] && !/\[K\d+\]/.test(fields["국내 근거"])) problems.push(`${id}: 국내 근거에 출처 키 없음`);
    if (fields["글로벌 비교"] && !/\[G\d+\]/.test(fields["글로벌 비교"]) && !NO_COMPARE.test(fields["글로벌 비교"])) problems.push(`${id}: 글로벌 비교에 출처 키 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, problems, refs };
}

function checkSources(text, refs, today) {
  const problems = [], warnings = [];
  const section = text.split(/^## 출처/m)[1] || "";
  const defined = new Map();
  for (const line of section.split("\n")) {
    const m = line.match(/^- \[([KG]\d+)\] (.+)$/);
    if (!m) continue;
    if (defined.has(m[1])) problems.push(`출처 ${m[1]} 중복`);
    defined.set(m[1], m[2]);
    const urls = [...m[2].matchAll(/<(https?:\/\/[^>]+)>/g)].map((u) => u[1]);
    if (!urls.length) problems.push(`출처 ${m[1]}: URL 없음`);
    for (const u of urls) {
      let host = "";
      try { host = new URL(u).hostname; } catch { problems.push(`출처 ${m[1]}: URL 형식 오류`); continue; }
      if (!OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) problems.push(`출처 ${m[1]}: 공식 도메인 아님 ${host}`);
    }
    if (/원문 미확인|재확인 대기/.test(m[2])) warnings.push(`출처 ${m[1]}: 원문 미확인 표시 — 다시 확인`);
    const d = m[2].match(/조회일 (\d{4}-\d{2}-\d{2})/);
    if (!d) { problems.push(`출처 ${m[1]}: 조회일 없음`); continue; }
    const age = (today - new Date(`${d[1]}T00:00:00Z`)) / 86400000;
    if (Number.isNaN(age)) problems.push(`출처 ${m[1]}: 조회일 형식 오류`);
    else if (age > STALE_DAYS) warnings.push(`출처 ${m[1]}: 조회일 ${d[1]}이 13개월을 넘음 — 다시 확인`);
  }
  for (const r of refs) if (!defined.has(r)) problems.push(`없는 출처 키 [${r}]`);
  for (const k of defined.keys()) if (!refs.has(k)) warnings.push(`쓰지 않는 출처 [${k}]`);
  if (!/확인 기준일: \d{4}-\d{2}-\d{2}/.test(text)) problems.push("지도 머리에 확인 기준일 없음");
  return { problems, warnings };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const map = read("curriculum/map.md");
  const { modules, problems, refs } = parseCurriculum(map);
  errors.push(...problems);
  const src = checkSources(map, refs, new Date());
  errors.push(...src.problems);
  for (const w of src.warnings) console.warn(`WARN ${w}`);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 출처 키 ${refs.size}개, 파일 ${files.length}개 검사`);
}

main();
