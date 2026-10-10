import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the github source', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'github',
      sourceIds: ['github'],
    });
  }, 30_000);
});
