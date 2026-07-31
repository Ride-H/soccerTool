// 要件トレーサビリティの検査 — 「約束」と「検証手段」の対応が切れていないかを見る。
//   実行: node rpdx/tools/trace.mjs          （NG 件数で終了）
//         node rpdx/tools/trace.mjs --md     （docs/REQUIREMENTS.md 用の表を出力）
//
// 検出するもの:
//   1. 検証手段が 1 つも無い要件（＝チェック漏れ）
//   2. 実在しないテスト名/ファイル/シナリオ/ツールを指している要件（改名・削除で腐った紐付け）
//   3. status と中身の不整合（held なのに checks が空 / open なのに plan が無い / waived に理由が無い）
// 検出しないもの:
//   テストが実際に通るかどうか（それは node --test の仕事）。ここは「見ている人が居るか」だけを見る。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REQUIREMENTS } from "../spec/requirements.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testDir = join(root, "rpdx", "test");

// テストファイルごとの「test(...) の第1引数の生ソース」を集める（"..." も `...${id}...` も同じ扱い）
const testNames = new Map();
for (const f of readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"))) {
  const src = readFileSync(join(testDir, f), "utf8");
  const names = [...src.matchAll(/\btest\(\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]);
  testNames.set(f, names);
}
const smokeSrc = existsSync(join(testDir, "visual", "smoke.mjs")) ? readFileSync(join(testDir, "visual", "smoke.mjs"), "utf8") : "";

const problems = [];
const ng = (req, msg) => problems.push(`${req.id}: ${msg}`);

const checkExists = (req, c) => {
  if (c.kind === "test") {
    const names = testNames.get(c.file);
    if (!names) return ng(req, `テストファイルが無い — ${c.file}`);
    if (c.name && !names.some((n) => n.includes(c.name))) return ng(req, `テストが見つからない — ${c.file} 「${c.name}」`);
    if (!c.name && names.length === 0) return ng(req, `テストが 1 本も無い — ${c.file}`);
  } else if (c.kind === "visual") {
    if (!smokeSrc.includes(c.scenario)) ng(req, `視覚シナリオが見つからない — ${c.scenario}`);
  } else if (c.kind === "tool") {
    // 検証手段はこのリポジトリの中で完結していること。外部（内部リポジトリや個人環境）を
    // 指すと、公開リポ単体の CI では必ず落ちる／黙って検証されなくなる。
    if (c.cmd.startsWith("/") || c.cmd.startsWith("..") || c.cmd.includes("character-lab"))
      return ng(req, `検証手段がリポジトリの外を指している — ${c.cmd}`);
    if (!existsSync(join(root, c.cmd))) ng(req, `ツールが見つからない — ${c.cmd}`);
  } else if (c.kind === "manual") {
    if (!c.why) ng(req, "manual には why（なぜ自動化できないか）が必要");
  } else {
    ng(req, `未知の検証手段 — ${c.kind}`);
  }
};

const ids = new Set();
for (const req of REQUIREMENTS) {
  if (ids.has(req.id)) ng(req, "ID が重複している");
  ids.add(req.id);
  if (!req.text || !req.source) ng(req, "text と source は必須");
  if (req.status === "held") {
    if (!req.checks || !req.checks.length) ng(req, "検証手段が無い（held なら 1 つ以上必要）");
    else req.checks.forEach((c) => checkExists(req, c));
  } else if (req.status === "open") {
    if (!req.plan) ng(req, "open なら plan（満たしたとき何で検証するか）が必要");
    else if (req.plan.kind !== "manual") checkExists(req, req.plan);
    if (!req.issue) ng(req, "open なら対応 Issue 番号が必要");
  } else if (req.status === "waived") {
    if (!req.why) ng(req, "waived なら why（なぜ検証しないか）が必要");
  } else {
    ng(req, `未知の status — ${req.status}`);
  }
}

const kindOf = (c) => (c.kind === "test" ? `${c.file}${c.name ? ` 「${c.name}」` : ""}`
  : c.kind === "visual" ? `視覚 ${c.scenario}` : c.kind === "tool" ? `ツール ${c.cmd}` : `目視（${c.why}）`);

if (process.argv.includes("--md")) {
  const rows = ["| ID | 区分 | 約束 | 状態 | 検証手段 |", "|---|---|---|---|---|"];
  for (const r of REQUIREMENTS) {
    const st = r.status === "held" ? "担保" : r.status === "open" ? `未充足（#${r.issue}）` : "対象外";
    const cs = (r.checks || (r.plan ? [r.plan] : [])).map(kindOf).join("<br>") || (r.why ?? "");
    rows.push(`| ${r.id} | ${r.area} | ${r.text} | ${st} | ${cs} |`);
  }
  console.log(rows.join("\n"));
  process.exit(0);
}

const by = (s) => REQUIREMENTS.filter((r) => r.status === s).length;
console.log(`要件 ${REQUIREMENTS.length} 件（担保 ${by("held")} / 未充足 ${by("open")} / 対象外 ${by("waived")}）`);
const held = REQUIREMENTS.filter((r) => r.status === "held");
const nChecks = held.reduce((s, r) => s + r.checks.length, 0);
console.log(`担保している要件の検証手段: ${nChecks} 件（テスト ${held.flatMap((r) => r.checks).filter((c) => c.kind === "test").length} / 視覚 ${held.flatMap((r) => r.checks).filter((c) => c.kind === "visual").length} / ツール ${held.flatMap((r) => r.checks).filter((c) => c.kind === "tool").length}）`);
for (const r of REQUIREMENTS.filter((r) => r.status === "open"))
  console.log(`  未充足: ${r.id} #${r.issue} — ${r.text}`);
if (problems.length) {
  console.log(`\n★ トレーサビリティ NG ${problems.length} 件`);
  for (const p of problems) console.log(`  ✖ ${p}`);
} else {
  console.log("\nトレーサビリティ OK（すべての要件に検証手段があり、紐付けも生きている）");
}
process.exit(problems.length);
