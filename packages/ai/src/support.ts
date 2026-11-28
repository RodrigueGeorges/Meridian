// Assistant de support : explique un paiement en clair à partir de son journal signé.
// Les faits viennent du journal et d'un dictionnaire de codes ; le modèle ne fait que les formuler,
// sans rien ajouter. Sans modèle, l'explication factuelle est rendue telle quelle.
import type { Llm } from './llm.ts';

export interface JournalEntry { seq: number; ts: string; type: string; data: Record<string, unknown> }
export interface PaymentFacts { reference: string; state: string; detail?: string | null; amount: number; currency: string; module: string; refunded: number }

/** Sens des codes d'issue et ce qu'il faut faire, pour le caissier et le support de premier niveau. */
export const CODES: Record<string, { meaning: string; action: string }> = {
  card_declined: { meaning: 'La banque du client a refusé la carte.', action: 'Proposer un autre moyen de paiement ; rien n’a été débité.' },
  aborted: { meaning: 'Le paiement a été abandonné au terminal (client ou caissier).', action: 'Relancer un nouveau paiement si le client veut payer.' },
  psp_unreachable: { meaning: 'Le PSP n’a pas pu être joint avant tout envoi.', action: 'Rien n’a été débité. Réessayer, ou vérifier le PSP de secours de la caisse.' },
  terminal_busy: { meaning: 'Le terminal traitait déjà un paiement d’une autre caisse ; l’ordre n’a pas été pris.', action: 'Attendre la fin de l’autre paiement puis relancer ; rien n’a été débité.' },
  terminal_unreachable: { meaning: 'Le terminal ne répond pas sur le réseau du magasin ; rien n’a été envoyé.', action: 'Vérifier que le terminal est allumé et sur le bon réseau.' },
  terminal_not_received: { meaning: 'Le terminal confirme n’avoir jamais reçu la demande.', action: 'Rien n’a été débité ; relancer le paiement.' },
  terminal_link_lost: { meaning: 'La liaison avec le terminal a été perdue après l’envoi ; l’issue est en cours de vérification.', action: 'Ne pas relancer : Meridian redemande l’état au terminal et affichera l’issue réelle.' },
  terminal_in_progress: { meaning: 'Le terminal attend encore le client (carte, code).', action: 'Laisser le client terminer au terminal.' },
  terminal_mismatch: { meaning: 'Le terminal qui a répondu n’est pas celui déclaré pour cette caisse.', action: 'Vérifier l’adresse IP et l’identifiant du terminal dans la configuration.' },
  terminal_login_refused: { meaning: 'Le terminal a refusé d’ouvrir une session.', action: 'Redémarrer le terminal, puis vérifier sa configuration caisse.' },
  terminal_timeout: { meaning: 'Le terminal n’a pas répondu dans le délai.', action: 'Attendre la vérification automatique de l’issue avant toute nouvelle tentative.' },
  agent_restarted: { meaning: 'L’agent du magasin a redémarré pendant le paiement.', action: 'L’issue est redemandée au terminal ; ne pas relancer avant.' },
  cancel_too_late: { meaning: 'L’annulation est arrivée après l’autorisation : le paiement est passé.', action: 'Rembourser si le client ne doit pas payer.' },
  refund_unknown: { meaning: 'L’issue du remboursement est inconnue après une coupure.', action: 'Vérifier au terminal ou chez le PSP avant toute nouvelle demande.' },
};

const STATE_FR: Record<string, string> = { created: 'créé', pending: 'en cours', authorized: 'autorisé', declined: 'refusé', cancelled: 'annulé', failed: 'en échec' };
const money = (minor: number, cur: string) => `${(minor / 100).toFixed(2).replace('.', ',')} ${cur}`;

/** Faits vérifiables, dans l'ordre du journal. */
export function facts(view: PaymentFacts, journal: JournalEntry[]): string[] {
  const f: string[] = [`Paiement ${view.reference} de ${money(view.amount, view.currency)} via ${view.module} : état ${STATE_FR[view.state] ?? view.state}.`];
  let netErrors = 0;
  for (const e of journal) {
    const d = e.data ?? {};
    const at = new Date(e.ts).toISOString().slice(11, 19);
    if (e.type === 'created') f.push(`${at} : paiement enregistré dans le journal avant tout envoi au PSP.`);
    else if (e.type === 'step') f.push(`${at} : étape « ${String(d.step)} » confirmée par le PSP${d.via === 'lookup' ? ' (retrouvée par consultation après une coupure)' : ''}.`);
    else if (e.type === 'network_error') { netErrors++; f.push(`${at} : coupure réseau (${String(d.where ?? 'liaison PSP')}) ; la demande est rejouée avec la même clé, sans risque de double débit.`); }
    else if (e.type === 'recovered') f.push(`${at} : reprise après redémarrage, à partir de la dernière étape écrite.`);
    else if (e.type === 'fallback') f.push(`${at} : PSP principal injoignable avant tout envoi ; bascule vers le PSP de secours ${String(d.to)}.`);
    else if (e.type === 'cancel_requested') f.push(`${at} : annulation demandée${d.reason ? ` (${String(d.reason)})` : ''}.`);
    else if (e.type === 'cancel_refused') f.push(`${at} : annulation refusée par le PSP.`);
    else if (e.type === 'refund') f.push(`${at} : remboursement n° ${String(d.n)} de ${money(Number(d.amount), view.currency)}.`);
    else if (e.type === 'final') f.push(`${at} : issue définitive « ${STATE_FR[String(d.state)] ?? String(d.state)} »${d.detail ? `, code ${String(d.detail)}` : ''}.`);
  }
  if (netErrors) f.push(`${netErrors} coupure(s) pendant le paiement ; un seul ordre de paiement a été exécuté.`);
  if (view.refunded) f.push(`Montant remboursé : ${money(view.refunded, view.currency)}.`);
  const code = view.detail ? CODES[view.detail] : undefined;
  if (code) f.push(`Code ${view.detail} : ${code.meaning} À faire : ${code.action}`);
  else if (view.state === 'pending') f.push('Le paiement est en cours : ne pas relancer, l’issue réelle sera affichée dès qu’elle est connue.');
  return f;
}

const SYSTEM = `Tu es l'assistant de support de Meridian, connecteur de paiement entre caisses, terminaux et PSP.
Explique à un support de premier niveau (éditeur de caisse ou distributeur) ce qui est arrivé à un paiement, en 3 à 5 phrases simples, puis une ligne « À faire : … ».
Utilise uniquement les faits fournis : n'invente ni cause, ni montant, ni horaire. Si un fait manque, dis-le.
Ne promets jamais de remboursement et ne recommande jamais de relancer un paiement « en cours ».`;

export async function explainPayment(llm: Llm | undefined, view: PaymentFacts, journal: JournalEntry[], lang = 'fr'): Promise<{ facts: string[]; explanation: string; method: 'ai' | 'facts' }> {
  const list = facts(view, journal);
  if (!llm?.enabled) return { facts: list, explanation: list.join('\n'), method: 'facts' };
  const explanation = await llm.text('support', { system: `${SYSTEM}\nRéponds dans la langue « ${lang} ».`, user: `Faits du journal signé :\n- ${list.join('\n- ')}` });
  return { facts: list, explanation: explanation.trim(), method: 'ai' };
}
