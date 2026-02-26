import { registerPlugin, WebPlugin } from '@capacitor/core'

import type { LanceDBPlugin, SearchResult } from './definitions'

class LanceDBWeb extends WebPlugin implements LanceDBPlugin {
  async open(): Promise<void> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
  async memoryStore(): Promise<void> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
  async memorySearch(): Promise<{ results: SearchResult[] }> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
  async memoryDelete(): Promise<void> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
  async memoryList(): Promise<{ keys: string[] }> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
  async memoryClear(): Promise<void> {
    throw this.unavailable('LanceDB is only available on native platforms.')
  }
}

export const LanceDB = registerPlugin<LanceDBPlugin>('LanceDB', {
  web: () => Promise.resolve(new LanceDBWeb()),
})
