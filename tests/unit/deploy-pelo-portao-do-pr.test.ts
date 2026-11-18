/**
 * O DEPLOY DO FORK HIPERBOLD TEM TRÊS CAMINHOS, E SÓ DOIS PULAM O RETESTE DA MAIN.
 *
 * Cabeçalho de `.github/workflows/deploy-easypanel.yml`:
 *   1. PR provado — merge commit de PR em dia com a main, ci+e2e verdes no head;
 *   2. rota urgente — rótulo `urgente`, nada em supabase/, ci+build verdes;
 *   3. o resto — espera ci+e2e da main (scripts/commit-passou-nos-testes.sh,
 *      vigiado por deploy-so-depois-dos-testes.test.ts).
 * E o alarme abre issue quando o reteste da main falha depois de o deploy sair.
 *
 * Os três scripts rodam DE VERDADE aqui, com um `gh` dublê no PATH que serve a
 * resposta de cada caminho da API a partir de um arquivo JSON e aplica o `--jq`
 * com o `jq` real: o que está sob teste é o filtro e a decisão. Escritas (`-X
 * POST`) ficam num log, para provar o que foi aberto ou comentado. Sem `jq` no
 * ambiente os casos de comportamento são pulados em voz alta.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PORTAO = path.join(RAIZ, "scripts/merge-ja-provado-no-pr.sh");
const ROTA = path.join(RAIZ, "scripts/pr-rota-urgente.sh");
const ALARME = path.join(RAIZ, "scripts/alarme-reteste-da-main.sh");
const REPO = "Hiperbold-Company/hiperbold-crm";

const MERGE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PAI1 = "c".repeat(40);

const temJq = spawnSync("jq", ["--version"]).status === 0;
const itComJq = temJq ? it : it.skip;

let pasta = "";

/** O nome do arquivo de resposta: método + caminho, com tudo que não é letra/dígito virando `_`. */
const chave = (metodo: string, caminho: string) =>
  `${metodo} ${caminho}`.replace(/[^A-Za-z0-9]/g, "_");

beforeAll(() => {
  pasta = mkdtempSync(path.join(tmpdir(), "portao-pr-"));
  mkdirSync(path.join(pasta, "bin"));
  const gh = `#!/usr/bin/env bash
caminho=""; filtro=""; metodo=GET; campos=""
while [ $# -gt 0 ]; do
  case "$1" in
    api|--paginate) ;;
    --jq) filtro="$2"; shift ;;
    -X) metodo="$2"; shift ;;
    -f) campos="$campos [$2]"; shift ;;
    *) [ -n "$caminho" ] || caminho="$1" ;;
  esac
  shift
done
printf '%s %s%s\\n' "$metodo" "$caminho" "$campos" >> "$GH_LOG"
arquivo="$GH_FIXTURES/$(printf '%s %s' "$metodo" "$caminho" | sed 's/[^A-Za-z0-9]/_/g').json"
if [ ! -f "$arquivo" ]; then
  if [ "$metodo" = "POST" ]; then arquivo="$GH_FIXTURES/post-padrao.json"; else exit 1; fi
fi
if [ -n "$filtro" ]; then jq -r "$filtro" "$arquivo"; else cat "$arquivo"; fi
`;
  const destino = path.join(pasta, "bin", "gh");
  writeFileSync(destino, gh);
  chmodSync(destino, 0o755);
});

afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

type Respostas = Record<string, unknown>;

