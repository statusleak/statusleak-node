// Zero-config entry: `import '@statusleak/node/auto'` (or `node --import @statusleak/node/auto app.js`)
// starts the SDK from environment variables (STATUSLEAK_API_KEY, STATUSLEAK_SERVICE, …).
import { init } from './index';

init();
