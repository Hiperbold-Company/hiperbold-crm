/**
 * Cargo e empresa de quem está no card do funil.
 *
 * Não são colunas: `contacts` não tem `job_title` nem `company`. O dado mora em
 * `custom_fields` sob a chave `cargo` / `empresa` — a captação (formulário,
 * Lead Ads, importação) grava assim e `encaixarCamposNoFunil` leva o rótulo
 * digitado ("Empresa", "Cargo / Posição") para essas chaves. Vem do CONTATO
 * quando ele tem; se não tem, vale o que o formulário gravou no NEGÓCIO, que é
 * onde a CBEXS os recebe. Só texto: número ou objeto solto não vira "cargo".
 */
export interface CargoEEmpresa {
  cargo: string | null;
  empresa: string | null;
}

const CHAVES_DE_CARGO = ["cargo", "job_title"];
const CHAVES_DE_EMPRESA = ["empresa", "company", "company_name"];

function normalizar(chave: string): string {
  return chave
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function ler(campos: Record<string, unknown> | null | undefined, chaves: string[]): string | null {
  if (!campos) return null;
  for (const [chave, valor] of Object.entries(campos)) {
    if (!chaves.includes(normalizar(chave))) continue;
    if (typeof valor !== "string") continue;
    const texto = valor.trim();
    if (texto) return texto;
  }
  return null;
}

export function cargoEEmpresa(
  doContato: Record<string, unknown> | null | undefined,
  doNegocio?: Record<string, unknown> | null,
): CargoEEmpresa {
  return {
    cargo: ler(doContato, CHAVES_DE_CARGO) ?? ler(doNegocio, CHAVES_DE_CARGO),
    empresa: ler(doContato, CHAVES_DE_EMPRESA) ?? ler(doNegocio, CHAVES_DE_EMPRESA),
  };
}
