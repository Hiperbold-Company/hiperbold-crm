"use client";

/**
 * Campo "Conexão" dos blocos Mensagem e Pergunta (régua DataCrazy): por qual
 * conexão o bloco envia. Em branco = "a conexão dos blocos anteriores" (a que
 * um bloco anterior escolheu; sem nenhuma, a regra de sempre). A lista é a
 * mesma do gatilho "Por quais números" (`useChannelSessions`).
 *
 * "Substituir em todos os blocos" troca a conexão de todos os blocos que usam a
 * atual (e dos gatilhos "Mensagem recebida" que a citam) — só no rascunho; quem
 * aplica é o canvas, dono do grafo (`substituirConexao`).
 */
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
import { Label } from "@/components/ui/label";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { transportaMensagem } from "@/lib/channels/capabilities";

import { Campo, Seletor, type Opcao } from "./comum";

/** O que o canvas oferece para a troca em todos os blocos. */
export interface SubstituicaoDeConexao {
  /** Quantos blocos usam a conexão (`null` = os em branco). */
  contar: (atual: string | null) => number;
  aplicar: (atual: string | null, nova: string) => void;
}

export function CampoDaConexao({
  prefixo,
  valor,
  onChange,
  substituir,
}: {
  prefixo: string;
  valor: string | undefined;
  onChange: (conexao: string | undefined) => void;
  substituir?: SubstituicaoDeConexao;
}) {
  const t = useT();
  const canais = useChannelSessions();
  const [aberto, setAberto] = useState(false);
  const [nova, setNova] = useState("");

  // Só conexão que transporta mensagem: a lista traz também as que não conversam.
  const lista = (canais.data ?? []).filter((c) => transportaMensagem(c.provider));
  const opcoes: Opcao[] = lista.map((c) => ({ valor: c.id, rotulo: channelLabel(c, t) }));
  // A conexão salva que não está mais na lista aparece, para poder ser trocada.
  if (valor && !lista.some((c) => c.id === valor)) {
    opcoes.push({ valor, rotulo: t("Conexão não encontrada") });
  }
  const atual = valor ?? null;
  const nomeDaAtual = valor
    ? (opcoes.find((o) => o.valor === valor)?.rotulo ?? t("Conexão não encontrada"))
    : t("Conexões dos blocos anteriores");
  const quantos = substituir ? substituir.contar(atual) : 0;
  const opcoesDaNova = opcoes.filter((o) => o.valor !== valor);

  return (
    <div className="space-y-1.5" data-testid={`${prefixo}-conexao-campo`}>
      <Campo
        id={`${prefixo}-conexao`}
        rotulo={t("Conexão")}
        ajuda={t("Deixe em branco para usar a conexão dos blocos anteriores.")}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Seletor
              id={`${prefixo}-conexao`}
              valor={valor ?? ""}
              vazio={t("Usar a conexão dos blocos anteriores")}
              opcoes={opcoes}
              onChange={(v) => onChange(v || undefined)}
            />
          </div>
          {substituir && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${prefixo}-conexao-substituir`}
              onClick={() => {
                setNova("");
                setAberto(true);
              }}
            >
              {t("Substituir em todos os blocos")}
            </Button>
          )}
        </div>
      </Campo>
      {canais.isError && (
        <p className="text-xs text-error-fg">{t("Não foi possível carregar as conexões.")}</p>
      )}

      {substituir && (
        <Dialog open={aberto} onOpenChange={setAberto}>
          <DialogContent data-testid={`${prefixo}-conexao-dialogo`}>
            <DialogHeader>
              <DialogTitle>{t("Substituir conexão em todos os blocos")}</DialogTitle>
              <DialogDescription>
                {t("A troca vale para o rascunho: salve e publique para ela valer nas execuções.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>{t("Conexão atual")}</Label>
                <p className="text-sm text-text" data-testid={`${prefixo}-conexao-atual`}>
                  {nomeDaAtual}
                </p>
              </div>
              <Campo id={`${prefixo}-conexao-nova`} rotulo={t("Nova conexão")}>
                <Seletor
                  id={`${prefixo}-conexao-nova`}
                  valor={nova}
                  vazio={t("Escolha a conexão")}
                  opcoes={opcoesDaNova}
                  onChange={setNova}
                />
              </Campo>
              <p className="text-xs text-text-muted" data-testid={`${prefixo}-conexao-quantos`}>
                {quantos}{" "}
                {quantos === 1 ? t("bloco será atualizado") : t("blocos serão atualizados")}
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                data-testid={`${prefixo}-conexao-substituir-todas`}
                disabled={!nova || quantos === 0}
                onClick={() => {
                  substituir.aplicar(atual, nova);
                  setAberto(false);
                }}
              >
                {t("Substituir todas")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
