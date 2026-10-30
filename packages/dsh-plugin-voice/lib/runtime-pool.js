/**
 * 本地 TTS 运行时的进程级共享池。
 *
 * 为什么需要：模型是整份读进内存的（实测加载一份 +461MB RSS），而插件每重挂一代就新 apply 一次。
 * 若每代各建一份，重挂后第一次朗读会再加载一份——旧那份在 GC 前仍占着，进程里同时两份（实测 949MB），
 * 首声还要多等 2–3 秒。这里让同一进程内只有一份运行时，按引用计数共享：
 *
 *  - acquire：取那份运行时（没有就建），refs+1；同时把配置读取器换成当前这代实例的
 *    （旧闭包读到的配置会过期，而运行时是懒加载 + 每次合成现取，必须指向活着的那份）。
 *  - release：refs-1；归零后不立刻释放，先挂一个空闲定时器，到期仍归零才 dispose 并摘掉池子
 *    （重挂是「停旧 → 起新」，两代之间不留空闲窗口时不会白白丢掉已加载的模型）。
 *  - disposeShared：删除模型时用——必须连池子一起摘掉，否则下一次 acquire 会拿到模型已被删的运行时。
 *
 * `pluginUrl` 不随实例换：它是本模块的 import.meta.url，同一份代码在进程里恒定。
 */
const POOL_KEY = Symbol.for('dsh-plugin-voice/local-runtime@1')
const DEFAULT_IDLE_MS = 10 * 60_000

function pool() {
  return globalThis[POOL_KEY]
}

function clearIdle(holder) {
  if (holder && holder.idleTimer) {
    clearTimeout(holder.idleTimer)
    holder.idleTimer = null
  }
}

/**
 * 取共享运行时（没有就建），引用计数 +1。
 * @param {object} options
 * @param {(opts: { pluginUrl: string, getConfig: () => object }) => object} options.create 建运行时（测试注入用）
 * @param {() => object} options.getConfig 当前这代插件实例的配置读取器
 * @param {string} options.pluginUrl 本模块的 import.meta.url（只用于定位仓库里的开发模型）
 */
export function acquireLocalRuntime({ create, getConfig, pluginUrl } = {}) {
  let holder = pool()
  if (!holder || !holder.runtime) {
    if (typeof create !== 'function') throw new TypeError('acquireLocalRuntime: 池子为空时必须给 create')
    // 先建成功再写池子：create 抛错时不能留下一个 runtime=null 的 holder（否则之后每次 acquire 都拿到 null）
    const next = { runtime: null, getConfig, refs: 0, idleTimer: null }
    next.runtime = create({ pluginUrl, getConfig: () => next.getConfig() })
    holder = next
    globalThis[POOL_KEY] = holder
  }
  clearIdle(holder)
  // 后 acquire 的那一代覆盖前者：两个条目同时在场时，以最新实例的配置读取器为准（单实例设计下可接受）
  holder.getConfig = getConfig
  holder.refs += 1
  return holder.runtime
}

/**
 * 归还引用。归零后挂空闲定时器，到期仍无人取用才真正释放。
 * @param {object} [options]
 * @param {number} [options.idleMs] 空闲多久后释放（测试用短值）
 */
export function releaseLocalRuntime({ idleMs = DEFAULT_IDLE_MS } = {}) {
  const holder = pool()
  if (!holder) return
  holder.refs = Math.max(0, holder.refs - 1)
  if (holder.refs > 0) return
  clearIdle(holder)
  holder.idleTimer = setTimeout(() => {
    holder.idleTimer = null
    if (holder.refs > 0) return
    if (pool() === holder) delete globalThis[POOL_KEY]
    try { holder.runtime.dispose() } catch { /* 释放失败不阻断卸载 */ }
  }, Math.max(0, idleMs))
  // 空闲回收不该拖住进程退出（Electron 主进程 / CLI 都同理）
  if (typeof holder.idleTimer.unref === 'function') holder.idleTimer.unref()
}

/** 立刻释放并摘掉池子（删除模型前必须调：模型文件没了，共享实例不能再被取用）。 */
export function disposeSharedRuntime() {
  const holder = pool()
  if (!holder) return false
  clearIdle(holder)
  if (pool() === holder) delete globalThis[POOL_KEY]
  try { holder.runtime.dispose() } catch { /* 同上 */ }
  return true
}

/** 诊断/测试读数：池子在不在、引用计数多少。 */
export function sharedRuntimeState() {
  const holder = pool()
  return holder ? { refs: holder.refs, idle: !!holder.idleTimer, runtime: holder.runtime } : null
}

/** 仅测试用：丢掉池子（不等待空闲定时器）。 */
export function resetSharedRuntimeForTest() {
  const holder = pool()
  if (!holder) return
  clearIdle(holder)
  delete globalThis[POOL_KEY]
  try { holder.runtime.dispose() } catch { /* 同上 */ }
}
