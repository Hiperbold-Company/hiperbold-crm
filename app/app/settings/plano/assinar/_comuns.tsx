"use client";

/**
 * Peças que o passo a passo do plano (`_passo-a-passo.tsx`) e a compra de pacote (`_client.tsx`) dividem:
 * o valor em reais, o aceite dos Termos de Uso (D-133) e o formulário de quem paga (decisão 16, nunca
 * guardado no navegador). Saíram de `_client.tsx` sem mudar uma linha de comportamento (D-180). O formulário
 * pede nome, CPF/CNPJ, e-mail, celular e endereço completo (só o complemento é opcional) e chega já
 * preenchido com o que o CRM sabe da empresa e de quem está logado.
 */
import { Checkbox } from "@/components/ui/checkbox";
import Link from "next/link";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  erroDoDocumento,
  formatarDocumento,
  MENSAGEM_CNPJ_INVALIDO,
  MENSAGEM_CPF_INVALIDO,
} from "@/lib/documentos/cpf-cnpj";

import { formatarCep, type CamposDoFormularioDoPagador } from "../_logica-compra";

export function formatarReais(centavos: number, tagDoIdioma: string): string {
  return (centavos / 100).toLocaleString(tagDoIdioma, { style: "currency", currency: "BRL" });
}

/** D-133: o aceite obrigatório dos Termos de Uso, em cada fluxo de compra. */
export function AceiteDosTermos({ id, aceito, onChange }: { id: string; aceito: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        checked={aceito}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
        required
      />
      <span>
        {t("Li e aceito os")}{" "}
        <Link className="underline" href="/legal/terms" target="_blank" rel="noreferrer">
          {t("Termos de Uso")}
        </Link>
        .
      </span>
    </label>
  );
}

// ─── Formulário do pagador (decisão 16): nunca guardado no navegador ───────

export function FormularioDoPagador({
  pagador,
  onChange,
  idPrefixo,
}: {
  pagador: CamposDoFormularioDoPagador;
  onChange: (pagador: CamposDoFormularioDoPagador) => void;
  idPrefixo: string;
}) {
  const t = useT();
  // O erro de comprimento só aparece depois de a pessoa sair do campo; o de dígito verificador, assim
  // que o documento está completo (11 ou 14 dígitos).
  const [saiuDoDocumento, setSaiuDoDocumento] = useState(false);
  const erroDocumento = erroDoDocumento(pagador.documento, saiuDoDocumento);
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm font-medium">{t("Dados de quem paga")}</p>
      <p className="text-xs text-muted-foreground">
        {t("Só usados para emitir a cobrança no Asaas. Não ficam guardados neste sistema.")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("Já vem com os dados da empresa e do seu perfil. Confira e complete o que faltar.")}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-nome`}>{t("Nome ou razão social")}</Label>
        <Input
          id={`${idPrefixo}-nome`}
          value={pagador.nome}
          onChange={(e) => onChange({ ...pagador, nome: e.target.value })}
          maxLength={200}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-documento`}>{t("CPF ou CNPJ")}</Label>
        <Input
          id={`${idPrefixo}-documento`}
          value={pagador.documento}
          onChange={(e) => onChange({ ...pagador, documento: formatarDocumento(e.target.value) })}
          onBlur={() => setSaiuDoDocumento(true)}
          inputMode="numeric"
          placeholder="000.000.000-00"
          autoComplete="off"
          aria-invalid={erroDocumento !== null}
          aria-describedby={erroDocumento !== null ? `${idPrefixo}-documento-erro` : undefined}
          required
        />
        {erroDocumento !== null && (
          <p id={`${idPrefixo}-documento-erro`} className="text-xs text-destructive">
            {erroDocumento === MENSAGEM_CPF_INVALIDO
              ? t("CPF inválido")
              : erroDocumento === MENSAGEM_CNPJ_INVALIDO
                ? t("CNPJ inválido")
                : t("Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)")}
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <CampoDoPagador
          id={`${idPrefixo}-email`}
          rotulo={t("E-mail")}
          type="email"
          valor={pagador.email}
          onChange={(v) => onChange({ ...pagador, email: v })}
          maxLength={200}
          autoComplete="email"
        />
        <CampoDoPagador
          id={`${idPrefixo}-celular`}
          rotulo={t("Celular com DDD")}
          type="tel"
          inputMode="tel"
          placeholder="(11) 99999-9999"
          valor={pagador.celular}
          onChange={(v) => onChange({ ...pagador, celular: v })}
          maxLength={20}
          autoComplete="tel"
        />
      </div>

      <p className="pt-1 text-sm font-medium">{t("Endereço de quem paga")}</p>
      <div className="grid gap-3 sm:grid-cols-6">
        <CampoDoPagador
          className="sm:col-span-2"
          id={`${idPrefixo}-cep`}
          rotulo={t("CEP")}
          inputMode="numeric"
          placeholder="00000-000"
          valor={pagador.cep}
          onChange={(v) => onChange({ ...pagador, cep: formatarCep(v) })}
          maxLength={9}
          autoComplete="postal-code"
        />
        <CampoDoPagador
          className="sm:col-span-4"
          id={`${idPrefixo}-rua`}
          rotulo={t("Rua")}
          valor={pagador.rua}
          onChange={(v) => onChange({ ...pagador, rua: v })}
          maxLength={200}
          autoComplete="address-line1"
        />
        <CampoDoPagador
          className="sm:col-span-2"
          id={`${idPrefixo}-numero`}
          rotulo={t("Número")}
          valor={pagador.numero}
          onChange={(v) => onChange({ ...pagador, numero: v })}
          maxLength={20}
          autoComplete="off"
        />
        <CampoDoPagador
          className="sm:col-span-4"
          id={`${idPrefixo}-complemento`}
          rotulo={t("Complemento (opcional)")}
          valor={pagador.complemento}
          onChange={(v) => onChange({ ...pagador, complemento: v })}
          maxLength={200}
          autoComplete="address-line2"
          obrigatorio={false}
        />
        <CampoDoPagador
          className="sm:col-span-3"
          id={`${idPrefixo}-bairro`}
          rotulo={t("Bairro")}
          valor={pagador.bairro}
          onChange={(v) => onChange({ ...pagador, bairro: v })}
          maxLength={100}
          autoComplete="off"
        />
        <CampoDoPagador
          className="sm:col-span-2"
          id={`${idPrefixo}-cidade`}
          rotulo={t("Cidade")}
          valor={pagador.cidade}
          onChange={(v) => onChange({ ...pagador, cidade: v })}
          maxLength={100}
          autoComplete="address-level2"
        />
        <CampoDoPagador
          className="sm:col-span-1"
          id={`${idPrefixo}-uf`}
          rotulo={t("UF")}
          placeholder="SP"
          valor={pagador.uf}
          onChange={(v) => onChange({ ...pagador, uf: v.toUpperCase() })}
          maxLength={2}
          autoComplete="address-level1"
        />
      </div>
    </div>
  );
}

function CampoDoPagador({
  id,
  rotulo,
  valor,
  onChange,
  className,
  obrigatorio = true,
  ...resto
}: {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (valor: string) => void;
  className?: string;
  obrigatorio?: boolean;
  type?: string;
  inputMode?: "numeric" | "tel" | "email" | "text";
  placeholder?: string;
  maxLength: number;
  autoComplete: string;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{rotulo}</Label>
      <Input id={id} value={valor} onChange={(e) => onChange(e.target.value)} required={obrigatorio} {...resto} />
    </div>
  );
}
