import "server-only";

/**
 * Validação de CPF/CNPJ por dígito verificador: fase F5, Tarefa 10.
 *
 * Usado no formulário da primeira compra (decisão 16: o documento só passa
 * pelo servidor a caminho do `POST /customers`, nunca fica em
 * `billing_customers`). Confere o dígito verificador ANTES de gastar uma
 * chamada de rede com um documento obviamente inválido. O Asaas também
 * valida do lado dele, mas devolver o erro sem sair do processo é mais rápido
 * e não arrisca vazar o CPF/CNPJ inválido num log de erro de rede.
 *
 * O algoritmo mora em `lib/documentos/cpf-cnpj.ts` (puro, o mesmo do formulário no navegador); aqui só
 * a porta `server-only` que o resto da cobrança já importa.
 */

export { cnpjValido, cpfValido, documentoValido } from "@/lib/documentos/cpf-cnpj";
