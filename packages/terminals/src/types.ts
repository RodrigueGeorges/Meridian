// Contrat commun des pilotes de terminaux : la caisse (ou l'agent Meridian) pilote un TPE du réseau local.
// Le TPE garde la carte, le PIN et la relation avec sa banque ou son PSP ; le pilote ne voit qu'un montant et une issue.

export type TerminalState = 'authorized' | 'declined' | 'cancelled' | 'unknown';

export interface TerminalResult {
  state: TerminalState;
  /** Motif du refus ou de l'incertitude (code du protocole). */
  detail?: string;
  brand?: string;
  last4?: string;
  /** Identifiant de l'opération côté terminal (n° de reçu ZVT, POITransactionID nexo, n° d'autorisation Caisse-AP). */
  terminalRef?: string;
}

export interface TerminalPay { reference: string; amount: number; currency: string }

export interface TerminalDriver {
  readonly protocol: 'caisse-ap' | 'zvt' | 'nexo';
  /** Lance un paiement et attend l'issue au terminal (présentation de la carte comprise). */
  pay(p: TerminalPay): Promise<TerminalResult>;
  /** Abandon du paiement en cours ; « unsupported » si le protocole ne le permet pas pendant l'autorisation. */
  cancel(reference: string): Promise<'sent' | 'unsupported'>;
  /** Remboursement d'une opération autorisée. */
  refund(p: { reference: string; amount: number; currency: string; terminalRef?: string; originalAmount: number }): Promise<'done' | 'refused'>;
  /** Le terminal répond-il ? */
  health(): Promise<boolean>;
}

/** Erreur de liaison avec le terminal : l'issue est inconnue si la demande a pu partir. */
export class LinkError extends Error {
  constructor(message: string, public readonly beforeSend: boolean, public readonly code?: string) {
    super(message);
  }
}
