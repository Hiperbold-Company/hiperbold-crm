"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { PreviaDaImportacao, TipoDeReferencia } from "@/lib/automacoes/portabilidade";
import { randomId } from "@/lib/random-id";

const SELECT = "h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm";
/** O mesmo teto da rota (512 KB): recusa na hora, sem subir o arquivo. */
const TETO_DO_ARQUIVO = 512 * 1024;

const ROTULO_DO_TIPO: Record<TipoDeReferencia, string> = {
  funil: "Funil",
  etapa: "Etapa",
  pessoa: "Pessoa da equipe",
  fonte: "Fonte de captação",
  canal: "Canal",
  segredo: "Chave secreta",
  automacao: "Automação",
  modelo: "Modelo de mensagem",
};

type Resposta<T> = { data?: T; error?: { message?: string; details?: { problemas?: string[] } } } | null;

/**
 * «Importar» uma automação de um arquivo `.automacao.json`: lê o arquivo, mostra
 * o que vai ser criado e, para cada referência (etapa, canal, pessoa…), a opção
 * desta conta — sugerida pelo nome, ou escolhida aqui. Cria um RASCUNHO desligado
 * e abre o editor. Arquivo com problema é recusado inteiro, com a lista do porquê.
 */
export function ImportarAutomacaoDialog({ aberto, onAberto }: { aberto: boolean; onAberto: (v: boolean) => void }) {
  const t = useT();
  const router = useRouter();
  const [arquivo, setArquivo] = useState<unknown>(null);
  const [previa, setPrevia] = useState<PreviaDaImportacao | null>(null);
  const [escolhas, setEscolhas] = useState<Record<string, string>>({});
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  // Uma chave por abertura do diálogo: o duplo clique não cria dois rascunhos.
  const [chave, setChave] = useState(() => randomId());

  const limpar = () => {
    setArquivo(null);
    setPrevia(null);
    setEscolhas({});
    setNome("");
    setErro(null);
    setProblemas([]);
    setChave(randomId());
  };

  const recusar = (corpo: Resposta<unknown>, padrao: string) => {
    setErro(corpo?.error?.message ?? padrao);
    setProblemas(corpo?.error?.details?.problemas ?? []);
  };

  const lerArquivo = async (file: File | undefined) => {
    limpar();
    if (!file) return;
    if (file.size > TETO_DO_ARQUIVO) {
      setErro(t("Arquivo grande demais para uma automação (máximo de 512 KB)."));
      return;
    }
    let conteudo: unknown;
    try {
      conteudo = JSON.parse(await file.text());
    } catch {
      setErro(t("Este arquivo não é um JSON. Escolha o arquivo .automacao.json que você exportou."));
      return;
    }
    setEnviando(true);
    try {
      const resp = await fetch("/api/v1/automacoes/importar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arquivo: conteudo, previa: true }),
      });
      const corpo = (await resp.json().catch(() => null)) as Resposta<PreviaDaImportacao>;
      if (!resp.ok || !corpo?.data) {
        recusar(corpo, t("Não consegui ler o arquivo. Tente de novo."));
        return;
      }
      setArquivo(conteudo);
      setPrevia(corpo.data);
      setNome(corpo.data.nome);
      setEscolhas(
        Object.fromEntries(corpo.data.referencias.flatMap((r) => (r.sugestao ? [[r.id, r.sugestao]] : []))),
      );
    } catch {
      setErro(t("Não consegui ler o arquivo. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  };

  const faltam = (previa?.referencias ?? []).filter((r) => !escolhas[r.id]);

  const criar = async () => {
    setErro(null);
    setProblemas([]);
    setEnviando(true);
    try {
      const resp = await fetch("/api/v1/automacoes/importar", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": chave },
        body: JSON.stringify({ arquivo, escolhas, ...(nome.trim() ? { nome: nome.trim() } : {}) }),
      });
      const corpo = (await resp.json().catch(() => null)) as Resposta<{ id: string }>;
      if (!resp.ok || !corpo?.data) {
        recusar(corpo, t("Não consegui importar a automação. Tente de novo."));
        return;
      }
      router.push(`/app/automacoes/${corpo.data.id}`);
    } catch {
      setErro(t("Não consegui importar a automação. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        if (!v) limpar();
        onAberto(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Importar automação")}</DialogTitle>
          <DialogDescription>
            {t("Escolha o arquivo .automacao.json. A automação nasce desligada, como rascunho: você confere no editor antes de publicar.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4" data-testid="importar-automacao">
          <div className="space-y-2">
            <Label htmlFor="arquivo-da-automacao">{t("Arquivo")}</Label>
            <Input
              id="arquivo-da-automacao"
              type="file"
              accept=".json,application/json"
              disabled={enviando}
              onChange={(e) => void lerArquivo(e.target.files?.[0])}
              data-testid="arquivo-da-automacao"
            />
          </div>

          {previa && (
            <>
              <div className="space-y-2">
                <Label htmlFor="nome-da-importada">{t("Nome")}</Label>
                <Input
                  id="nome-da-importada"
                  value={nome}
                  maxLength={80}
                  onChange={(e) => setNome(e.target.value)}
                  data-testid="nome-da-importada"
                />
              </div>
              <p className="text-sm text-text-muted" data-testid="resumo-da-importacao">
                {t("Vai criar")} {previa.caixas} {t("caixas")}
                {previa.gatilhos.length > 0 ? ` · ${previa.gatilhos.length} ${t("gatilhos")}` : ""}.
              </p>
              {previa.destinosHttp.length > 0 && (
                <div className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="destinos-http-da-importacao">
                  <p className="font-medium">{t("Esta automação chama outros sistemas. Confira os endereços antes de escolher as chaves:")}</p>
                  <ul className="space-y-1">
                    {previa.destinosHttp.map((d, i) => (
                      <li key={`${d.caixa}-${i}`} className="break-all">
                        <span className="font-mono text-xs">
                          {d.metodo} {d.url}
                        </span>
                        {d.chaves.length > 0 && (
                          <span className="block text-error-fg">
                            {t("Leva a chave secreta escolhida em")}:{" "}
                            {d.chaves.map((c) => previa.referencias.find((r) => r.id === c)?.nome ?? c).join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {previa.referencias.length > 0 && (
                <fieldset className="space-y-3" data-testid="referencias-da-importacao">
                  <legend className="text-sm font-medium">{t("O que corresponde nesta conta")}</legend>
                  {previa.referencias.map((r) => (
                    <div key={r.id} className="space-y-1">
                      <Label htmlFor={`ref-${r.id}`}>
                        {t(ROTULO_DO_TIPO[r.tipo])}: {r.nome ?? t("(apagado na conta de origem)")}
                      </Label>
                      {r.opcoes.length === 0 ? (
                        <p className="text-sm text-error-fg">
                          {t("Esta conta não tem nenhum item deste tipo. Crie um antes de importar.")}
                        </p>
                      ) : (
                        <select
                          id={`ref-${r.id}`}
                          className={SELECT}
                          value={escolhas[r.id] ?? ""}
                          onChange={(e) => setEscolhas((atual) => ({ ...atual, [r.id]: e.target.value }))}
                          data-testid={`ref-${r.id}`}
                        >
                          <option value="">{t("Escolha")}</option>
                          {r.opcoes.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.nome}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </fieldset>
              )}
            </>
          )}

          {erro && (
            <div role="alert" className="space-y-1 text-sm text-error-fg" data-testid="erro-da-importacao">
              <p>{erro}</p>
              {problemas.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs">
                  {problemas.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onAberto(false)} disabled={enviando}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={() => void criar()}
            disabled={enviando || !previa || faltam.length > 0 || !nome.trim()}
            data-testid="confirmar-importacao"
          >
            {enviando ? t("Importando…") : t("Criar rascunho")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
