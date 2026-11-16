import type { Register } from 'claude-code'

// Artifact の定義（約 12.8k トークン）は、使う thread が少ないのに API 呼び出しのたびの入力に載る。
// 外すと brief にある Artifact の URL を読めなくなるので、説明文は変えずに ToolSearch の後ろへ移すだけにする
export const register: Register = on => {
  on('tool.describe', { tool: 'Artifact' }, async ($, e, next) => ({
    ...(await next(e)),
    isDeferred: true,
  }))
}
