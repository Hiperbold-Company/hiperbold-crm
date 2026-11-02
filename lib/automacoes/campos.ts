/**
 * Operação de campo — a parte PURA: dado o valor atual, o texto já renderizado
 * e o tipo do campo, qual valor gravar (ou por que não dá).
 *
 * A coerção segue o tipo declarado no funil (`CustomFieldDef.type`). Um valor
 * que não serve vira ERRO com o nome do campo, nunca um valor torto gravado: o
 * bloco sai por "Erro" e a execução mostra o motivo.
 */
import type { CustomFieldDef } from "@/lib/schemas/settings";

import type { FieldOp } from "./schemas";

export type Coercao = { ok: true; valor: unknown } | { ok: false; erro: string };

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function numero(texto: string): number | null {
  const limpo = texto.trim().replace(/\s/g, "");
  if (limpo === "") return null;
  // "1.234,56" (pt-BR) e "1234.56" são aceitos.
  const normal = /,\d{1,}$/.test(limpo) ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

/** AAAA-MM-DD a partir de "AAAA-MM-DD…" ou "DD/MM/AAAA". */
export function dataIso(texto: string): string | null {
  const t = texto.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const [a, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!a || !m || !d) return null;
  const data = new Date(`${a}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.getUTCDate() !== Number(d)) return null;
  return `${a}-${m}-${d}`;
}

/** Converte o texto para o tipo do campo. Sem definição (campo livre), grava o texto. */
export function coagirPeloTipo(def: Pick<CustomFieldDef, "type" | "options"> | null, texto: string): Coercao {
  const tipo = def?.type ?? "text";
  switch (tipo) {
    case "number": {
      const n = numero(texto);
      return n === null ? { ok: false, erro: "valor_invalido:numero" } : { ok: true, valor: n };
    }
    case "date": {
      const d = dataIso(texto);
      return d === null ? { ok: false, erro: "valor_invalido:data" } : { ok: true, valor: d };
    }
    case "boolean": {
      const t = texto.trim().toLocaleLowerCase("pt-BR");
      if (["sim", "s", "true", "1", "yes"].includes(t)) return { ok: true, valor: true };
      if (["não", "nao", "n", "false", "0", "no"].includes(t)) return { ok: true, valor: false };
      return { ok: false, erro: "valor_invalido:sim_ou_nao" };
    }
    case "email":
      return EMAIL_RX.test(texto.trim()) ? { ok: true, valor: texto.trim() } : { ok: false, erro: "valor_invalido:email" };
    case "phone": {
      const digitos = texto.replace(/\D/g, "");
      return digitos.length >= 8 && digitos.length <= 15
        ? { ok: true, valor: texto.trim() }
        : { ok: false, erro: "valor_invalido:telefone" };
    }
    case "select": {
      const opcoes = def?.options ?? [];
      const alvo = texto.trim().toLocaleLowerCase("pt-BR");
      const opcao = opcoes.find(
        (o) => o.value.toLocaleLowerCase("pt-BR") === alvo || o.label.toLocaleLowerCase("pt-BR") === alvo,
      );
      return opcao ? { ok: true, valor: opcao.value } : { ok: false, erro: "valor_invalido:opcao" };
    }
    case "multiselect": {
      const opcoes = def?.options ?? [];
      const partes = texto.split(",").map((p) => p.trim()).filter(Boolean);
      const valores: string[] = [];
      for (const p of partes) {
        const o = opcoes.find(
          (x) => x.value.toLocaleLowerCase("pt-BR") === p.toLocaleLowerCase("pt-BR") ||
            x.label.toLocaleLowerCase("pt-BR") === p.toLocaleLowerCase("pt-BR"),
        );
        if (!o) return { ok: false, erro: "valor_invalido:opcao" };
        valores.push(o.value);
      }
      return { ok: true, valor: valores };
    }
    default:
      return { ok: true, valor: texto };
  }
}

/**
 * O valor final de UMA operação: `set` coage o texto; `clear` apaga; `append`
 * acrescenta ao texto (ou à lista); `increment` soma ao número.
 */
export function aplicarOperacao(
  op: FieldOp["op"],
  atual: unknown,
  texto: string,
  def: Pick<CustomFieldDef, "type" | "options"> | null,
): Coercao {
  switch (op) {
    case "clear":
      return { ok: true, valor: null };
    case "set":
      return coagirPeloTipo(def, texto);
    case "append": {
      if (Array.isArray(atual)) {
        const novo = coagirPeloTipo(def?.type === "multiselect" ? def : null, texto);
        if (!novo.ok) return novo;
        const itens = Array.isArray(novo.valor) ? novo.valor : [novo.valor];
        return { ok: true, valor: [...atual, ...itens.filter((i) => !atual.includes(i))] };
      }
      if (def && def.type !== "text" && def.type !== "textarea" && def.type !== "url") {
        return { ok: false, erro: "valor_invalido:acrescentar_so_em_texto" };
      }
      const base = atual === null || atual === undefined ? "" : String(atual);
      return { ok: true, valor: base === "" ? texto : `${base} ${texto}` };
    }
    case "increment": {
      if (def && def.type !== "number") return { ok: false, erro: "valor_invalido:somar_so_em_numero" };
      const soma = numero(texto);
      if (soma === null) return { ok: false, erro: "valor_invalido:numero" };
      const base = atual === null || atual === undefined || atual === "" ? 0 : numero(String(atual));
      if (base === null) return { ok: false, erro: "valor_invalido:numero" };
      return { ok: true, valor: base + soma };
    }
  }
}
