import { generateVapidKeys } from './web-push-crypto';

// npm run vapid:keys: a new VAPID key pair for sample.env. Generate it once
// per deployment and keep it: every browser subscription is bound to the
// public key, and a new pair makes every existing subscription fail.
const keys = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
