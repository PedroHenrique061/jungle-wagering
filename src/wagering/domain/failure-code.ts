/**
 * Taxonomia estável de falhas, legível por máquina.
 * O provedor decide pelo código, não pela mensagem:
 *
 * | Código                        | Ação esperada do provedor                         |
 * | ----------------------------- | ------------------------------------------------- |
 * | INSUFFICIENT_FUNDS            | desistir da aposta (não reenviar)                 |
 * | REVERSAL_INSUFFICIENT_FUNDS   | escalar operacionalmente (reversão bloqueada)     |
 * | CURRENCY_MISMATCH             | corrigir payload                                  |
 * | WALLET_NOT_FOUND              | corrigir payload                                  |
 * | WALLET_PLAYER_MISMATCH        | corrigir payload                                  |
 * | REFERENCE_NOT_FOUND           | referência nunca chegou no prazo; reenviar ambas  |
 * | REFERENCE_MISMATCH            | corrigir payload                                  |
 * | REFERENCE_KIND_NOT_ALLOWED    | corrigir payload                                  |
 * | REFERENCE_NOT_PROCESSED       | desistir (referência foi rejeitada)               |
 * | REFERENCE_ALREADY_REVERSED    | desistir (já revertida)                           |
 * | REVERSAL_AMOUNT_MISMATCH      | corrigir payload                                  |
 * | INFRASTRUCTURE_PERMANENT      | auditoria/suporte (status FAILED)                 |
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  InfrastructurePermanent = "INFRASTRUCTURE_PERMANENT",
}