function rodar(
  script: string,
  args: string[],
  respostas: Respostas,
  env: Record<string, string> = {},
) {
  const fixtures = mkdtempSync(path.join(pasta, "fx-"));
  writeFileSync(path.join(fixtures, "post-padrao.json"), JSON.stringify({ number: 99 }));
  for (const [k, v] of Object.entries(respostas)) {
    const [metodo, ...resto] = k.split(" ");
    writeFileSync(
      path.join(fixtures, `${chave(metodo!, resto.join(" "))}.json`),
      JSON.stringify(v),
    );
  }
  const log = path.join(fixtures, "chamadas.log");
  const r = spawnSync("bash", [script, ...args], {
    env: {
      ...process.env,
      PATH: `${path.join(pasta, "bin")}:${process.env.PATH}`,
      GH_FIXTURES: fixtures,
      GH_LOG: log,
      GITHUB_REPOSITORY: REPO,
      TETO_SEGUNDOS: "1",
      INTERVALO_SEGUNDOS: "1",
      ESPERA_RETENTATIVA: "0",
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  const chamadas = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}`, stdout: r.stdout, chamadas };
}

// ── cenário do portão ────────────────────────────────────────────────────────

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  urgente?: boolean;
}

const run = (id: number, status: string, conclusion: string | null, urgente = false): Run => ({
  id,
  status,
  conclusion,
  urgente,
});

interface Cenario {
  pulls?: unknown;
  pais?: string[];
  behindBy?: number;
  mainCi?: Run[];
  mainE2e?: Run[];
  prCi?: Run | null;
  prE2e?: Run | null;
  prPerf?: Run | null;
  rotulos?: string[];
  arquivos?: string[];
  semJobsDe?: number[];
  sem?: string[];
}

function respostasDoPortao(c: Cenario = {}): Respostas {
  const r: Respostas = {};
  const runs = (lista: Run[], evento: string) => ({
    workflow_runs: lista.map((x, i) => ({
      id: x.id,
      run_number: i + 1,
      event: evento,
      status: x.status,
      conclusion: x.conclusion,
    })),
  });
  r[`GET repos/${REPO}/commits/${MERGE}/pulls`] = c.pulls ?? [
    {
      number: 7,
      merge_commit_sha: MERGE,
      merged_at: "2026-11-18T10:00:00Z",
      base: { ref: "main" },
      head: { sha: HEAD },
    },
  ];
  r[`GET repos/${REPO}/commits/${MERGE}`] = {
    parents: (c.pais ?? [PAI1, HEAD]).map((sha) => ({ sha })),
  };
  r[`GET repos/${REPO}/compare/${PAI1}...${HEAD}`] = { behind_by: c.behindBy ?? 0 };
  const q = (wf: string, sha: string, evento: string) =>
    `GET repos/${REPO}/actions/workflows/${wf}/runs?head_sha=${sha}&event=${evento}&per_page=30`;
  r[q("ci.yml", MERGE, "push")] = runs(c.mainCi ?? [run(1, "in_progress", null)], "push");
  r[q("e2e.yml", MERGE, "push")] = runs(c.mainE2e ?? [run(2, "in_progress", null)], "push");
  const pr: [string, Run | null | undefined, Run][] = [
    ["ci.yml", c.prCi, run(101, "completed", "success")],
    ["e2e.yml", c.prE2e, run(102, "completed", "success")],
    ["perf.yml", c.prPerf, run(103, "completed", "success")],
  ];
  for (const [wf, dado, padrao] of pr) {
    const x = dado === undefined ? padrao : dado;
    r[q(wf, HEAD, "pull_request")] = runs(x ? [x] : [], "pull_request");
    if (x && !(c.semJobsDe ?? []).includes(x.id)) {
      r[`GET repos/${REPO}/actions/runs/${x.id}/jobs?filter=latest&per_page=100`] = {
        jobs: [
          {
            name: "agregador",
            steps: [
              { name: "Falhar se qualquer parte não passou", conclusion: "success" },
              {
                name: "Rota urgente: pulado de propósito",
                conclusion: x.urgente ? "success" : "skipped",
              },
            ],
          },
        ],
      };
    }
  }
  r[`GET repos/${REPO}/pulls/7`] = { labels: (c.rotulos ?? []).map((name) => ({ name })) };
  r[`GET repos/${REPO}/pulls/7/files?per_page=100`] = (c.arquivos ?? ["app/page.tsx"]).map(
    (filename) => ({
      filename,
    }),
  );
  for (const k of c.sem ?? []) delete r[k];
  return r;
}

const portao = (c: Cenario = {}) => rodar(PORTAO, [MERGE], respostasDoPortao(c));
const URGENTE = {
  prCi: run(101, "completed", "success", true),
  prE2e: run(102, "completed", "success", true),
};

describe("merge-ja-provado-no-pr.sh — caminho 1, PR provado", () => {
  itComJq("merge de PR em dia, ci e e2e verdes no head: libera sem esperar a main", () => {
    const r = portao();
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain("caminho completo");
  });

  itComJq("squash (1 pai) não passa pelo atalho", () => {
    const r = portao({ pais: [PAI1] });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("(b)");
  });

  itComJq("segundo pai diferente do head do PR: recusa", () => {
    const r = portao({ pais: [PAI1, "d".repeat(40)] });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("(b)");
  });

  itComJq("PR atrás da main no merge: o CI dele não mediu esta árvore", () => {
    const r = portao({ behindBy: 2 });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("(c)");
    expect(r.saida).toContain("2 commit(s) atrás");
  });

  itComJq("commit que não é merge de PR mesclado na main: recusa", () => {
    expect(portao({ pulls: [] }).codigo).toBe(1);
    const outraBase = portao({
      pulls: [
        {
          number: 7,
          merge_commit_sha: MERGE,
          merged_at: "x",
          base: { ref: "outra" },
          head: { sha: HEAD },
        },
      ],
    });
    expect(outraBase.codigo).toBe(1);
    expect(outraBase.saida).toContain("(a)");
    const naoMesclado = portao({
      pulls: [
        {
          number: 7,
          merge_commit_sha: MERGE,
          merged_at: null,
          base: { ref: "main" },
          head: { sha: HEAD },
        },
      ],
    });
    expect(naoMesclado.codigo).toBe(1);
  });

  itComJq("falha de API em qualquer condição vira 'não medido', nunca liberação", () => {
    for (const k of [
      `GET repos/${REPO}/commits/${MERGE}/pulls`,
      `GET repos/${REPO}/commits/${MERGE}`,
      `GET repos/${REPO}/compare/${PAI1}...${HEAD}`,
      `GET repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${MERGE}&event=push&per_page=30`,
      `GET repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=30`,
      `GET repos/${REPO}/actions/runs/101/jobs?filter=latest&per_page=100`,
    ]) {
      const r = portao({ sem: [k] });
      expect(r.codigo, `sem ${k}: ${r.saida}`).toBe(1);
      expect(r.saida).toContain("NÃO liberado");
    }
  });

  itComJq("o reteste da main já falhou: o atalho não vale", () => {
    const r = portao({ mainE2e: [run(2, "completed", "failure")] });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("(d)");
  });

  itComJq("ci do PR vermelho, ou ainda rodando: recusa", () => {
    expect(portao({ prCi: run(101, "completed", "failure") }).codigo).toBe(1);
    expect(portao({ prCi: run(101, "in_progress", null) }).codigo).toBe(1);
    expect(portao({ prCi: null }).codigo).toBe(1);
  });

  itComJq("e2e do PR ainda rodando e sem rótulo urgente: recusa e diz por quê", () => {
    const r = portao({ prE2e: run(102, "in_progress", null) });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("sem o rótulo urgente");
  });

  itComJq("ci verde que pulou a matriz pela rota urgente NÃO vale como caminho completo", () => {
    // O rótulo foi tirado depois do run: ci e e2e estão verdes, mas mediram menos.
    const r = portao({ ...URGENTE, rotulos: [] });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("(f)");
    // Misto: o e2e mediu, mas o ci pulou a matriz do test:db. Sem o rótulo, recusa.
    const misto = portao({ prCi: URGENTE.prCi, rotulos: [] });
    expect(misto.codigo, misto.saida).toBe(1);
  });
});

describe("merge-ja-provado-no-pr.sh — caminho 2, rota urgente", () => {
  itComJq("rótulo urgente, nada em supabase/, ci e build verdes: libera sem e2e", () => {
    const r = portao({ ...URGENTE, rotulos: ["urgente"] });
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain("rota urgente");
  });

  itComJq("rótulo urgente com o e2e do PR ainda rodando: libera sem esperar o e2e", () => {
    const r = portao({ prE2e: run(102, "in_progress", null), rotulos: ["urgente"] });
    expect(r.codigo, r.saida).toBe(0);
  });

  itComJq("rótulo urgente mas o PR mexe em supabase/: exige o caminho completo", () => {
    const r = portao({
      ...URGENTE,
      rotulos: ["urgente"],
      arquivos: ["app/x.ts", "supabase/migrations/1_0001_x.sql"],
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("supabase/");
  });

  itComJq("rota urgente sem o build (perf.yml) verde: recusa", () => {
    expect(
      portao({ ...URGENTE, rotulos: ["urgente"], prPerf: run(103, "completed", "failure") }).codigo,
    ).toBe(1);
    expect(portao({ ...URGENTE, rotulos: ["urgente"], prPerf: null }).codigo).toBe(1);
  });

  itComJq("e2e do PR que FALHOU não vira rota urgente", () => {
    const r = portao({ prE2e: run(102, "completed", "failure"), rotulos: ["urgente"] });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("falha real");
  });

  it("recusa sha malformado e falta de repositório, sem consultar nada", () => {
    expect(rodar(PORTAO, ["main; rm -rf /"], {}).codigo).toBe(2);
    expect(rodar(PORTAO, [MERGE], {}, { GITHUB_REPOSITORY: "" }).codigo).toBe(2);
  });
});

describe("pr-rota-urgente.sh", () => {
  const rota = (rotulos: string[] | null, arquivos: string[] | null) => {
    const r: Respostas = {};
    if (rotulos) r[`GET repos/${REPO}/pulls/7`] = { labels: rotulos.map((name) => ({ name })) };
    if (arquivos)
      r[`GET repos/${REPO}/pulls/7/files?per_page=100`] = arquivos.map((filename) => ({
        filename,
      }));
    return rodar(ROTA, ["7"], r);
  };

  itComJq("rótulo urgente e nada em supabase/: sim", () => {
    const r = rota(["bug", "urgente"], ["app/a.ts", "docs/supabase/nota.md"]);
    expect(r.stdout.trim(), r.saida).toBe("sim");
  });

  itComJq("sem o rótulo (ou com rótulo parecido): nao", () => {
    expect(rota([], ["app/a.ts"]).stdout.trim()).toBe("nao");
    expect(rota(["nao-urgente"], ["app/a.ts"]).stdout.trim()).toBe("nao");
  });

  itComJq("qualquer arquivo sob supabase/: nao", () => {
    expect(rota(["urgente"], ["app/a.ts", "supabase/baseline.sql"]).stdout.trim()).toBe("nao");
  });

  itComJq("falha ao ler rótulos ou arquivos, ou lista vazia: nao", () => {
    expect(rota(null, ["app/a.ts"]).stdout.trim()).toBe("nao");
    expect(rota(["urgente"], null).stdout.trim()).toBe("nao");
    expect(rota(["urgente"], []).stdout.trim()).toBe("nao");
  });

  it("recusa número de PR malformado", () => {
    expect(rodar(ROTA, ["7; rm -rf /"], {}).codigo).toBe(2);
  });
});

// ── alarme ──────────────────────────────────────────────────────────────────

const RUN_ID = "555";
const TITULO = `Reteste da main falhou depois do deploy: ${MERGE}`;

function respostasDoAlarme(opcoes: {
  jobs?: { name: string; conclusion: string; completed_at?: string }[] | null;
  /** Runs do mesmo workflow em push na main (para saber se este foi superado). */
  irmaos?: { id: number; created_at: string }[];
  deploys?: { display_title: string; status: string; conclusion: string | null }[];
  issues?: { number: number; title: string; pull_request?: unknown }[];
}): Respostas {
  const r: Respostas = {};
  if (opcoes.jobs !== null) {
    r[`GET repos/${REPO}/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`] = {
      jobs: opcoes.jobs ?? [
        { name: "e2e-parte (2)", conclusion: "failure" },
        { name: "e2e", conclusion: "failure" },
      ],
    };
  }
  r[`GET repos/${REPO}/actions/runs/${RUN_ID}`] = {
    workflow_id: 999,
    created_at: "2026-11-18T10:00:00Z",
  };
  r[`GET repos/${REPO}/actions/workflows/999/runs?branch=main&event=push&per_page=30`] = {
    workflow_runs: [
      { id: Number(RUN_ID), created_at: "2026-11-18T10:00:00Z" },
      ...(opcoes.irmaos ?? []),
    ],
  };
  r[`GET repos/${REPO}/actions/workflows/deploy-easypanel.yml/runs?per_page=50`] = {
    workflow_runs: opcoes.deploys ?? [
      { display_title: `Deploy ${MERGE}`, status: "completed", conclusion: "success" },
    ],
  };
  r[`GET repos/${REPO}/issues?state=open&per_page=100`] = opcoes.issues ?? [];
  return r;
}

const alarme = (opcoes: Parameters<typeof respostasDoAlarme>[0] = {}) =>
  rodar(ALARME, [], respostasDoAlarme(opcoes), {
    RUN_ID,
    SHA: MERGE,
    WORKFLOW_NOME: "e2e",
    RUN_URL: "https://github.com/x/actions/runs/555",
  });

const abriuIssue = (chamadas: string) =>
  chamadas.split("\n").some((l) => l.startsWith(`POST repos/${REPO}/issues `));
const comentou = (chamadas: string) => /^POST repos\/.+\/issues\/\d+\/comments/m.test(chamadas);

describe("alarme-reteste-da-main.sh", () => {
  itComJq("falha real depois do deploy: abre a issue com o sha no título e o link", () => {
    const r = alarme();
    expect(r.codigo, r.saida).toBe(0);
    expect(abriuIssue(r.chamadas), r.chamadas).toBe(true);
    expect(r.chamadas).toContain(`[title=${TITULO}]`);
    expect(r.chamadas).toContain("https://github.com/x/actions/runs/555");
  });

  const soCancelado = [
    { name: "verify-parte (1)", conclusion: "cancelled", completed_at: "2026-11-18T10:20:00Z" },
    { name: "verify", conclusion: "failure" },
    { name: "invariants", conclusion: "failure" },
  ];

  itComJq("run SUPERADO (push mais novo antes do cancelamento): não abre nada", () => {
    const r = alarme({
      jobs: soCancelado,
      irmaos: [{ id: 556, created_at: "2026-11-18T10:19:30Z" }],
    });
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain("run superado");
    expect(r.chamadas).not.toContain("POST");
  });

  itComJq(
    "cancelado SEM push mais novo é teto estourado (ou cancelamento manual): abre a issue",
    () => {
      // O timeout-minutes aparece como `cancelled` na API (run 37675215958 da main).
      // Push que chegou DEPOIS do cancelamento não explica o cancelamento.
      const r = alarme({
        jobs: soCancelado,
        irmaos: [{ id: 557, created_at: "2026-11-18T10:25:00Z" }],
      });
      expect(r.codigo, r.saida).toBe(0);
      expect(r.saida).toContain("teto estourado");
      expect(abriuIssue(r.chamadas)).toBe(true);
    },
  );

  itComJq("sem deploy concluído para o sha (o portão segurou): não abre nada", () => {
    const r = alarme({
      deploys: [
        { display_title: `Deploy ${"f".repeat(40)}`, status: "completed", conclusion: "success" },
        { display_title: `Deploy ${MERGE}`, status: "completed", conclusion: "failure" },
      ],
    });
    expect(r.codigo, r.saida).toBe(0);
    expect(r.chamadas).not.toContain("POST");
  });

  itComJq("issue já aberta para o mesmo sha: comenta, não duplica", () => {
    const r = alarme({ issues: [{ number: 42, title: TITULO }] });
    expect(r.codigo, r.saida).toBe(0);
    expect(abriuIssue(r.chamadas)).toBe(false);
    expect(comentou(r.chamadas)).toBe(true);
    expect(r.chamadas).toContain(`POST repos/${REPO}/issues/42/comments`);
  });

  itComJq("PR com o mesmo título não conta como issue aberta", () => {
    const r = alarme({ issues: [{ number: 43, title: TITULO, pull_request: { url: "x" } }] });
    expect(abriuIssue(r.chamadas), r.saida).toBe(true);
  });

  itComJq("deploy ainda andando depois do teto: reprova o run, sem issue no escuro", () => {
    const r = alarme({
      deploys: [{ display_title: `Deploy ${MERGE}`, status: "in_progress", conclusion: null }],
    });
    expect(r.codigo).toBe(1);
    expect(r.chamadas).not.toContain("POST");
  });

  itComJq("jobs ilegíveis contam como falha real (o alarme erra para o lado de avisar)", () => {
    const r = alarme({ jobs: null });
    expect(r.codigo, r.saida).toBe(0);
    expect(abriuIssue(r.chamadas)).toBe(true);
  });

  it("recusa entrada malformada", () => {
    expect(rodar(ALARME, [], {}, { RUN_ID: "x", SHA: MERGE }).codigo).toBe(2);
    expect(rodar(ALARME, [], {}, { RUN_ID, SHA: "main" }).codigo).toBe(2);
  });
});

// ── a ligação nos workflows ──────────────────────────────────────────────────

describe("os workflows chamam os scripts do jeito que os testes acima medem", () => {
  const ler = (f: string) => readFileSync(path.join(RAIZ, ".github/workflows", f), "utf8");
  const deploy = ler("deploy-easypanel.yml");

  it("deploy: portão pelo PR primeiro, reteste da main como queda, ambos antes do EasyPanel", () => {
    const novo = deploy.indexOf("bash scripts/merge-ja-provado-no-pr.sh");
    const antigo = deploy.indexOf("bash scripts/commit-passou-nos-testes.sh");
    const easypanel = deploy.indexOf("services.app.deployService");
    expect(novo).toBeGreaterThan(-1);
    expect(novo).toBeLessThan(antigo);
    expect(antigo).toBeLessThan(easypanel);
    expect(deploy).toMatch(/if bash scripts\/merge-ja-provado-no-pr\.sh "\$\{SHA\}"; then/);
  });

  it("deploy: o checkout esparso leva os três scripts, e o sha vai no nome do run (o alarme lê)", () => {
    for (const s of [
      "commit-passou-nos-testes.sh",
      "merge-ja-provado-no-pr.sh",
      "pr-rota-urgente.sh",
    ]) {
      expect(deploy).toContain(`scripts/${s}`);
    }
    expect(deploy).toMatch(
      /^run-name: Deploy \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}$/m,
    );
  });

  it("ci e e2e: a marca da rota urgente tem o nome que o portão procura", () => {
    for (const f of ["ci.yml", "e2e.yml"]) {
      expect(ler(f), f).toMatch(
        /- name: "Rota urgente: [^"]+"\n\s+if: github\.event_name == 'pull_request' && needs\.[a-z0-9-]+\.outputs\.urgente == 'sim'/,
      );
      expect(ler(f), f).toContain("bash scripts/pr-rota-urgente.sh");
    }
    expect(readFileSync(PORTAO, "utf8")).toContain('startswith("Rota urgente")');
  });

  it("alarme: escuta ci e e2e da main, e só tem issues: write de escrita", () => {
    const a = ler("alarme-reteste-da-main.yml");
    const semComentario = a
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(a).toContain('workflows: ["ci", "e2e"]');
    expect(a).toContain("branches: [main]");
    expect(a).toContain("bash scripts/alarme-reteste-da-main.sh");
    expect(semComentario.match(/^\s+[a-z-]+:\s*write\b/gm)).toEqual(["      issues: write"]);
    // Nomes de workflow que o alarme escuta têm de existir.
    expect(ler("ci.yml")).toMatch(/^name: ci$/m);
    expect(ler("e2e.yml")).toMatch(/^name: e2e$/m);
  });
});
