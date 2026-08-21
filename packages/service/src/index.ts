export * from './titleCleaner';
export * from './contextStore';
export * from './secretStore';
export * from './launcher';
export * from './server';

import { createBridgeServer } from './server';

if (require.main === module) {
  const service = createBridgeServer();
  service.start().then(() => {
    console.log(`[StreamDockBridge Service] Running on http://127.0.0.1:17337`);
    console.log(`[StreamDockBridge Service] Secret file location: ${service.secretStore.getSecret() ? 'initialized' : 'failed'}`);
  });
}
