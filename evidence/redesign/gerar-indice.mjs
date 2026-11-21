// Gera evidence/redesign/README.md: o índice que cita cada captura do redesign.
// Imagem versionada sem documento que a cite reprova tests/unit/evidencia-citada.test.ts.
// Rode depois de acrescentar capturas: node evidence/redesign/gerar-indice.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const arquivos = execFileSync("git", ["ls-files", "-z", "--", "evidence/redesign/*.png"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .sort();

const porItem = new Map();
for (const f of arquivos) {
  const [, , item, estado] = f.split("/");
  if (!porItem.has(item)) porItem.set(item, new Map());
  const estados = porItem.get(item);
  if (!estados.has(estado)) estados.set(estado, []);
  estados.get(estado).push(f);
}

const ESTADO = {
  antes: "Antes (main, sem a mudança)",
  "depois-desligada": "Depois, com a chave desligada (tem de ser igual ao antes)",
  "depois-ligada": "Depois, com a chave ligada (visual novo)",
};

let md = `# Evidência do redesign

Capturas de cada item do redesign, que fica atrás da chave \`REDESIGN_HIPERBOLD\`.
Para cada tela há três estados: antes, depois com a chave desligada (que precisa ser
idêntico ao antes) e depois com a chave ligada. As capturas são feitas em pt-BR e en,
no desktop (1440px) e no celular (390px).

Arquivo gerado por \`node evidence/redesign/gerar-indice.mjs\`. Não edite à mão.
`;

for (const [item, estados] of porItem) {
  md += `\n## ${item}\n`;
  for (const [estado, lista] of estados) {
    md += `\n### ${ESTADO[estado] ?? estado}\n\n`;
    for (const f of lista) md += `- \`${f}\`\n`;
  }
}

writeFileSync("evidence/redesign/README.md", md);
console.log(`${arquivos.length} capturas em ${porItem.size} itens`);
