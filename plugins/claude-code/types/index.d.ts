/** A decision this session's capture proposed, waiting for the developer's verdict. */
export type Pending = {
  id: string
  title: string
  why?: string
  rules: number
  supersedes: string[]
}

declare module 'claude-code' {
  interface PluginState {
    decisionengine: { pending: Shaped<Pending[]> }
  }
}
