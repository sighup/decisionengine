import { describe, expect, it } from "vitest";
import { check } from "../src/core/check.js";
import { DecisionGraph } from "../src/core/graph.js";
import { fromMarkdownFile, toMarkdownFile } from "../src/core/markdown.js";
import { evaluate, manifestDetector } from "../src/core/rules.js";
import { normalizeKey, validateInput } from "../src/core/validate.js";
import { decision as d } from "./helpers.js";

describe("rules", () => {
  it("forbid_pattern respects decision scope and only checks added lines", () => {
    const x = d("DEC-001", { scope: ["src/auth/**"], rules: [{ type: "forbid_pattern", pattern: "jwt\\.sign" }] });
    const v = evaluate([x], [
      { path: "src/auth/a.ts", addedLines: [{ line: 3, text: "jwt.sign(x)" }] },
      { path: "src/other/b.ts", addedLines: [{ line: 1, text: "jwt.sign(x)" }] },
      { path: "src/auth/c.ts", content: "old jwt.sign\n", addedLines: [{ line: 2, text: "fine" }] },
    ]);
    expect(v.map((x) => `${x.path}:${x.line}`)).toEqual(["src/auth/a.ts:3"]);
  });

  it("honours de-allow comments", () => {
    const x = d("DEC-001", { rules: [{ type: "forbid_pattern", pattern: "console\\.log" }] });
    expect(evaluate([x], [{ path: "a.ts", content: "console.log(1) // de-allow DEC-001" }])).toHaveLength(0);
    expect(evaluate([x], [{ path: "a.ts", content: "console.log(1) // de-allow DEC-002" }])).toHaveLength(1);
  });

  it("ignores decisions that are not accepted", () => {
    expect(evaluate([d("DEC-001", { status: "proposed", rules: [{ type: "forbid_pattern", pattern: "x" }] })], [{ path: "a", content: "x" }])).toHaveLength(0);
  });

  it("require_pattern flags touched files that lack the pattern", () => {
    const x = d("DEC-001", { rules: [{ type: "require_pattern", pattern: "^// SPDX", flags: "m", paths: ["src/**/*.ts"] }] });
    const v = evaluate([x], [{ path: "src/a.ts", content: "// SPDX-License: MIT\nx" }, { path: "src/b.ts", content: "x" }, { path: "README.md", content: "x" }]);
    expect(v.map((x) => x.path)).toEqual(["src/b.ts"]);
  });

  it("forbid_path blocks writes but not deletes", () => {
    const x = d("DEC-001", { rules: [{ type: "forbid_path", paths: ["legacy/**"] }] });
    expect(evaluate([x], [{ path: "legacy/a.js", content: "" }])).toHaveLength(1);
    expect(evaluate([x], [{ path: "legacy/a.js", deleted: true }])).toHaveLength(0);
  });

  it("forbid_dependency understands common manifests", () => {
    const x = d("DEC-001", { rules: [{ type: "forbid_dependency", packages: ["jsonwebtoken", "PyJWT", "github.com/golang-jwt/jwt"] }] });
    const v = evaluate([x], [
      { path: "package.json", addedLines: [{ line: 5, text: '    "jsonwebtoken": "^9.0.0",' }] },
      { path: "web/package.json", addedLines: [{ line: 5, text: '    "jsonwebtoken-extra": "^1",' }] },
      { path: "requirements.txt", content: "flask==3\npyjwt>=2\n" },
      { path: "go.mod", addedLines: [{ line: 4, text: "\tgithub.com/golang-jwt/jwt/v5 v5.2.0" }] },
    ]);
    expect(v.map((x) => x.path)).toEqual(["package.json", "requirements.txt", "go.mod"]);
    expect(manifestDetector("package.json")!('  "name": "jsonwebtoken",', "name")).toBe(false);
  });

  it("check reports blast radius and downstream decisions at risk", () => {
    const ds = [
      d("DEC-001", { scope: ["src/auth/**"], rules: [{ type: "forbid_dependency", packages: ["jose"] }] }),
      d("DEC-002", { depends_on: ["DEC-001"], scope: ["src/auth/**"] }),
      d("DEC-003", { depends_on: ["DEC-002"] }),
    ];
    const r = check(ds, [{ path: "src/auth/a.ts", content: "x" }, { path: "package.json", addedLines: [{ line: 1, text: '"jose": "5"' }] }]);
    expect(r.violations).toHaveLength(1);
    expect(r.touched.sort()).toEqual(["DEC-001", "DEC-002"]);
    expect(r.atRisk.sort()).toEqual(["DEC-002", "DEC-003"]);
    expect(r.checked).toContain("DEC-001");
  });
});

describe("graph", () => {
  it("walks upstream and downstream and matches scopes", () => {
    const g = new DecisionGraph([d("DEC-001", { scope: ["src/auth/**"] }), d("DEC-002", { depends_on: ["DEC-001"] }), d("DEC-003", { depends_on: ["DEC-002"], status: "proposed" })]);
    expect(g.downstreamClosure(["DEC-001"]).sort()).toEqual(["DEC-002", "DEC-003"]);
    expect(g.upstreamClosure("DEC-003").sort()).toEqual(["DEC-001", "DEC-002"]);
    expect(g.governing("src/auth/x.ts").map((x) => x.id)).toEqual(["DEC-001", "DEC-002"]);
    expect(g.governing("lib/y.ts").map((x) => x.id)).toEqual(["DEC-002"]);
  });

  it("lints broken links, cycles, stale deps and rule conflicts", () => {
    const g = new DecisionGraph([
      d("DEC-001", { depends_on: ["DEC-002"] }),
      d("DEC-002", { depends_on: ["DEC-001"] }),
      d("DEC-003", { depends_on: ["DEC-404"] }),
      d("DEC-004", { status: "superseded", superseded_by: "DEC-005" }),
      d("DEC-005", { depends_on: ["DEC-004"] }),
      d("DEC-006", { rules: [{ type: "require_pattern", pattern: "use strict", paths: ["src/**"] }] }),
      d("DEC-007", { rules: [{ type: "forbid_pattern", pattern: "use strict", paths: ["src/legacy/**"] }] }),
    ]);
    const msgs = g.lint().map((i) => `${i.level} ${i.id} ${i.message}`);
    expect(msgs.some((m) => m.includes("dependency cycle"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("error DEC-003") && m.includes("DEC-404"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("warning DEC-005") && m.includes("superseded"))).toBe(true);
    expect(msgs.some((m) => m.includes("conflicts with DEC-007"))).toBe(true);
  });
});

describe("validation and export format", () => {
  it("normalises keys and input", () => {
    expect(normalizeKey("7")).toBe("DEC-007");
    expect(normalizeKey("dec-12")).toBe("DEC-012");
    expect(() => validateInput({ title: " " })).toThrow(/title/);
    expect(() => validateInput({ title: "x", rules: [{ type: "forbid_pattern", pattern: "(" }] })).toThrow(/bad regex/);
    expect(validateInput({ title: "x", rejected: ["A"], depends_on: ["3"] })).toMatchObject({ rejected: [{ option: "A" }], depends_on: ["DEC-003"] });
  });

  it("round-trips markdown export", () => {
    const f = toMarkdownFile(d("DEC-009", { title: "Sessions over JWTs", rejected: [{ option: "JWT", reason: "revocation" }], body: "Notes" }));
    expect(f.name).toBe("DEC-009-sessions-over-jwts.md");
    expect(fromMarkdownFile(f.content)).toMatchObject({ id: "DEC-009", title: "Sessions over JWTs", rejected: [{ option: "JWT", reason: "revocation" }], body: "Notes" });
  });
});
