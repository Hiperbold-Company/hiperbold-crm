/**
 * O link da cobrança no Asaas para quem trata o pedido de reembolso. Usa o `invoice_url` do pedido quando ele é
 * um endereço do Asaas (https, domínio do Asaas); sem ele, monta `https://www.asaas.com/i/<id sem o pay_>` (ou o
 * domínio do sandbox). Sem id válido, não há link.
 */
const FATURA_DO_ASAAS = /^https:\/\/(www\.|sandbox\.)?asaas\.com\//;

export function linkDaCobrancaNoAsaas(args: {
  asaasPaymentId: string;
  invoiceUrl?: string | null;
  ambiente?: "sandbox" | "producao" | null;
}): string | null {
  if (args.invoiceUrl && FATURA_DO_ASAAS.test(args.invoiceUrl)) return args.invoiceUrl;
  const id = args.asaasPaymentId.replace(/^pay_/, "");
  if (!/^[A-Za-z0-9]{4,64}$/.test(id)) return null;
  const dominio = args.ambiente === "sandbox" ? "sandbox.asaas.com" : "www.asaas.com";
  return `https://${dominio}/i/${id}`;
}
