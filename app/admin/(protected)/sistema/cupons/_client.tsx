"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { criarCupom, definirCupomAtivo, type CupomListado } from "@/app/actions/admin/cupons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";

/**
 * As ações da tela de cupons (migration 0955): ligam às ações de `app/actions/admin/cupons.ts`, que já fazem
 * o gate (`requirePlatformAdmin`, escopo `full`, MFA) e a auditoria. Aqui só se cuida da CONFIRMAÇÃO e do
 * feedback: a frase de erro vem pronta da ação (nunca o texto cru do Postgres) e vai direto ao toast e ao
 * aviso do formulário, sem passar por `t()`, no mesmo padrão de `../cobranca/_client.tsx`.
 */

type PlanoDoCatalogo = { code: string; name: string };

const CICLOS = ["monthly", "semiannual", "yearly"] as const;
type Ciclo = (typeof CICLOS)[number];

/** O fim do dia escolhido no horário de Brasília (o Brasil não tem horário de verão desde 2019). */
function fimDoDiaEmBrasilia(dataIso: string): string {
  return `${dataIso}T23:59:59-03:00`;
}

// ─── Lista ──────────────────────────────────────────────────────────────────

export function ListaDeCupons({ cupons, planos }: { cupons: CupomListado[]; planos: PlanoDoCatalogo[] }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();

  const nomeDoPlano = (code: string) => planos.find((p) => p.code === code)?.name ?? code;
  const rotuloDoCiclo: Record<Ciclo, string> = {
    monthly: t("Mensal"),
    semiannual: t("Semestral"),
    yearly: t("Anual"),
  };

  if (cupons.length === 0) {
    return <p className="text-sm text-text-muted">{t("Nenhum cupom cadastrado.")}</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Código")}</TableHead>
          <TableHead>{t("Desconto")}</TableHead>
          <TableHead>{t("Planos")}</TableHead>
          <TableHead>{t("Ciclos")}</TableHead>
          <TableHead>{t("Validade")}</TableHead>
          <TableHead>{t("Usos pagos")}</TableHead>
          <TableHead>{t("Ativo")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {cupons.map((c) => (
          <TableRow key={c.id} data-testid={`cupom-${c.codigo}`}>
            <TableCell>
              <span className="font-mono text-sm font-medium">{c.codigo}</span>
              {c.descricao && <span className="block text-xs text-text-muted">{c.descricao}</span>}
            </TableCell>
            <TableCell>{c.tipo === "percentual" ? `${c.valor}%` : formatCentsBRL(c.valor)}</TableCell>
            <TableCell>{c.planos.length === 0 ? t("Todos") : c.planos.map(nomeDoPlano).join(", ")}</TableCell>
            <TableCell>
              {c.ciclos.length === 0
                ? t("Todos")
                : c.ciclos.map((ciclo) => rotuloDoCiclo[ciclo as Ciclo] ?? ciclo).join(", ")}
            </TableCell>
            <TableCell>
              {c.valido_ate
                ? new Date(c.valido_ate).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" })
                : t("Sem validade")}
            </TableCell>
            <TableCell>
              {c.usos_pagos} / {c.max_usos === null ? t("sem limite") : c.max_usos}
              {c.usos_abertos > 0 && (
                <span className="block text-xs text-text-muted">
                  {c.usos_abertos} {t("em pedidos abertos")}
                </span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={c.ativo ? "success" : "neutral"}>{c.ativo ? t("Sim") : t("Não")}</Badge>
            </TableCell>
            <TableCell>
              <AlternarCupomAtivo cupomId={c.id} codigo={c.codigo} ativo={c.ativo} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Ativar e desativar (com confirmação) ───────────────────────────────────

export function AlternarCupomAtivo({ cupomId, codigo, ativo }: { cupomId: string; codigo: string; ativo: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pedindoConfirmacao, setPedindoConfirmacao] = useState(false);
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    iniciar(async () => {
      const r = await definirCupomAtivo({ cupomId, ativo: !ativo });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Cupom atualizado."));
      setPedindoConfirmacao(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid={`alternar-cupom-${codigo}`}
        variant="outline"
        size="sm"
        disabled={pendente}
        onClick={() => setPedindoConfirmacao(true)}
      >
        {ativo ? t("Desativar") : t("Ativar")}
      </Button>

      <AlertDialog open={pedindoConfirmacao} onOpenChange={setPedindoConfirmacao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ativo ? t("Desativar este cupom?") : t("Ativar este cupom?")} {codigo}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ativo
                ? t(
                    "Quem digitar este código passa a receber a mensagem de cupom inválido. Compras já pagas com ele não mudam.",
                  )
                : t("O código volta a valer na tela de assinar, dentro das regras de planos, ciclos, validade e limite de usos.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-alternar-cupom"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {ativo ? t("Desativar") : t("Ativar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Cupom novo ─────────────────────────────────────────────────────────────

export function FormularioDeNovoCupom({ planos }: { planos: PlanoDoCatalogo[] }) {
  const t = useT();
  const router = useRouter();
  const [codigo, setCodigo] = useState("");
  const [tipo, setTipo] = useState<"percentual" | "valor">("percentual");
  const [valor, setValor] = useState("");
  const [descricao, setDescricao] = useState("");
  const [planosEscolhidos, setPlanosEscolhidos] = useState<string[]>([]);
  const [ciclosEscolhidos, setCiclosEscolhidos] = useState<Ciclo[]>([]);
  const [validade, setValidade] = useState("");
  const [limite, setLimite] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [criando, iniciar] = useTransition();

  const rotuloDoCiclo: Record<Ciclo, string> = {
    monthly: t("Mensal"),
    semiannual: t("Semestral"),
    yearly: t("Anual"),
  };

  function alternar<T>(lista: T[], item: T): T[] {
    return lista.includes(item) ? lista.filter((x) => x !== item) : [...lista, item];
  }

  function falhar(mensagem: string) {
    setErro(mensagem);
    toast.error(mensagem);
  }

  function criar() {
    setErro(null);
    const codigoLimpo = codigo.trim();
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(codigoLimpo)) {
      falhar(t("Código inválido. Use letras, números, hífen e sublinhado, de 3 a 40 caracteres."));
      return;
    }

    let valorFinal: number;
    if (tipo === "percentual") {
      valorFinal = Number(valor.trim());
      if (!Number.isInteger(valorFinal) || valorFinal < 1 || valorFinal > 99) {
        falhar(t("Valor inválido. No percentual, de 1 a 99; em valor fixo, mais que zero."));
        return;
      }
    } else {
      const centavos = parseReaisToCents(valor);
      if (centavos === null || centavos <= 0) {
        falhar(t("Valor inválido. No percentual, de 1 a 99; em valor fixo, mais que zero."));
        return;
      }
      valorFinal = centavos;
    }

    let maxUsos: number | null = null;
    if (limite.trim() !== "") {
      maxUsos = Number(limite.trim());
      if (!Number.isInteger(maxUsos) || maxUsos < 1) {
        falhar(t("O limite de usos precisa ser pelo menos 1."));
        return;
      }
    }

    iniciar(async () => {
      const r = await criarCupom({
        codigo: codigoLimpo,
        tipo,
        valor: valorFinal,
        planos: planosEscolhidos,
        ciclos: ciclosEscolhidos,
        validoAte: validade ? fimDoDiaEmBrasilia(validade) : null,
        maxUsos,
        ...(descricao.trim() ? { descricao: descricao.trim() } : {}),
      });
      if (!r.ok) {
        falhar(r.error);
        return;
      }
      toast.success(t("Cupom criado."));
      setCodigo("");
      setValor("");
      setDescricao("");
      setPlanosEscolhidos([]);
      setCiclosEscolhidos([]);
      setValidade("");
      setLimite("");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Novo cupom")}</CardTitle>
        <CardDescription>
          {t("Sem plano ou ciclo marcado, o cupom vale para todos. O código não diferencia maiúsculas de minúsculas.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cupom-codigo">{t("Código")}</Label>
            <Input
              id="cupom-codigo"
              className="w-48"
              maxLength={40}
              autoComplete="off"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              disabled={criando}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cupom-tipo">{t("Tipo de desconto")}</Label>
            <select
              id="cupom-tipo"
              value={tipo}
              onChange={(e) => {
                setTipo(e.target.value as "percentual" | "valor");
                setValor("");
              }}
              disabled={criando}
              className="h-10 w-48 rounded-sm border border-border bg-bg px-3 text-sm text-text"
            >
              <option value="percentual">{t("Porcentagem (%)")}</option>
              <option value="valor">{t("Valor fixo (R$)")}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cupom-valor">{tipo === "percentual" ? t("Porcentagem (de 1 a 99)") : t("Valor em reais")}</Label>
            <Input
              id="cupom-valor"
              className="w-40"
              inputMode={tipo === "percentual" ? "numeric" : "decimal"}
              placeholder={tipo === "percentual" ? "10" : "50,00"}
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              disabled={criando}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cupom-descricao">{t("Descrição (opcional)")}</Label>
          <Input
            id="cupom-descricao"
            className="max-w-xl"
            maxLength={200}
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            disabled={criando}
          />
        </div>

        <fieldset className="space-y-1.5" data-testid="cupom-planos">
          <legend className="text-sm font-medium">{t("Planos permitidos")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {planos.map((p) => (
              <label key={p.code} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={planosEscolhidos.includes(p.code)}
                  onChange={() => setPlanosEscolhidos((atual) => alternar(atual, p.code))}
                  disabled={criando}
                />
                {p.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-text-muted">{t("Nenhum marcado: vale para todos os planos.")}</p>
        </fieldset>

        <fieldset className="space-y-1.5" data-testid="cupom-ciclos">
          <legend className="text-sm font-medium">{t("Ciclos permitidos")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {CICLOS.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ciclosEscolhidos.includes(c)}
                  onChange={() => setCiclosEscolhidos((atual) => alternar(atual, c))}
                  disabled={criando}
                />
                {rotuloDoCiclo[c]}
              </label>
            ))}
          </div>
          <p className="text-xs text-text-muted">{t("Nenhum marcado: vale para todos os ciclos.")}</p>
        </fieldset>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cupom-validade">{t("Válido até (opcional)")}</Label>
            <Input
              id="cupom-validade"
              type="date"
              className="w-48"
              value={validade}
              onChange={(e) => setValidade(e.target.value)}
              disabled={criando}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cupom-limite">{t("Limite de usos (opcional)")}</Label>
            <Input
              id="cupom-limite"
              className="w-40"
              inputMode="numeric"
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
              disabled={criando}
            />
          </div>
          <Button data-testid="criar-cupom" onClick={criar} disabled={criando}>
            {criando ? t("Criando...") : t("Criar cupom")}
          </Button>
        </div>

        {erro && (
          <p role="alert" data-testid="cupom-erro" className="text-sm text-destructive">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
