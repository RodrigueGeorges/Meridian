import { startSims } from './index.ts';

const sims = await startSims({
  stripePort: Number(process.env.SIM_STRIPE_PORT ?? 12111),
  secoursPort: Number(process.env.SIM_SECOURS_PORT ?? 12112),
  host: process.env.SIM_HOST ?? '0.0.0.0',
});
console.log(`Simulateur Stripe Terminal : ${sims.stripeUrl}`);
console.log(`Simulateur PSP secours     : ${sims.secoursUrl}`);
console.log('Pannes : POST /__faults {"dropResponse":{"process_payment_intent":1},"netDownUntil":<ms>,"declineNext":true}');
