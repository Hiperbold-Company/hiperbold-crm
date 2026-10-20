"use client";
import { useId, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Plus } from "@/lib/ui/icons";
import { useEtiquetasParaEscolher } from "@/hooks/contacts/useEtiquetasParaEscolher";
import { chaveDaEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { agruparOpcoes, paraBusca, type OpcaoDeEtiqueta } from "@/lib/tags/etiquetas-para-escolher";

interface Props {
  orgId: string;
  /** As etiquetas que o ALVO (contato, negócio) tem hoje. */
  value: string[];
  /** Recebe a lista inteira já alterada. Quem chama decide se grava na hora
   * (Inbox: contato) ou só entra no estado do formulário (ficha do negócio). */
  onChange: (next: string[]) => void;
  /** Teto de etiquetas do alvo (contato 20, negócio 50). */
  limite: number;
  /** Tamanho máximo de uma etiqueta (contato 40, negócio 60). */
  tamanhoMaximo: number;
  /** A forma em que o alvo GUARDA a etiqueta. Contato: minúscula (a rota a
   * normaliza de qualquer jeito); negócio: a grafia do cadastro, só aparada. É
   * também o que define "já tem": duas etiquetas são a mesma se a forma gravada
   * tem a mesma chave. */
  paraGravar: (tag: string) => string;
  /** Rótulo do campo de busca/criação (leitor de tela e testes). */
  rotuloDoCampo: string;
  disabled?: boolean;
  className?: string;
}

/**
 * O SELETOR DE ETIQUETAS DA EMPRESA — a lista que a organização cadastrou em
 * Configurações › Tags (a mesma fonte), agrupada pelo grupo, com cor, busca e
 * criação de etiqueta nova. Cada linha é uma caixa de marcar: marcada = o alvo
 * tem a etiqueta. Usado no Inbox (tags do contato, grava na hora) e na ficha do
 * negócio (tags do negócio, vai no "Salvar" do formulário).
 *
 * Não grava nada: devolve a lista nova em `onChange`.
 */
export function SeletorDeEtiquetas({
  orgId,
  value,
  onChange,
  limite,
  tamanhoMaximo,
  paraGravar,
  rotuloDoCampo,
  disabled = false,
  className,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const idDoGrupo = useId();
  const { data: vocabulario, isLoading, isError } = useEtiquetasParaEscolher(orgId);

  // A identidade de uma etiqueta é a chave da forma GRAVADA. Um alvo que já tem
  // "VIP" (gravado antes, em caixa mista) tem "vip": comparar texto cru deixaria
  // as duas e recriaria a duplicação que a lista veio impedir (#852, #1224).
  const chave = (tag: string) => chaveDaEtiqueta(paraGravar(tag));
  const chavesDoAlvo = new Set(value.map(chave));
  const noLimite = value.length >= limite;

  // O que o alvo JÁ tem e o vocabulário não conhece (digitada, importada) também
  // é uma caixa — marcada, em "Outras" —, senão não haveria como tirá-la daqui.
  const opcoes = useMemo<OpcaoDeEtiqueta[]>(() => {
    // Enquanto carrega, nada: mostrar as do alvo primeiro e reorganizar tudo
    // quando o vocabulário chega faria a lista pular debaixo do clique.
    if (isLoading) return [];
    const base = vocabulario ?? [];
    const conhecidas = new Set(base.map((o) => chaveDaEtiqueta(paraGravar(o.tag))));
    const extras: OpcaoDeEtiqueta[] = [];
    for (const tag of value) {
      const k = chaveDaEtiqueta(paraGravar(tag));
      if (!k || conhecidas.has(k)) continue;
      conhecidas.add(k);
      extras.push({ tag, cor: null, grupo: null });
    }
    return [...base, ...extras];
    // `paraGravar` é estável por contrato (função de módulo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabulario, value, isLoading]);

  const grupos = useMemo(() => agruparOpcoes(opcoes, draft), [opcoes, draft]);

  // "Já existe" ignora acento e caixa, a mesma régua da busca: quem digita
  // "indicacao" vê "Indicação" na lista, e oferecer criar "indicacao" ao lado dela
  // seria fabricar a quase-duplicata que esta lista veio evitar.
  const termo = paraBusca(draft);
  const igual = termo === "" ? undefined : opcoes.find((o) => paraBusca(o.tag) === termo);
  const podeCriar = paraGravar(draft) !== "" && !igual;

  function add(raw: string) {
    const tag = paraGravar(raw);
    if (!tag || chavesDoAlvo.has(chaveDaEtiqueta(tag)) || noLimite) return;
    onChange([...value, tag]);
    setDraft("");
  }

  function remove(raw: string) {
    const k = chave(raw);
    onChange(value.filter((v) => chave(v) !== k));
  }

  function alternar(opcao: OpcaoDeEtiqueta) {
    if (chavesDoAlvo.has(chave(opcao.tag))) remove(opcao.tag);
    else add(opcao.tag);
  }

  const vazio = !isLoading && opcoes.length === 0;

  return (
    <div className={className ?? "space-y-2"}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Dentro de um <form> o Enter enviaria o formulário inteiro.
            e.preventDefault();
            add(igual ? igual.tag : draft);
          }
        }}
        placeholder={t("Buscar ou criar tag…")}
        maxLength={tamanhoMaximo}
        disabled={disabled}
        className="h-7 text-xs"
        aria-label={rotuloDoCampo}
      />

      {podeCriar && (
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={disabled || noLimite}
          className="flex w-full items-center gap-1 rounded-sm border border-dashed border-border px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
        >
          <Plus size={12} weight="regular" aria-hidden />
          {t("Criar etiqueta")} “{draft.trim()}”
        </button>
      )}

      {noLimite && (
        <p className="text-[11px] text-muted-foreground">
          {t("Limite de {n} tags atingido. Desmarque uma para escolher outra.").replace("{n}", String(limite))}
        </p>
      )}

      {isLoading && <p className="text-xs text-muted-foreground">{t("Carregando etiquetas…")}</p>}
      {isError && (
        <p role="alert" className="text-xs text-destructive">
          {t("Não foi possível carregar as etiquetas da empresa.")}
        </p>
      )}
      {vazio && !isError && (
        <p className="text-xs text-muted-foreground">
          {t("Esta empresa ainda não tem etiquetas. Digite acima para criar a primeira.")}
        </p>
      )}
      {!isLoading && opcoes.length > 0 && grupos.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("Nenhuma etiqueta encontrada.")}</p>
      )}

      {grupos.length > 0 && (
        <div
          role="group"
          aria-label={t("Etiquetas da empresa")}
          className="max-h-56 space-y-2 overflow-y-auto pr-1"
        >
          {grupos.map(({ grupo, opcoes: doGrupo }, i) => {
            const titulo = grupo ?? t("Outras");
            const idTitulo = `${idDoGrupo}-${i}`;
            return (
              <div key={grupo ?? "__outras"} role="group" aria-labelledby={idTitulo}>
                <p
                  id={idTitulo}
                  className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {titulo}
                </p>
                <ul className="space-y-0.5">
                  {doGrupo.map((opcao) => {
                    const marcada = chavesDoAlvo.has(chave(opcao.tag));
                    return (
                      <li key={opcao.tag}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs hover:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                          <input
                            type="checkbox"
                            checked={marcada}
                            onChange={() => alternar(opcao)}
                            disabled={disabled || (!marcada && noLimite)}
                            className="size-3.5 shrink-0 accent-primary"
                          />
                          {opcao.cor && (
                            <span
                              data-ponto-da-etiqueta={opcao.tag}
                              aria-hidden
                              className="inline-block size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: opcao.cor }}
                            />
                          )}
                          <span className="min-w-0 truncate">{opcao.tag}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
