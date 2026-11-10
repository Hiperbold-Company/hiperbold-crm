"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useApagarSegredo,
  useCriarSegredo,
  useSegredos,
  useTrocarSegredo,
} from "@/hooks/automacoes/useSegredos";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { MASCARA } from "@/lib/automacoes/http";
import { NOME_DO_SEGREDO } from "@/lib/automacoes/segredos-nome";
import { Key } from "@/lib/ui/icons";

function mensagemDoErro(err: unknown, padrao: string): string {
  return err instanceof ApiError && err.message && err.message !== err.code ? err.message : padrao;
}

export function ChavesSecretas() {
  const t = useT();
  const { data, isLoading } = useSegredos();
  const criar = useCriarSegredo();
  const trocar = useTrocarSegredo();
  const apagar = useApagarSegredo();
  const [nome, setNome] = useState("");
  const [valor, setValor] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [trocando, setTrocando] = useState<string | null>(null);
  const [novoValor, setNovoValor] = useState("");
  const [erroDaLinha, setErroDaLinha] = useState<{ id: string; texto: string } | null>(null);
  const lista = data ?? [];
  const nomeValido = NOME_DO_SEGREDO.test(nome.trim());

  async function salvar() {
    setErro(null);
    try {
      await criar.mutateAsync({ nome: nome.trim(), valor });
      setNome("");
      setValor("");
    } catch (err) {
      setErro(mensagemDoErro(err, t("Não consegui gravar a chave.")));
    }
  }

  async function salvarTroca(id: string) {
    setErroDaLinha(null);
    try {
      await trocar.mutateAsync({ id, valor: novoValor });
      setTrocando(null);
      setNovoValor("");
    } catch (err) {
      setErroDaLinha({ id, texto: mensagemDoErro(err, t("Não consegui gravar a chave.")) });
    }
  }

  async function remover(id: string) {
    setErroDaLinha(null);
    try {
      await apagar.mutateAsync(id);
    } catch (err) {
      setErroDaLinha({ id, texto: mensagemDoErro(err, t("Não consegui apagar a chave.")) });
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card className="flex flex-col gap-4 p-5" data-testid="nova-chave">
        <h2 className="font-medium">{t("Nova chave")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="chave-nome">{t("Nome da chave")}</Label>
            <Input
              id="chave-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value.toLowerCase())}
              placeholder="token_meta"
              autoComplete="off"
            />
            <p className="text-xs text-text-muted">
              {t("Letras minúsculas, números e _ (ex.: token_meta).")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="chave-valor">{t("Chave (token)")}</Label>
            <Input
              id="chave-valor"
              type="password"
              value={valor}
              onChange={(e) => setValor(e.target.value.trim())}
              autoComplete="new-password"
            />
            <p className="text-xs text-text-muted">
              {t("Cole a chave inteira. Depois de salva, ela não aparece mais.")}
            </p>
          </div>
        </div>
        {erro && (
          <p className="text-sm text-error-fg" role="alert">
            {erro}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={salvar} disabled={!nomeValido || valor.length < 8 || criar.isPending}>
            {t("Salvar chave")}
          </Button>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">{t("Chaves salvas")}</h2>
        {isLoading ? (
          <p className="text-sm text-text-muted">{t("Carregando…")}</p>
        ) : lista.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <Key size={28} aria-hidden className="text-text-muted" />
            <p className="text-sm text-text-muted">{t("Nenhuma chave salva ainda.")}</p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="lista-de-chaves">
            {lista.map((s) => (
              <li key={s.id}>
                <Card className="flex flex-col gap-3 p-4" data-testid={`chave-${s.nome}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">{s.nome}</span>
                      <span
                        className="font-mono text-xs text-text-muted"
                        data-testid={`chave-${s.nome}-final`}
                      >
                        {MASCARA}
                        {s.ultimos4}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setTrocando(trocando === s.id ? null : s.id);
                          setNovoValor("");
                        }}
                      >
                        {t("Trocar valor")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remover(s.id)}
                        disabled={apagar.isPending}
                      >
                        {t("Apagar")}
                      </Button>
                    </div>
                  </div>
                  {trocando === s.id && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor={`trocar-${s.id}`}>{t("Novo valor da chave")}</Label>
                        <Input
                          id={`trocar-${s.id}`}
                          type="password"
                          value={novoValor}
                          onChange={(e) => setNovoValor(e.target.value.trim())}
                          autoComplete="new-password"
                        />
                      </div>
                      <Button
                        onClick={() => salvarTroca(s.id)}
                        disabled={novoValor.length < 8 || trocar.isPending}
                      >
                        {t("Salvar novo valor")}
                      </Button>
                    </div>
                  )}
                  {erroDaLinha?.id === s.id && (
                    <p className="text-sm text-error-fg" role="alert">
                      {erroDaLinha.texto}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-sm text-text-muted">
        <Link href="/app/automacoes" className="underline">
          {t("Voltar para Automações")}
        </Link>
      </p>
    </div>
  );
}
