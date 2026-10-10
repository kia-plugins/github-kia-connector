import type { ExtensionModule } from '@kiagent/connector-sdk';
import { createGitHubSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createGitHubSource(host)] };
  },
} satisfies ExtensionModule<'net' | 'query'>;

export default mod;
module.exports = mod;
