export * from './titleCleaner';
export * from './contextStore';
export * from './secretStore';
export * from './launcher';
export * from './server';

import { createBridgeServer } from './server';
import { contextChannels } from './contextChannels';
import { voiceMediaContext } from './voiceMediaContext';

if (require.main === module) {
  // Production media lookups use VoiceMediaBridge/GSMTC as the sole media-title
  // authority. Library/test consumers keep raw browser context unless they opt in.
  contextChannels.setSystemMediaContextReader((now) => voiceMediaContext.read(now));

  const service = createBridgeServer();
  service.start().then(() => {
    console.log(`[StreamDockBridge Service] Running on http://127.0.0.1:17337`);
    console.log(`[StreamDockBridge Service] Secret file location: ${service.secretStore.getSecret() ? 'initialized' : 'failed'}`);
  });
}
