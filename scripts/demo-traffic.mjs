// Sends real API calls through the SDK so the dashboard has something to show.
//
//   npm run build
//   STATUSLEAK_API_KEY=sl_sdk_... STATUSLEAK_ENDPOINT=http://localhost:3000 node scripts/demo-traffic.mjs [minutes]
//
// DEMO_INTERVAL_SEC sets the pause between rounds of 5 calls (default 3s, ~100 calls/min).
// For a run left going for days, use ~30s (~10 calls/min, ~430k/month — inside the Free plan's 1M).
//
// Healthy: GitHub, Kraken and Coinbase public endpoints (200).
// "Auth problem on your side": OpenAI and Stripe without a key (401).
// Stripe is called with node:https, the rest with fetch, to exercise both capture paths.
import https from 'node:https';
import { init, flush, shutdown } from '../dist/index.js';

const minutes = Number(process.argv[2] ?? 5);
const intervalMs = Math.max(1, Number(process.env.DEMO_INTERVAL_SEC ?? 3)) * 1000;
init({ service: process.env.STATUSLEAK_SERVICE ?? 'demo-app', environment: 'local', debug: true });

const FETCH_CALLS = [
    'https://api.github.com/rate_limit',
    'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    'https://api.openai.com/v1/models',
];

function stripeBalance() {
    return new Promise((resolve) => {
        https.get('https://api.stripe.com/v1/balance', (res) => {
            res.resume();
            res.on('end', resolve);
        }).on('error', resolve);
    });
}

const end = Date.now() + minutes * 60_000;
let rounds = 0;
while (Date.now() < end) {
    await Promise.all([
        ...FETCH_CALLS.map((url) => fetch(url, { headers: { 'User-Agent': 'statusleak-demo' } }).then((r) => r.text()).catch(() => undefined)),
        stripeBalance(),
    ]);
    rounds++;
    if (rounds % 20 === 0) {
        console.log(`[demo] ${rounds * 5} calls so far`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
}
await flush();
await shutdown();
console.log(`[demo] done: ${rounds * 5} calls`);
