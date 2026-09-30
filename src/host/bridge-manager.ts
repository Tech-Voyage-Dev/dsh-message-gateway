/**
 * 桥接管理：维护各平台常驻连接（企业微信智能机器人 / Telegram / Discord 等）。
 * 所有平台消息走同一管线——每个聊天（平台:chatKey）自动创建独立 agent 会话，
 * 与 Web 对话完全一致：上下文超限时由 DSH 内置压缩服务（dsh-compaction-basic）
 * 自动摘要压缩；助手回复按 token 流（assistant/chunk）节流推送回平台，结束时定稿。
 * @module dsh-message-gateway/host/bridge-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolve as pathResolve, join as pathJoin } from 'node:path'
import { promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk'
import type { StoredStatus } from './gateway-store.ts'
import type { GatewayConfig } from '../core/config.ts'
import { botText } from './bot-i18n.ts'
import { sanitizeSecrets } from './sanitize.ts'
import { WecomBridge, type BridgeStatus } from './wecom-bridge.ts'
import { TelegramBridge } from './telegram-bridge.ts'
import { DiscordBridge } from './discord-bridge.ts'
import { QQBridge } from './qq-bridge.ts'
import { EmailBridge, type EmailCred } from './email-bridge.ts'
import { FeishuBridge } from './feishu-bridge.ts'
import { DingTalkBridge } from './dingtalk-bridge.ts'
import { WechatIlinkBridge, type WechatIlinkCred } from './wechat-ilink-bridge.ts'
import { BuzzBridge, type BuzzLocale } from './buzz-bridge.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { IncomingAttachment } from './incoming.ts'

/** 每个聊天最多保留的独立会话数（超出后淘汰最早创建的，释放上下文）。 */
const DEFAULT_MAX_CHAT_AGENTS = 40

/**
 * 运行时附件存储服务（宿主 @deepseek-ai/dsh-attachment 0.1.x）的鸭子类型。
 * 注意：本插件 node_modules 里的 dsh-attachment 是 0.1.0-rc.6（没有 saveFile /
 * FileBlock），而宿主实际运行 0.1.6-alpha.1（有）——版本错位，故用结构类型桥接，
 * 而不是把插件 peerDeps 锁到旧版或强行改依赖。
 */
interface DshAttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
  saveFile(input: { data: Uint8Array; name?: string }): Promise<unknown>
}

/**
 * 工作区注册表服务（宿主 @deepseek-ai/dsh-workspace）的鸭子类型：
 * 与 Web GUI 侧边栏「工作区」行共用同一个服务——create 注册目录（侧边栏可见），
 * resolveByPath + attachSession 把网关会话挂到对应工作区下（GUI 分组可见）。
 * 服务缺失时（部署未启用 dsh-workspace）优雅降级为仅切换会话 cwd。
 */
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<unknown>
  resolveByPath(path: string): Promise<{ attachSession(sessionId: string): Promise<void> } | undefined>
}

/**
 * 指令注册表服务（宿主 @deepseek-ai/dsh-commands）的鸭子类型：
 * 与 Web GUI 的 / 面板共用同一个注册表——list 提供描述符（供 /commands 列出），
 * execute 直接执行任意指令（/plan、/goal…），返回 success 文本或 error。
 */
interface CommandsRuntimeLike {
  list(agent: unknown): Array<{ name: string; description: string }>
  execute(
    agent: unknown,
    line: string,
    signal: AbortSignal,
  ): Promise<{ result: { kind: 'success'; text?: string } | { kind: 'error'; text: string } } | undefined>
}

/** 文件引用发现服务（宿主 fileReferences，Web 的 @ 补全同一数据源）。 */
interface FileReferencesLike {
  list(agent: unknown, query: string, signal: AbortSignal): Promise<Array<{ path: string; kind: 'file' | 'directory' }>>
}

/** LLM 目录服务鸭子类型：列供应商/模型 + 校验思考力度。 */
interface LlmServiceLike {
  listProviders(): Array<{ id: string }>
  listModels(provider: string): Promise<Array<{ id: string }>>
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string }
  }>
}

/** agent 指令分派结果：reply=已回复收尾；run=指令成功，用 text 作为用户消息；none=未命中指令。 */
type AgentCommandOutcome = { status: 'reply' } | { status: 'run'; text: string } | { status: 'none' }

/** 附件存储支持（并会按字节校验）的图片 MIME 白名单。 */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 平台声明的 MIME → 可存储的图片类型；不在白名单返回 null（调用方退化为文件块）。 */
function normalizeImageMediaType(mediaType: string | undefined): string | null {
  const t = (mediaType ?? '').trim().toLowerCase()
  return IMAGE_MEDIA_TYPES.includes(t) ? t : null
}

/** 流式推送合并间隔（毫秒）：避免逐 token 高频全量更新，保持平台端平滑。 */
const STREAM_PUSH_INTERVAL = 600

/** ack 心跳间隔（毫秒）：模型长思考期间周期性刷新回执，避免「假死」。 */
const ACK_HEARTBEAT_INTERVAL = 4000

/** 平台回复通道抽象：流式（send + edit 或原生流）+ 可选 HTTP 定稿（response_url 类）。 */
export interface ReplySink {
  /** 流式/完整回复。finish=true 表示定稿（流式平台结束编辑，非流式平台直接发送）。 */
  stream(frame: unknown, streamId: string, content: string, finish: boolean): void
  /** 可选：独立的 HTTP 定稿通道（如企业微信 response_url）。 */
  post?(frame: unknown, content: string): Promise<boolean>
  /** 平台是否需要「正在处理…」即时回执（邮件等会一封回一封的平台可关闭）。 */
  ack?: boolean
}

/** 一条外部消息的会话身份（跨平台唯一）。 */
export interface ChatIdentity {
  /** 跨平台唯一键：`${platform}:${chatKey}`（如 wecom:user:xxx / telegram:123 / discord:456）。 */
  key: string
  frame: unknown
  sink: ReplySink
  chatType: 'single' | 'group'
}

/** 一条等待回复的注入请求（每个聊天独立，互不阻塞）。 */
interface PendingReply {
  frame: unknown
  sink: ReplySink
  streamId: string
  buffer: string
  /** 已完成的历史步骤消息集合（避免跨步骤工具调用时前置消息被冲掉覆盖）。 */
  stepMessages: string[]
  /** 当前正在流式吐字的分段缓冲区。 */
  currentStepBuffer: string
  /** 已消费到的事件序号（事件快照按 seq 顺序推进）。 */
  cursor: number
  /** 轮询定时器。 */
  timer: ReturnType<typeof setInterval> | null
  /** 兜底清理定时器。 */
  fallback: ReturnType<typeof setTimeout> | null
  pushed: boolean
  httpDelivered: boolean
  /** 是否已发出「正在处理…」回执（用于超时兜底时收尾流式消息）。 */
  ackSent: boolean
  /** 上次流式推送时间戳（合并限频）。 */
  lastPush: number
  /** 请求发起时间戳（ack 心跳显示已等待秒数）。 */
  startedAt: number
  /** ack 心跳定时器（长思考期间周期性刷新「正在处理… N 秒」）。 */
  heartbeat: ReturnType<typeof setInterval> | null
}

/** 平台 id → 常驻桥。 */
export class BridgeManager {
  private wecom: WecomBridge | null = null
  private onStatusCallback: ((status: BridgeStatus) => void) | null = null
  /** 各聊天在途回复（key = 平台:chatKey）。 */
  private pendingMap = new Map<string, PendingReply>()
  /** Webhook 在途请求（同步等待完整回复；全局单槽位）。 */
  private awaiting: { resolve: (reply: string) => void } | null = null
  /** 各聊天的独立 agent 会话（key = 平台:chatKey；webhook 固定 'webhook'）。 */
  private agents = new Map<string, { agent: Agent; dispose: () => Promise<void> }>()
  /** 各聊天的工作目录（/workspace 指令切换；缺省 = 宿主进程 cwd）。 */
  private chatCwds = new Map<string, string>()
  /** 各聊天的模型选择槽（/model、/effort 指令切换；picked 缺省时跟随 botModel/部署默认）。 */
  private chatModels = new Map<string, { picked: ModelSelection | undefined }>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: GatewayConfig,
  ) {
    // 回复回传通过轮询会话事件快照完成：scoped 事件（session/event）在全局
    // 上下文收不到，而 session.events 是 append-only 快照，按 seq 推进即可。
  }

  /** 当前语言的文案（语言缺失时回退默认 English）。 */
  private t(key: string): string {
    return botText(this.config.botLocale ?? 'en', key)
  }

  /** 轮询注入会话的事件流：chunk → 流式推送；assistant/message → 定稿 + HTTP。 */
  private pollPending(key: string, p: PendingReply, session: any): void {
    if (!session) return
    const events: readonly SessionEvent[] = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (Array.isArray(session.events) ? session.events : [])
    if (!Array.isArray(events)) return
    try {
      for (let i = p.cursor; i < events.length; i += 1) {
        p.cursor = i + 1
        const event = events[i]
        if (!event) continue

        // 只要收到任意新事件（包括工具调用、思考分块），立即滑动续期超时保护（重置为 90 秒无响应才超时）
        if (p.fallback !== null) {
          clearTimeout(p.fallback)
          p.fallback = setTimeout(() => {
            if (this.pendingMap.get(key) === p) {
              console.warn('[dsh-message-gateway] idle timeout (no events for 90s)', { key })
              this.finishPending(key)
            }
          }, 90 * 1000)
          p.fallback.unref?.()
        }

        // 1. 实时文本分块（流式打字效果）
        if (event.type === 'assistant/chunk') {
          const chunk = (event as SessionEvent<'assistant/chunk'>).data?.chunk
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            p.currentStepBuffer += chunk.text
            p.buffer = [...p.stepMessages, p.currentStepBuffer].filter(Boolean).join('\n\n')
            this.scheduleStream(p)
          }
          continue
        }

        // 2. 某个步骤的完整文本已定稿（跨工具调用步骤）
        if (event.type === 'assistant/message') {
          const text = extractText((event as SessionEvent<'assistant/message'>).data?.message)
          if (text === '' || isToolCallOnly(text)) continue

          // 将当前定稿步骤沉淀进已完成步骤列表（去重保护）
          if (!p.stepMessages.includes(text)) {
            p.stepMessages.push(text)
          }
          p.currentStepBuffer = ''
          p.buffer = p.stepMessages.join('\n\n')
          this.scheduleStream(p)
          continue
        }

        // 3. 整个轮次所有步骤全部收敛执行结束
        if (event.type === 'turn/end') {
          if (p.currentStepBuffer.trim()) {
            if (!p.stepMessages.includes(p.currentStepBuffer.trim())) {
              p.stepMessages.push(p.currentStepBuffer.trim())
            }
            p.currentStepBuffer = ''
          }
          p.buffer = p.stepMessages.filter(Boolean).join('\n\n')
          if (p.buffer !== '') {
            console.log('[dsh-message-gateway] turn fully ended', { key, steps: p.stepMessages.length, totalLen: p.buffer.length })
            void this.pushStream(p, true)
            void this.deliverHttp(p, p.pushed)
            this.finishPending(key)
            return
          }
        }
      }
    } catch (err) {
      console.error('[dsh-message-gateway] pollPending error', err)
    }
  }

  /** 流式推送：随轮询节奏（每 400ms 一次）全量更新，避免高频发送。 */
  private scheduleStream(p: PendingReply): void {
    void this.pushStream(p, false)
  }

  private pushStream(p: PendingReply, finish: boolean): void {
    if (p.buffer === '' && !finish) return
    const now = Date.now()
    // 合并限频：距上次推送不足间隔时跳过本次，内容已累积在 buffer，
    // 由下一次推送（或定稿）全量带出——平台端更新平滑，不逐 token 轰炸。
    if (!finish && p.lastPush !== 0 && now - p.lastPush < STREAM_PUSH_INTERVAL) return
    p.lastPush = now
    p.pushed = true

    // 多步骤友好提示：如果对话尚未完结 (finish: false)，在已输出的正文下方追加动态状态提示
    let outputText = p.buffer
    if (!finish && p.buffer !== '') {
      const loadingHint = this.t('stepLoading')
      outputText = `${p.buffer}\n\n*${loadingHint}*`
    }

    console.log('[dsh-message-gateway] stream push', { finish, len: outputText.length })
    p.sink.stream(p.frame, p.streamId, outputText, finish)
  }

  /** 经平台 HTTP 定稿通道发送完整回复（幂等；流式已投递时不重复发）。 */
  private async deliverHttp(p: PendingReply, streamed: boolean): Promise<void> {
    if (p.httpDelivered || p.sink.post === undefined || streamed) return
    p.httpDelivered = true
    try {
      await p.sink.post(p.frame, p.buffer)
    } catch (error) {
      console.error('[dsh-message-gateway] post delivery failed', error)
    }
  }

  private finishPending(key: string): void {
    const p = this.pendingMap.get(key)
    if (p === undefined) return
    if (p.timer !== null) {
      clearInterval(p.timer)
      p.timer = null
    }
    if (p.fallback !== null) {
      clearTimeout(p.fallback)
      p.fallback = null
    }
    if (p.heartbeat !== null) {
      clearInterval(p.heartbeat)
      p.heartbeat = null
    }
    this.pendingMap.delete(key)
    // 只发过「正在处理…」但从未产出内容 → 以超时文案收尾流式消息并结束 finish=true。
    if (p.ackSent && !p.pushed) {
      void p.sink.stream(p.frame, p.streamId, this.t('timeout'), true)
    }
  }

  /** 桥状态变化回调（供路由同步存储）。 */
  onStatus(fn: (status: BridgeStatus) => void): void {
    this.onStatusCallback = fn
  }

  /**
   * 解析聊天缺省模型：路由 botModel > 插件配置 botModel > 部署默认模型 > 根 agent。
   * 全部不可用时返回 undefined（调用方回退失败处理）。
   */
  private resolveDefaultModel(route?: { botModel?: { provider: string; model: string } }): ModelSelection | undefined {
    const override = route?.botModel ?? this.config.botModel
    let selection: { provider: string; model: string } | undefined
    if (override !== undefined && override.provider !== '' && override.model !== '') {
      selection = { provider: override.provider, model: override.model }
    } else {
      const defaultModel = (this.ctx as { get?: (name: string) => unknown }).get?.('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined
      selection = defaultModel?.currentSelection()
    }
    let provider = selection?.provider ?? ''
    let model = selection?.model ?? ''
    // 兜底：服务不可用时回退已注册根 agent 的模型配置。
    if (provider === '' || model === '') {
      const root = this.ctx.agents.roots()[0] ?? this.ctx.agents.list()[0]
      provider = root?.options.provider ?? ''
      model = root?.options.model ?? ''
    }
    if (provider === '' || model === '') return undefined
    return { provider, model }
  }

  /** 创建/获取某聊天的独立 agent：独立会话 + 模型配置（默认跟随部署，可被 botModel / /model 覆盖）。 */
  private async ensureAgentForKey(key: string, route?: { agentPreset?: string; botModel?: { provider: string; model: string }; skill?: string }): Promise<Agent | null> {
    // 路由专用会话键：路由不同则会话隔离（避免「code 路由」与「默认路由」串上下文）。
    const sessionKey = route?.agentPreset !== undefined || route?.skill !== undefined ? `${key}::${route?.agentPreset ?? ''}#${route?.skill ?? ''}` : key
    const existing = this.agents.get(sessionKey)
    if (existing !== undefined) return existing.agent
    // 缺省模型：路由专用模型 > 插件配置 botModel > 部署默认模型 > 根 agent。
    const defaultModel = this.resolveDefaultModel(route)
    if (defaultModel === undefined) {
      console.warn('[dsh-message-gateway] no model selection available (botModel/agentDefaultModel/roots)')
      return null
    }
    // 每聊天模型选择槽：/model、/effort 直接改 picked（可变引用被 prompt 组装按
    // current 读取，与 Web GUI 的「Model & Effort」同语义——下一条消息生效）。
    const chatModel = this.chatModels.get(key) ?? { picked: undefined as ModelSelection | undefined }
    this.chatModels.set(key, chatModel)
    const selection = {
      get current(): ModelSelection | undefined {
        return chatModel.picked ?? defaultModel
      },
      set current(next: ModelSelection | undefined) {
        chatModel.picked = next
      },
      assembled: void 0 as ModelSelection | undefined,
    }
    const initial = chatModel.picked ?? defaultModel
    const provider = initial.provider
    const model = initial.model
    // 上限保护：超出后淘汰最早创建的会话（Map 按插入序迭代）。
    if (this.agents.size >= (this.config.maxChatAgents > 0 ? this.config.maxChatAgents : DEFAULT_MAX_CHAT_AGENTS)) {
      const oldestKey = this.agents.keys().next().value as string | undefined
      if (oldestKey !== undefined) {
        const oldest = this.agents.get(oldestKey)
        this.agents.delete(oldestKey)
        void oldest?.dispose().catch(() => { /* 忽略 */ })
        console.log('[dsh-message-gateway] evict oldest chat session', { key: oldestKey })
      }
    }
    try {
      // 仿 dsh-headless / Web GUI：随机会话 id + 工作目录（persona 段依赖 {{cwd}}），
      // 由 agent 工厂的 sessions.prepare 创建会话。工作目录默认宿主进程 cwd，
      // 可被 /workspace 指令按聊天切换（chatCwds）。
      // 注意：meta 不能带 origin: 'subagent'——Web GUI 的工作区会话树会隐藏所有
      // origin === 'subagent' 的会话（只作为父会话的子代理谱系展示），导致消息
      // 平台新建的聊天会话在 Web UI 上不可见。
      const cwd = this.chatCwds.get(key) ?? process.cwd()
      const sessionId = SessionId(`session-${randomUUID()}`)
      const handle: AgentHandle = await this.ctx.agents.create({
        sessionId,
        agentOptions: { provider, model },
        meta: {
          cwd,
          ...(route?.agentPreset === undefined ? {} : { agentPreset: route.agentPreset }),
        },
        setup: async (agentCtx) => {
          // 通用组合：挂载部署的默认 agent 预设（工具/提示词段/技能目录随预设而来），
          // 路由指定预设时优先挂载路由预设；无预设服务的部署自动退化为全局层。
          const presets = (agentCtx as { get?: (name: string) => unknown }).get?.('agentPresets') as
            | { mount(agentCtx: unknown, id?: string): Promise<unknown> }
            | undefined
          if (presets !== undefined) {
            try {
              await presets.mount(agentCtx, route?.agentPreset)
            } catch (error) {
              console.warn('[dsh-message-gateway] agent preset mount skipped', String(error))
            }
          }
          // 路由指定 skill：挂载 skill 目录（若宿主提供）。
          if (route?.skill !== undefined) {
            const skills = (agentCtx as { get?: (name: string) => unknown }).get?.('skills') as
              | { mount?(agentCtx: unknown, id?: string): Promise<unknown>; list?(): Promise<Array<{ id: string }>> }
              | undefined
            if (skills !== undefined) {
              try {
                if (typeof skills.mount === 'function') {
                  await skills.mount(agentCtx, route.skill)
                } else {
                  const catalog = await skills.list?.()
                  const found = catalog?.find((s) => s.id === route.skill)
                  if (found !== undefined) console.log('[dsh-message-gateway] route skill available', route.skill)
                }
              } catch (error) {
                console.warn('[dsh-message-gateway] route skill mount skipped', String(error))
              }
            }
          }
          // 模型选择注入（与 Web GUI 的 Model & Effort 同源：可变引用，
          // prompt 组装按 current 快照，切换后下一步生效）。
          installModelSelection(agentCtx, selection)
        },
      })
      this.agents.set(sessionKey, { agent: handle.agent, dispose: () => handle.dispose() })
      
      // 关键授权保护：外部消息通道（企业微信、Telegram、Discord、Email、Webhook等）
      // 无法弹出人机确认弹窗，必须将审批策略设置为 'never'（自动放行安全工具执行），
      // 彻底消除工具调用因无人审批而死锁在挂起状态的问题！
      try {
        (handle.agent.session as any).append('approval/policy', { policy: 'never' })
      } catch (e) {
        console.warn('[dsh-message-gateway] set approval policy failed', e)
      }

      // 非默认目录的会话：若该目录已注册为工作区，把本会话挂到该工作区下
      // （Web GUI 侧边栏「工作区」分组可见）。尽力而为，失败不影响对话。
      if (cwd !== process.cwd()) {
        const registry = (this.ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
          | WorkspaceRegistryLike
          | undefined
        if (registry !== undefined && typeof registry.resolveByPath === 'function') {
          void (async () => {
            try {
              const workspace = await registry.resolveByPath(cwd)
              if (workspace !== undefined) await workspace.attachSession(handle.agent.session.id)
            } catch (error) {
              console.warn('[dsh-message-gateway] attach workspace session skipped', String(error))
            }
          })()
        }
      }

      console.log('[dsh-message-gateway] dedicated agent ready', { key: sessionKey, session: handle.agent.session.id, provider, model, cwd, preset: route?.agentPreset ?? '(default)', skill: route?.skill ?? undefined })
      return handle.agent
    } catch (error) {
      console.error('[dsh-message-gateway] create agent failed', error)
      return null
    }
  }

  /**
   * 主动释放某聊天的会话（对应 Web 的「新会话」；下一条消息自动新建）。
   * 同时覆盖默认会话与该聊天下所有路由专用会话（`${key}::…` 前缀）。
   */
  async resetChat(key: string): Promise<boolean> {
    const matched = [...this.agents.keys()].filter((k) => k === key || k.startsWith(`${key}::`))
    if (matched.length === 0) return false
    this.finishPending(key)
    for (const sessionKey of matched) {
      const entry = this.agents.get(sessionKey)
      if (entry === undefined) continue
      this.agents.delete(sessionKey)
      try {
        await entry.dispose()
      } catch (error) {
        console.error('[dsh-message-gateway] reset chat dispose failed', error)
      }
    }
    console.log('[dsh-message-gateway] chat session reset', { key, sessions: matched.length })
    return true
  }

  /** 插件卸载时释放全部聊天会话与长连接（带超时脱钩保护，防死锁）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // 1. 立即停止所有外部长连接与长轮询，防止卸载后继续接收外部事件
    this.wecom?.stop()
    this.wecom = null
    this.telegram?.stop()
    this.telegram = null
    this.discord?.stop()
    this.discord = null
    this.qq?.stop()
    this.qq = null
    this.email?.stop()
    this.email = null
    this.feishu?.stop()
    this.feishu = null
    this.dingtalk?.stop()
    this.dingtalk = null
    this.wechat?.stop()
    this.wechat = null
    this.buzz?.stop()
    this.buzz = null

    // 2. 清除在途轮询与心跳定时器
    this.finishAllPending()

    // 3. 释放全部子 Agent 会话（超时保护：最多等待 1.5s，避免正在执行工具调用的会话死锁插件卸载）
    const entries = [...this.agents.values()]
    this.agents.clear()
    const disposePromises = entries.map((entry) =>
      entry.dispose().catch((error) => {
        console.warn('[dsh-message-gateway] agent dispose warning', String(error))
      }),
    )
    await Promise.race([
      Promise.allSettled(disposePromises),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ])
  }

  private finishAllPending(): void {
    for (const key of [...this.pendingMap.keys()]) this.finishPending(key)
  }

  /**
   * 文本 + 附件 → 内容块。
   * - 图片：走 ctx.attachments.saveImage → ImageBlock（多模态直接交给模型）；
   *   平台 MIME 不在受支持集合（png/jpeg/webp/gif）时退化为文件块。
   * - 其它文件：ctx.attachments.saveFile → FileBlock（请求组装时投影为
   *   「文件名 + 字节数 + 只读路径」句柄文本，Agent 可用文件工具读取处理）。
   * - 任何保存失败都会产出用户可见的占位文本，绝不静默丢弃。
   */
  private async buildContentBlocks(text: string, attachments: IncomingAttachment[] | undefined): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = []
    if (text.trim() !== '') blocks.push({ type: 'text', text })
    const list = attachments ?? []
    if (list.length === 0) return blocks
    // 用 ctx.get 安全探测（与上文 agentDefaultModel 的取法一致）：直接读
    // ctx.attachments 在服务未注册/未 inject 时会抛错并让整个 fiber 失败（已踩过该坑）。
    const store = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('attachments') as
      | DshAttachmentStoreLike
      | undefined
    if (store === undefined) {
      blocks.push({ type: 'text', text: '（收到附件，但附件存储服务不可用，无法处理）' })
      return blocks
    }
    for (const att of list) {
      try {
        if (att.kind === 'image') {
          const mediaType = normalizeImageMediaType(att.mediaType)
          if (mediaType === null) {
            const ref = await store.saveFile({ data: att.data, name: att.name })
            blocks.push({ type: 'file', attachment: ref } as unknown as ContentBlock)
          } else {
            const ref = await store.saveImage({ data: att.data, mediaType, name: att.name })
            blocks.push({ type: 'image', attachment: ref } as unknown as ContentBlock)
          }
        } else {
          const ref = await store.saveFile({ data: att.data, name: att.name })
          blocks.push({ type: 'file', attachment: ref } as unknown as ContentBlock)
        }
      } catch (error) {
        // 图片字节校验失败等 → 退化为文件块；仍失败则给用户可见说明。
        if (att.kind === 'image') {
          try {
            const ref = await store.saveFile({ data: att.data, name: att.name })
            blocks.push({ type: 'file', attachment: ref } as unknown as ContentBlock)
            continue
          } catch {
            /* 落到下方可见说明 */
          }
        }
        blocks.push({
          type: 'text',
          text: `（附件「${att.name ?? '未知'}」保存失败：${error instanceof Error ? error.message : String(error)}）`,
        })
      }
    }
    return blocks
  }

  /**
   * 外部平台消息统一入口：命令优先，否则注入该聊天独立 agent 会话，
   * 回复经 sink 流式回发。所有已打通的平台共用此管线。
   */
  async handleExternalMessage(id: ChatIdentity, rawText: string, attachments?: IncomingAttachment[]): Promise<void> {
    if (this.disposed) return
    const text = stripMention(rawText)
    const reply = (content: string): void => {
      id.sink.stream(id.frame, `cmd-${Date.now().toString(36)}`, content, true)
    }
    try {
      // 配置：不回复群聊时只处理单聊。
      if (id.chatType === 'group' && !this.config.groupReply) return
      // 斜杠命令 / 关键词命令优先处理，不进入 agent。
      if (await this.handleCommand(text, id.key, reply)) return
      // Webhook 同步请求在途时丢弃（极少数并发场景）。
      if (this.awaiting !== null) {
        console.warn('[dsh-message-gateway] busy: webhook in flight, drop message')
        return
      }
      // 同一聊天上一轮还在处理 → 礼貌回执，避免回复串台。
      if (this.pendingMap.has(id.key)) {
        id.sink.stream(id.frame, `busy-${Date.now().toString(36)}`, this.t('busy'), true)
        return
      }
      // 消息路由：按平台 + 关键词前缀匹配配置的规则（第一条命中生效），
      // 命中则剥离前缀并把消息路由到指定 agent 预设（独立会话）。
      const route = this.matchRoute(id.key, text)
      const routedText = route !== null && route.prefix !== '' ? text.slice(route.prefix.length).trim() : text
      // 需要 agent 的指令：@ 浏览 / /commands / /files / /model / /effort / Web 指令透传。
      const command = await this.dispatchAgentCommand(id.key, route?.rule, routedText, reply)
      if (command.status === 'reply') return
      // 文本 + 附件组装内容块（图片多模态；其它文件投影为句柄文本供 Agent 读取）。
      // Web 指令成功执行时，用指令输出文本作为本轮用户消息（与 Web 一致）。
      const content = await this.buildContentBlocks(command.status === 'run' ? command.text : routedText, attachments)
      if (content.length === 0) {
        console.warn('[dsh-message-gateway] no content to send', { key: id.key })
        return
      }
      // 每个聊天自动创建独立会话（与 Web 对话一致；超限自动压缩由会话层内置完成）。
      const agent = await this.ensureAgentForKey(id.key, route?.rule)
      if (agent === null) {
        console.warn('[dsh-message-gateway] no dedicated agent available')
        return
      }
      const message: UserMessage = {
        id: MessageId(`dsh-gateway-${Date.now().toString(36)}`),
        role: 'user',
        content,
        // source.kind 必须是 'user'：DSH 的会话命名服务（dsh-session-title）只对
        // kind === 'user' 的消息生成会话标题（首条消息确定性回退 + LLM 命名），
        // 之前用 'plugin' 导致 Web UI 里会话没有名字、回落到工作区名。
        source: { kind: 'user' },
      }
      const session = agent.session
      const p: PendingReply = {
        frame: id.frame,
        sink: id.sink,
        streamId: `gw-${Date.now().toString(36)}`,
        buffer: '',
        stepMessages: [],
        currentStepBuffer: '',
        cursor: session.seq,
        timer: null,
        fallback: null,
        pushed: false,
        httpDelivered: false,
        ackSent: false,
        lastPush: 0,
        startedAt: Date.now(),
        heartbeat: null,
      }
      this.pendingMap.set(id.key, p)
      // 立即回执：复用流式 streamId（finish=false），回复内容就地在同一条消息里
      // 渐进更新（Telegram/Discord/QQ 编辑同一消息，企业微信流式消息同 id 更新）。
      if (id.sink.ack !== false) {
        p.ackSent = true
        id.sink.stream(id.frame, p.streamId, this.t('ack'), false)
        // 长思考心跳：每 4 秒刷新回执（显示已等待秒数），正文开始流式后自动退出。
        p.heartbeat = setInterval(() => {
          if (this.pendingMap.get(id.key) !== p || p.pushed) return
          const elapsed = Math.round((Date.now() - p.startedAt) / 1000)
          id.sink.stream(id.frame, p.streamId, `${this.t('ack')} (${elapsed}s)`, false)
        }, ACK_HEARTBEAT_INTERVAL)
        p.heartbeat.unref?.()
      }
      agent.send(message, 'next-turn', true)
      console.log('[dsh-message-gateway] sent to agent', { key: id.key, text: sanitizeSecrets(text.slice(0, 60)), baseSeq: p.cursor })
      // 轮询事件快照：chunk 流式推送、assistant/message 定稿。
      p.timer = setInterval(() => {
        try {
          if (this.pendingMap.get(id.key) !== p) return
          this.pollPending(id.key, p, session)
        } catch (pollErr) {
          console.error('[dsh-message-gateway] timer pollPending caught error', pollErr)
        }
      }, 400)
      // 兜底超时（滑动保活：只要 90 秒内持续有新事件/工具推进就不中断；连续 90 秒静默才超时清理）。
      p.fallback = setTimeout(() => {
        if (this.pendingMap.get(id.key) === p) {
          console.warn('[dsh-message-gateway] initial idle timeout (90s silent)', { key: id.key })
          this.finishPending(id.key)
        }
      }, 90 * 1000)
      p.fallback.unref?.()
    } catch (error) {
      console.error('[dsh-message-gateway] handleExternalMessage failed', error)
    }
  }

  // ==================== 企业微信智能机器人 ====================

  /** 把一条外部文本消息交给 Webhook 专用 agent 处理，同步等待完整回复（Webhook 通道）。 */
  async sendAndWait(text: string, timeoutMs = 90_000): Promise<{ ok: boolean; reply: string }> {
    if (this.pendingMap.size > 0 || this.awaiting !== null) {
      return { ok: false, reply: 'busy: another request is being processed' }
    }
    const agent = await this.ensureAgentForKey('webhook')
    if (agent === null) return { ok: false, reply: 'no dedicated agent available' }
    const session = agent.session
    const cursor = session.seq
    const message: UserMessage = {
      id: MessageId(`dsh-gw-webhook-${Date.now().toString(36)}`),
      role: 'user',
      content: [{ type: 'text', text }],
      // 与聊天管线一致：kind 'user' 让会话命名服务正常生成标题。
      source: { kind: 'user' },
    }
    return await new Promise<{ ok: boolean; reply: string }>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      let poll: ReturnType<typeof setInterval>
      const settle = (ok: boolean, reply: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poll)
        this.awaiting = null
        resolve({ ok, reply })
      }
      timer = setTimeout(() => settle(false, 'timeout waiting for reply'), timeoutMs)
      poll = setInterval(() => {
        if (this.awaiting === null) {
          clearInterval(poll)
          return
        }
        const events: readonly SessionEvent[] = typeof (session as any).snapshotEvents === 'function'
          ? (session as any).snapshotEvents()
          : (Array.isArray((session as any).events) ? (session as any).events : [])
        for (let i = cursor; i < events.length; i += 1) {
          const event = events[i]
          if (event.type === 'assistant/message') {
            const reply = extractText((event as SessionEvent<'assistant/message'>).data.message)
            // 跳过空消息与纯工具调用消息：工具调用轮/中间步骤不是最终回复。
            if (reply !== '' && !isToolCallOnly(reply)) {
              settle(true, reply)
              return
            }
          }
        }
      }, 400)
      this.awaiting = { resolve: (reply: string): void => settle(true, reply) }
      try {
        agent.send(message, 'next-turn', true)
        console.log('[dsh-message-gateway] webhook sent to agent', { text: sanitizeSecrets(text.slice(0, 60)), baseSeq: cursor })
      } catch (error) {
        console.error('[dsh-message-gateway] webhook send failed', error)
        settle(false, 'send failed')
      }
    })
  }

  /** 启动企业微信桥（凭据变化时先停旧桥）。 */
  startWecom(cred: { botId: string; secret: string }): void {
    this.wecom?.stop()
    const bridge = new WecomBridge(cred, {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (rawText, frame, attachments) => {
        const body = frame.body ?? ({} as Record<string, unknown>)
        const chattype = (body as { chattype?: string }).chattype ?? 'single'
        const userid = (body.from as { userid?: string } | undefined)?.userid ?? ''
        const chatid = (body.chatid as string | undefined) ?? ''
        const key = chatid !== '' ? `wecom:group:${chatid}` : `wecom:user:${userid}`
        const sink: ReplySink = {
          stream: (f, sid, content, finish) => void this.wecom?.streamReply(f as WsFrame<TextMessage>, sid, content, finish),
          // 企业微信走单一流式消息（ack → 内容 → 定稿同一条消息就地更新）；
          // 不再叠加 response_url 投递，避免出现重复消息。
        }
        void this.handleExternalMessage({ key, frame, sink, chatType: chattype === 'group' ? 'group' : 'single' }, rawText, attachments)
      },
      onEnter: (frame) => {
        // 用户当天首次进入单聊会话：仅在配置开启 welcomeReply（默认 false 免打扰）时回复欢迎语。
        if (!this.config.welcomeReply) return
        const userid = frame.body?.from?.userid ?? ''
        console.log('[dsh-message-gateway] enter chat welcome', { userid })
        void this.wecom?.welcome(frame, this.t('welcome'))
      },
    })
    this.wecom = bridge
    bridge.start()
  }

  /** 停止企业微信桥（保留各聊天会话上下文）。 */
  stopWecom(): void {
    this.finishAllPending()
    this.wecom?.stop()
    this.wecom = null
  }

  /** 当前桥状态（供路由展示）。 */
  wecomStatus(): BridgeStatus {
    return this.wecom?.status ?? { state: 'idle', detail: '', connectedAt: null }
  }

  /** 当前活跃聊天会话数（供状态展示）。 */
  chatCount(): number {
    return this.agents.size
  }

  /** 主动向会话发送 markdown 消息（单聊=userid，群聊=群 ID）。 */
  async sendToChat(chatid: string, content: string): Promise<boolean> {
    if (this.wecom === null) return false
    return this.wecom.sendMessage(chatid, content)
  }

  /**
   * 主动推送：向任意平台的目标会话发送文本（供 cron 通知、其他插件调用）。
   * 支持平台：wecom-aibot（企微智能机器人）/ telegram / discord / email / buzz。
   * 不支持主动推送的平台（qq 等）返回明确错误。
   * @param platform 平台 id（见 PLATFORMS）。
   * @param target 目标（telegram=chatId 数字串；discord=channelId；wecom-aibot=userid/群ID；email=收件地址；buzz=频道 UUID）。
   * @param content 文本内容。
   * @param opts.title 可选标题（email 作为主题；其他平台拼在正文前）。
   */
  async pushMessage(platform: string, target: string, content: string, opts: { title?: string } = {}): Promise<{ ok: boolean; detail: string }> {
    const text = opts.title !== undefined && opts.title !== ''
      ? `【${opts.title}】\n${content}`
      : content
    const { loadStore } = await import('./gateway-store.ts')
    const store = await loadStore()
    if (store.enabled[platform] === false) return { ok: false, detail: `platform "${platform}" is disabled（已停用）` }
    switch (platform) {
      case 'wecom-aibot': {
        if (this.wecom === null) return { ok: false, detail: 'wecom-aibot bridge not connected' }
        const sent = await this.wecom.sendMessage(target, text)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'wecom send failed' }
      }
      case 'telegram': {
        if (this.telegram === null) return { ok: false, detail: 'telegram bridge not connected' }
        const chatId = Number(target)
        if (!Number.isInteger(chatId) || chatId <= 0) return { ok: false, detail: 'telegram target must be a numeric chatId' }
        const sent = await this.telegram.send(chatId, text)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'telegram send failed' }
      }
      case 'discord': {
        if (this.discord === null) return { ok: false, detail: 'discord bridge not connected' }
        const sent = await this.discord.send(target, text)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'discord send failed' }
      }
      case 'email': {
        if (this.email === null) return { ok: false, detail: 'email bridge not connected' }
        const subject = opts.title ?? 'DSH Notification'
        const sent = await this.email.send(target, subject, content)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'email send failed' }
      }
      case 'dingtalk': {
        // 钉钉自定义机器人 Webhook 推送
        const rawUrl = target.startsWith('http') ? target : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(target)}`
        let targetUrl = rawUrl
        // 自动查找保存的 secret
        const { loadStore } = await import('./gateway-store.ts')
        const store = await loadStore()
        const secret = store.platforms.dingtalk?.secret
        if (secret) {
          const { createHmac } = await import('node:crypto')
          const timestamp = Date.now()
          const stringToSign = `${timestamp}\n${secret}`
          const sign = encodeURIComponent(createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64'))
          targetUrl += `${rawUrl.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`
        }
        const resp = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: opts.title ?? 'DSH Notification', text: text },
          }),
        })
        const r = (await resp.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
        return r.errcode === 0 ? { ok: true, detail: 'sent' } : { ok: false, detail: r.errmsg ?? 'dingtalk send failed' }
      }
      case 'feishu': {
        if (this.feishu) {
          const sent = await this.feishu.sendMessage(target, text, target.startsWith('oc_') ? 'chat_id' : (target.startsWith('ou_') ? 'open_id' : 'chat_id'))
          return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'feishu sendMessage failed' }
        }
        // 若桥未连接但有自建应用凭据，通过 REST API 发送
        const { loadStore } = await import('./gateway-store.ts')
        const store = await loadStore()
        const appId = store.platforms.feishu?.appId
        const appSecret = store.platforms.feishu?.appSecret
        if (appId && appSecret) {
          try {
            const lark = await import('@larksuiteoapi/node-sdk')
            const client = new lark.Client({ appId, appSecret })
            await client.im.message.create({
              params: { receive_id_type: target.startsWith('oc_') ? 'chat_id' : (target.startsWith('ou_') ? 'open_id' : 'chat_id') },
              data: {
                receive_id: target,
                msg_type: 'text',
                content: JSON.stringify({ text }),
              },
            })
            return { ok: true, detail: 'sent' }
          } catch (err) {
            return { ok: false, detail: `feishu client send failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        }
        return { ok: false, detail: 'feishu not configured or bridge not started' }
      }
      case 'bark': {
        // Bark iOS 推送
        const { loadStore } = await import('./gateway-store.ts')
        const store = await loadStore()
        const server = (store.platforms.bark?.serverUrl || 'https://api.day.app').replace(/\/+$/, '')
        const deviceKey = target || store.platforms.bark?.deviceKey
        if (!deviceKey) return { ok: false, detail: 'missing bark device key' }
        const url = `${server}/${encodeURIComponent(deviceKey)}/`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: opts.title ?? 'DSH Notification', body: content, group: 'DSH' }),
        })
        const r = (await resp.json().catch(() => ({}))) as { code?: number; message?: string }
        return (r.code === 200 || resp.status === 200) ? { ok: true, detail: 'sent' } : { ok: false, detail: r.message ?? 'bark send failed' }
      }
      case 'serverchan': {
        // Server酱 Turbo 版推送
        const { loadStore } = await import('./gateway-store.ts')
        const store = await loadStore()
        const sendKey = target || store.platforms.serverchan?.sendKey
        if (!sendKey) return { ok: false, detail: 'missing serverchan sendkey' }
        const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: (opts.title ?? 'DSH Notification').slice(0, 32), desp: content }),
        })
        const r = (await resp.json().catch(() => ({}))) as { code?: number; message?: string }
        return r.code === 0 ? { ok: true, detail: 'sent' } : { ok: false, detail: r.message ?? 'serverchan send failed' }
      }
      case 'buzz': {
        if (this.buzz === null) return { ok: false, detail: 'buzz bridge not connected' }
        const sent = await this.buzz.send(target, text)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'buzz send failed' }
      }
      case 'qq':
        return { ok: false, detail: 'QQ 平台自 2025-04-21 起不支持主动推送（仅被动回复），无法发送主动消息' }
      default:
        return { ok: false, detail: `platform "${platform}" does not support push` }
    }
  }

  /**
   * 主动推送图片：向指定平台的目标会话发送图片。
   * - wecom-aibot: 自动上传临时素材并发送 image 消息
   * - telegram: 调用 sendPhoto（支持 Buffer 上传或图片 URL）
   * - discord: multipart 上传 files[0] 附件
   * - bark: 支持图片 URL 传入（通过 image 字段富文本横幅展示）
   * - dingtalk: 支持图片 URL（在 Markdown 中嵌入 ![]()）
   * - serverchan: 支持图片 URL（在 Markdown desp 中嵌入 ![]()）
   * - feishu / qq / email / 其它: 对不支持的二进制上传返回明确的官方协议限制原因
   *
   * @param platform 平台 id
   * @param target 目标（wecom-aibot=userid/群ID；telegram=chatId；discord=channelId；bark=deviceKey 等）
   * @param image 图片数据 Buffer 或可公网访问的图片 URL 字符串
   * @param opts.caption 可选文字说明
   * @param opts.filename 可选文件名（默认 image.png）
   */
  async pushImage(
    platform: string,
    target: string,
    image: Buffer | string,
    opts: { caption?: string; filename?: string } = {},
  ): Promise<{ ok: boolean; detail: string }> {
    const filename = opts.filename ?? 'image.png'
    const isUrl = typeof image === 'string' && /^https?:\/\//i.test(image.trim())
    const { loadStore } = await import('./gateway-store.ts')
    const store = await loadStore()
    if (store.enabled[platform] === false) return { ok: false, detail: `platform "${platform}" is disabled（已停用）` }

    switch (platform) {
      case 'wecom-aibot': {
        if (this.wecom === null) return { ok: false, detail: 'wecom-aibot bridge not connected' }
        if (typeof image === 'string') {
          // 若传入的是 URL，转为 Buffer 后上传临时素材
          try {
            const resp = await fetch(image, { signal: AbortSignal.timeout(20000) })
            if (!resp.ok) return { ok: false, detail: `failed to fetch image from url: HTTP ${resp.status}` }
            image = Buffer.from(await resp.arrayBuffer())
          } catch (err) {
            return { ok: false, detail: `fetch image url error: ${err instanceof Error ? err.message : String(err)}` }
          }
        }
        const sent = await this.wecom.sendImage(target, image, filename)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'wecom image send failed' }
      }

      case 'telegram': {
        if (this.telegram === null) return { ok: false, detail: 'telegram bridge not connected' }
        const chatId = Number(target)
        if (!Number.isInteger(chatId) || chatId <= 0) return { ok: false, detail: 'telegram target must be a numeric chatId' }
        const sent = await this.telegram.sendPhoto(chatId, image, opts.caption, filename)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'telegram photo send failed' }
      }

      case 'discord': {
        if (this.discord === null) return { ok: false, detail: 'discord bridge not connected' }
        let buf: Buffer
        if (typeof image === 'string') {
          try {
            const resp = await fetch(image, { signal: AbortSignal.timeout(20000) })
            if (!resp.ok) return { ok: false, detail: `failed to fetch image from url: HTTP ${resp.status}` }
            buf = Buffer.from(await resp.arrayBuffer())
          } catch (err) {
            return { ok: false, detail: `fetch image url error: ${err instanceof Error ? err.message : String(err)}` }
          }
        } else {
          buf = image
        }
        const sent = await this.discord.sendImage(target, buf, opts.caption, filename)
        return sent ? { ok: true, detail: 'sent' } : { ok: false, detail: 'discord image send failed' }
      }

      case 'bark': {
        // Bark 官方协议要求 image 为可下载的公网 URL
        if (!isUrl) {
          return { ok: false, detail: 'Bark only supports public image URLs (pass image as http/https URL string)' }
        }
        const { loadStore } = await import('./gateway-store.ts')
        const store = await loadStore()
        const server = (store.platforms.bark?.serverUrl || 'https://api.day.app').replace(/\/+$/, '')
        const deviceKey = target || store.platforms.bark?.deviceKey
        if (!deviceKey) return { ok: false, detail: 'missing bark device key' }
        const url = `${server}/${encodeURIComponent(deviceKey)}/`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: opts.caption ?? 'DSH Notification',
            body: opts.caption ? '' : '收到一张图片',
            image: image,
            group: 'DSH',
          }),
        })
        const r = (await resp.json().catch(() => ({}))) as { code?: number; message?: string }
        return (r.code === 200 || resp.status === 200) ? { ok: true, detail: 'sent' } : { ok: false, detail: r.message ?? 'bark send failed' }
      }

      case 'dingtalk': {
        // 钉钉自定义机器人仅支持在 markdown 中以 Markdown 图片语法渲染公网 URL
        if (!isUrl) {
          return { ok: false, detail: 'DingTalk custom robot only supports public image URLs via Markdown image tag' }
        }
        const caption = opts.caption ?? '图片'
        const mdText = `${caption ? `${caption}\n\n` : ''}![${filename}](${image})`
        return this.pushMessage('dingtalk', target, mdText, { title: opts.caption ?? '图片' })
      }

      case 'serverchan': {
        // Server酱仅支持在 Markdown desp 中以 Markdown 图片语法嵌入 URL
        if (!isUrl) {
          return { ok: false, detail: 'ServerChan only supports public image URLs via Markdown desp' }
        }
        const caption = opts.caption ?? '图片'
        const mdText = `${caption ? `${caption}\n\n` : ''}![${filename}](${image})`
        return this.pushMessage('serverchan', target, mdText, { title: opts.caption ?? '图片' })
      }

      case 'feishu':
        return { ok: false, detail: 'Feishu custom robot webhook does not support binary image upload without tenant_access_token (im/v1/images)' }

      case 'buzz':
        return { ok: false, detail: 'Buzz 平台暂不支持图片推送（协议无公开图片发布路径）' }

      case 'qq':
        return { ok: false, detail: 'QQ platform has discontinued active push API since 2025-04-21' }

      default:
        return { ok: false, detail: `platform "${platform}" does not support image push` }
    }
  }

  /**
   * 向已配置的 Outbound Webhooks 广播事件（异步投递，失败不阻塞）。
   */
  async broadcastEvent(event: string, payload: Record<string, unknown>): Promise<void> {
    const webhooks = this.config.outboundWebhooks ?? []
    if (webhooks.length === 0) return
    const { createHmac } = await import('node:crypto')
    const bodyStr = JSON.stringify({ event, timestamp: Date.now(), ...payload })
    for (const hook of webhooks) {
      const allowed = hook.events ?? ['*']
      if (!allowed.includes('*') && !allowed.includes(event)) continue
      void (async () => {
        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' }
          if (hook.secret) {
            headers['x-gateway-signature'] = createHmac('sha256', hook.secret).update(bodyStr, 'utf8').digest('hex')
          }
          await fetch(hook.url, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(10000) })
        } catch (error) {
          console.warn('[dsh-message-gateway] outbound webhook post failed', hook.url, String(error))
        }
      })()
    }
  }

  // ==================== Telegram / Discord / QQ / Email ====================

  private telegram: { start(): void; stop(): void; send(chatId: number, content: string): Promise<boolean>; sendPhoto(chatId: number, photo: Buffer | string, caption?: string, filename?: string): Promise<boolean>; status: BridgeStatus } | null = null
  private discord: { start(): void; stop(): void; send(channelId: string, content: string): Promise<boolean>; sendImage(channelId: string, image: Buffer, content?: string, filename?: string): Promise<boolean>; status: BridgeStatus } | null = null
  private qq: { start(): void; stop(): void; status: BridgeStatus } | null = null
  private email: { start(): void; stop(): void; send(to: string, subject: string, content: string): Promise<boolean>; status: BridgeStatus } | null = null
  private feishu: FeishuBridge | null = null
  private dingtalk: DingTalkBridge | null = null
  private wechat: WechatIlinkBridge | null = null
  private buzz: BuzzBridge | null = null

  /** 启动微信智能机器人桥（腾讯 iLink 官方协议长轮询）。 */
  startWechat(cred: Record<string, string>): void {
    this.wechat?.stop()
    const ilinkCred: WechatIlinkCred = {
      botToken: cred.botToken ?? '',
      baseUrl: cred.baseUrl,
      botId: cred.botId,
      userId: cred.userId,
      nickname: cred.nickname,
    }
    const bridge = new WechatIlinkBridge(ilinkCred, {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
    })
    this.wechat = bridge
    bridge.start()
  }

  /** 停止微信桥。 */
  stopWechat(): void {
    this.wechat?.stop()
    this.wechat = null
  }

  /** 启动 DingTalk 桥（企业自建应用 Stream 模式 WebSocket 长连接）。 */
  startDingTalk(cred: Record<string, string>): void {
    this.dingtalk?.stop()
    const bridge = new DingTalkBridge(
      { clientId: cred.clientId ?? '', clientSecret: cred.clientSecret ?? '', robotCode: cred.robotCode },
      {
        onStatus: (status) => this.onStatusCallback?.(status),
        onText: (text, frame, attachments) => {
          const identity: ChatIdentity = {
            key: `dingtalk:${frame.conversationId}`,
            frame,
            sink: {
              stream: (_f, _streamId, content, finish) => {
                // 钉钉 Stream 回调后，finish=true 时通过 sessionWebhook 进行 Markdown 定稿回复
                if (finish && content.trim() && frame.sessionWebhook) {
                  void bridge.replySession(frame.sessionWebhook, content)
                }
              },
              ack: false,
            },
            chatType: frame.chatType,
          }
          void this.handleExternalMessage(identity, text, attachments)
        },
      },
    )
    this.dingtalk = bridge
    bridge.start()
  }

  /** 停止 DingTalk 桥。 */
  stopDingTalk(): void {
    this.dingtalk?.stop()
    this.dingtalk = null
  }

  /** 启动 Feishu 桥（企业自建应用 WebSocket 长连接）。 */
  startFeishu(cred: Record<string, string>): void {
    this.feishu?.stop()
    const bridge = new FeishuBridge(
      { appId: cred.appId ?? '', appSecret: cred.appSecret ?? '' },
      {
        onStatus: (status) => this.onStatusCallback?.(status),
        onText: (text, frame, attachments) => {
          const identity: ChatIdentity = {
            key: `feishu:${frame.chatId}`,
            frame,
            sink: {
              stream: (_f, _streamId, content, finish) => {
                // 飞书采用引用回复或消息发送，finish=true 时发出完整定稿
                if (finish && content.trim()) {
                  void bridge.replyMessage(frame.messageId, content)
                }
              },
              ack: false,
            },
            chatType: frame.chatType,
          }
          void this.handleExternalMessage(identity, text, attachments)
        },
      },
    )
    this.feishu = bridge
    bridge.start()
  }

  /** 停止 Feishu 桥。 */
  stopFeishu(): void {
    this.feishu?.stop()
    this.feishu = null
  }

  /** 启动 Telegram 桥（长轮询）。 */
  startTelegram(cred: Record<string, string>): void {
    this.telegram?.stop()
    const bridge = new TelegramBridge(cred.token ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
    })
    this.telegram = bridge
    bridge.start()
  }

  /** 停止 Telegram 桥。 */
  stopTelegram(): void {
    this.telegram?.stop()
    this.telegram = null
  }

  /** 启动 Discord 桥（WebSocket 网关）。 */
  startDiscord(cred: Record<string, string>): void {
    this.discord?.stop()
    const bridge = new DiscordBridge(cred.token ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
    })
    this.discord = bridge
    bridge.start()
  }

  /** 停止 Discord 桥。 */
  stopDiscord(): void {
    this.discord?.stop()
    this.discord = null
  }

  /** 启动 QQ 桥（access_token + 网关）。 */
  startQQ(cred: Record<string, string>): void {
    this.qq?.stop()
    const bridge = new QQBridge(cred.appId ?? '', cred.secret ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
    })
    this.qq = bridge
    bridge.start()
  }

  /** 停止 QQ 桥。 */
  stopQQ(): void {
    this.qq?.stop()
    this.qq = null
  }

  /** 启动 Email 桥（IMAP 轮询 + SMTP 回复）。 */
  startEmail(cred: Record<string, string>): void {
    this.email?.stop()
    const emailCred: EmailCred = {
      imapHost: cred.imapHost ?? '',
      imapPort: cred.imapPort ?? '143',
      imapUser: cred.imapUser ?? '',
      imapPass: cred.imapPass ?? '',
      smtpHost: cred.smtpHost ?? undefined,
      smtpPort: cred.smtpPort ?? undefined,
      smtpUser: cred.smtpUser ?? undefined,
      smtpPass: cred.smtpPass ?? undefined,
    }
    const bridge = new EmailBridge(emailCred, {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
    })
    this.email = bridge
    bridge.start()
  }

  /** 停止 Email 桥。 */
  stopEmail(): void {
    this.email?.stop()
    this.email = null
  }

  /** 启动 Buzz 桥（NIP-42 WebSocket；凭据变化时先停旧桥；locale 决定状态文案语言）。 */
  startBuzz(cred: Record<string, string>, locale: BuzzLocale = 'en'): void {
    this.buzz?.stop()
    const bridge = new BuzzBridge(
      {
        nsec: cred.nsec ?? '',
        relay: cred.relay,
        channels: cred.channels,
        apiToken: cred.apiToken,
      },
      {
        onStatus: (status) => this.onStatusCallback?.(status),
        onText: (text, identity, attachments) => void this.handleExternalMessage(identity, text, attachments),
      },
      locale,
    )
    this.buzz = bridge
    bridge.start()
  }

  /** 停止 Buzz 桥（保留各频道会话上下文）。 */
  stopBuzz(): void {
    this.finishAllPending()
    this.buzz?.stop()
    this.buzz = null
  }

  /** 任意桥接平台的状态（telegram/discord/qq/email/feishu/dingtalk）。 */
  bridgeStatus(id: string): BridgeStatus {
    if (id === 'telegram') return this.telegram?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'discord') return this.discord?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'qq') return this.qq?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'email') return this.email?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'feishu') return this.feishu?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'dingtalk') return this.dingtalk?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'wechat') return this.wechat?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'buzz') return this.buzz?.status ?? { state: 'idle', detail: '', connectedAt: null }
    return { state: 'idle', detail: '', connectedAt: null }
  }

  /** 将桥状态并入存储状态。 */
  mergeStatus(stored: StoredStatus | undefined, id = 'wecom-aibot'): StoredStatus {
    const live = id === 'wecom-aibot' ? this.wecomStatus() : this.bridgeStatus(id)
    if (live.state === 'connected') {
      return { state: 'connected', detail: live.detail, testedAt: live.connectedAt ?? stored?.testedAt ?? null }
    }
    if (live.state === 'error') {
      return { state: 'error', detail: live.detail, testedAt: stored?.testedAt ?? null }
    }
    if (live.state === 'connecting') {
      // 桥正在（重）连接时如实显示「连接中」，不要沿用存储的旧状态（否则出现"已连接 · 连接中"）。
      return { state: 'connecting', detail: live.detail || '连接中…', testedAt: stored?.testedAt ?? null }
    }
    return stored ?? { state: 'none', detail: '', testedAt: null }
  }

  /**
   * 消息路由匹配：按「平台 + 关键词前缀」在配置的 routes 中找第一条命中。
   * @param key 聊天键（`platform:chatKey`）。
   * @param text 原始消息文本。
   * @returns 命中的规则与匹配到的前缀（前缀需从消息中剥离后进入路由）；未命中返回 null。
   */
  private matchRoute(key: string, text: string): { rule: NonNullable<GatewayConfig['routes']>[number]; prefix: string } | null {
    const platform = key.split(':')[0] ?? ''
    const routes = this.config.routes ?? []
    for (const rule of routes) {
      if (rule.matchPlatform !== undefined && rule.matchPlatform !== '' && rule.matchPlatform !== platform) continue
      const prefix = rule.matchPrefix ?? ''
      if (prefix !== '') {
        if (!text.startsWith(prefix)) continue
        return { rule, prefix }
      }
      // 无前缀要求：平台匹配即命中。
      return { rule, prefix: '' }
    }
    return null
  }

  /** 斜杠命令 / 关键词命令；已处理返回 true（不经 agent）。 */
  private async handleCommand(text: string, key: string, reply: (content: string) => void): Promise<boolean> {
    if (text === '/help' || text === '帮助' || text === '菜单' || text === '？' || text === '?') {
      reply(this.t('help'))
      return true
    }
    if (text === '/time' || text === '时间') {
      reply(`${this.t('timePrefix')} ${nowInShanghai()}（Asia/Shanghai）`)
      return true
    }
    if (text === '/new' || text === '/clear' || text === '新会话' || text === '清空会话') {
      const reset = await this.resetChat(key)
      reply(reset ? this.t('newOk') : this.t('newIdle'))
      return true
    }
    if (text === '/status' || text === '状态') {
      const dot = this.ctx.agents.list().length > 0 ? this.t('statusAvailable') : this.t('statusUnavailable')
      reply(
        `${this.t('statusTitle')}\n` +
        `- ${this.t('statusChats')}: ${this.chatCount()} 个\n` +
        `- ${this.t('statusAgent')}: ${dot}\n` +
        `- ${this.t('statusTime')}: ${nowInShanghai()}`
      )
      return true
    }
    if (text === '/stats' || text === '统计') {
      // 各平台桥状态 + 活跃路由数。
      const bridgeLine = (label: string, status: BridgeStatus): string => {
        const mark = status.state === 'connected' ? '🟢' : status.state === 'connecting' ? '🟡' : status.state === 'error' ? '🔴' : '⚪'
        return `- ${label}: ${mark} ${status.detail || status.state}`
      }
      const lines = [
        `${this.t('statusTitle')} /stats`,
        `- ${this.t('statusChats')}: ${this.chatCount()}`,
        bridgeLine('WeCom AI Bot', this.wecomStatus()),
        bridgeLine('Telegram', this.bridgeStatus('telegram')),
        bridgeLine('Discord', this.bridgeStatus('discord')),
        bridgeLine('QQ', this.bridgeStatus('qq')),
        bridgeLine('Email', this.bridgeStatus('email')),
        bridgeLine('Feishu', this.bridgeStatus('feishu')),
        bridgeLine('DingTalk', this.bridgeStatus('dingtalk')),
        bridgeLine('WeChat', this.bridgeStatus('wechat')),
        bridgeLine('Buzz', this.bridgeStatus('buzz')),
      ]
      reply(lines.join('\n'))
      return true
    }
    const wsPath = parseWorkspacePath(text)
    if (wsPath !== null) {
      await this.handleWorkspaceCommand(key, wsPath, reply)
      return true
    }
    return false
  }

  /**
   * `/workspace <目录>`（或 `工作区 <目录>`）：把已有目录注册为 DSH 工作区
   * （Web GUI 侧边栏「工作区」行立即可见，与官方「添加工作区」同服务），
   * 并把本聊天后续会话的工作目录切换到该目录（重置当前上下文，下一条消息生效）。
   * 需配置 allowWorkspace 开启（默认关闭，防外部消息渠道越权注册目录）。
   */
  private async handleWorkspaceCommand(key: string, rawPath: string, reply: (content: string) => void): Promise<void> {
    if (this.config.allowWorkspace !== true) {
      reply(this.t('wsDisabled'))
      return
    }
    if (rawPath === '') {
      reply(this.t('wsUsage'))
      return
    }
    // ~ 展开 + 相对路径按宿主进程 cwd 解析，再 realpath 归一（要求目录已存在）。
    const expanded = rawPath.startsWith('~') ? pathJoin(homedir(), rawPath.slice(1)) : rawPath
    let real: string
    try {
      real = await fsPromises.realpath(pathResolve(process.cwd(), expanded))
    } catch (error) {
      reply(`${this.t('wsInvalid')}（${error instanceof Error ? error.message : String(error)}）`)
      return
    }
    try {
      if (!(await fsPromises.stat(real)).isDirectory()) throw new Error('not a directory')
    } catch (error) {
      reply(`${this.t('wsInvalid')}（${error instanceof Error ? error.message : String(error)}）`)
      return
    }
    const registry = (this.ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
      | WorkspaceRegistryLike
      | undefined
    if (registry === undefined || typeof registry.create !== 'function') {
      reply(this.t('wsFail'))
      return
    }
    try {
      await registry.create(real)
    } catch (error) {
      reply(`${this.t('wsFail')}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 切换本聊天工作目录：释放现有会话上下文，后续会话以该目录为 cwd 创建。
    await this.resetChat(key)
    this.chatCwds.set(key, real)
    console.log('[dsh-message-gateway] workspace switched', { key, cwd: real })
    reply(this.t('wsOk').replace('{path}', real))
  }

  /**
   * 需要 agent 的指令分派（内置命令已由 handleCommand 处理）：
   * - 整条消息只是 `@查询` → 回文件/文件夹浏览列表（与 Web @ 补全同数据源）
   * - `/commands` → 列出 Web 指令注册表（与 / 面板一致）
   * - `/files <查询>`（或 `文件 <查询>`）→ 浏览工作区文件
   * - `/model` / `/effort` → 本聊天模型与思考力度切换
   * - 其它 `/指令名 …` → 透传执行 Web 指令（成功文本作为用户消息进入会话）
   * 返回 reply=已回复；run=用返回文本作为用户消息；none=不是指令，原样进模型。
   */
  private async dispatchAgentCommand(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    text: string,
    reply: (content: string) => void,
  ): Promise<AgentCommandOutcome> {
    const trimmed = text.trim()

    // @ 文件浏览：整条消息只是一个 @ 引用（含引号形式）时回列表；其余 @ 消息原样进模型。
    const browse = /^@(?:"([^"]*)"|'([^']*)'|([^\s]*))$/.exec(trimmed)
    if (browse !== null) {
      await this.listFilesForKey(key, route, (browse[1] ?? browse[2] ?? browse[3] ?? '').trim(), reply)
      return { status: 'reply' }
    }

    const m = /^\/([A-Za-z0-9_-]+)(?:\s+(.*))?$/.exec(trimmed)
    if (m === null) return { status: 'none' }
    const name = m[1] ?? ''
    const arg = (m[2] ?? '').trim()

    if (name === 'commands') {
      await this.listCommandsForKey(key, route, reply)
      return { status: 'reply' }
    }
    if (name === 'files' || /^文件(?:\s+(.*))?$/.test(trimmed)) {
      const query = name === 'files' ? arg : (/^文件(?:\s+(.*))?$/.exec(trimmed)?.[1] ?? '').trim()
      await this.listFilesForKey(key, route, query, reply)
      return { status: 'reply' }
    }
    if (name === 'model') {
      await this.handleModelCommand(key, route, arg, reply)
      return { status: 'reply' }
    }
    if (name === 'effort') {
      await this.handleEffortCommand(key, route, arg, reply)
      return { status: 'reply' }
    }
    // 其余 /指令名 → 走 Web 指令注册表（与 / 面板共用）。
    return this.runWebCommand(key, route, trimmed, reply)
  }

  /** `/commands`：列出当前聊天 agent 可见的 Web 指令描述符。 */
  private async listCommandsForKey(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    reply: (content: string) => void,
  ): Promise<void> {
    const agent = await this.ensureAgentForKey(key, route)
    if (agent === null) {
      reply(this.t('noAgent'))
      return
    }
    const commands = (this.ctx as { get?: (name: string) => unknown }).get?.('commands') as CommandsRuntimeLike | undefined
    if (commands === undefined || typeof commands.list !== 'function') {
      reply(this.t('cmdUnavailable'))
      return
    }
    const items = commands.list(agent)
    if (items.length === 0) {
      reply(this.t('cmdListEmpty'))
      return
    }
    const lines = items.slice(0, 30).map((item) => `- \`/${item.name}\` → ${item.description}`)
    reply(this.t('cmdListTitle') + lines.join('\n'))
  }

  /** `/files <查询>` 与 `@查询` 浏览：用 Web @ 补全同一数据源列出匹配文件/文件夹。 */
  private async listFilesForKey(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    query: string,
    reply: (content: string) => void,
  ): Promise<void> {
    const agent = await this.ensureAgentForKey(key, route)
    if (agent === null) {
      reply(this.t('noAgent'))
      return
    }
    const refs = (this.ctx as { get?: (name: string) => unknown }).get?.('fileReferences') as FileReferencesLike | undefined
    if (refs === undefined || typeof refs.list !== 'function') {
      reply(this.t('filesUnavailable'))
      return
    }
    let candidates: Array<{ path: string; kind: 'file' | 'directory' }> = []
    try {
      candidates = await refs.list(agent, query, AbortSignal.timeout(15_000))
    } catch (error) {
      console.warn('[dsh-message-gateway] file browse failed', String(error))
      candidates = []
    }
    if (candidates.length === 0) {
      reply(this.t('filesEmpty'))
      return
    }
    const lines = candidates.slice(0, 20).map((candidate) => (candidate.kind === 'directory' ? `- 📁 ${candidate.path}/` : `- 📄 ${candidate.path}`))
    reply(this.t('filesTitle') + lines.join('\n'))
  }

  /** `/model [provider model effort]`：本聊天模型切换（校验供应商/模型/思考力度）。 */
  private async handleModelCommand(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    arg: string,
    reply: (content: string) => void,
  ): Promise<void> {
    const llm = (this.ctx as { get?: (name: string) => unknown }).get?.('llm') as LlmServiceLike | undefined
    if (llm === undefined) {
      reply(this.t('modelUnavailable'))
      return
    }
    if (arg === '') {
      await this.replyModelList(llm, reply)
      return
    }
    if (arg === 'reset' || arg === 'default') {
      const slot = this.chatModels.get(key) ?? { picked: undefined as ModelSelection | undefined }
      slot.picked = undefined
      this.chatModels.set(key, slot)
      reply(this.t('modelReset'))
      return
    }
    const parts = arg.split(/\s+/)
    const provider = parts[0] ?? ''
    const model = parts[1] ?? ''
    const effort = parts[2]
    if (model === '') {
      reply(this.t('modelUsage'))
      return
    }
    const providers = llm.listProviders()
    if (!providers.some((p) => p.id === provider)) {
      reply(this.t('modelInvalidProvider').replace('{provider}', provider))
      return
    }
    let models: Array<{ id: string }> = []
    try {
      models = await llm.listModels(provider)
    } catch (error) {
      console.warn('[dsh-message-gateway] listModels failed', String(error))
    }
    if (!models.some((mo) => mo.id === model)) {
      reply(this.t('modelInvalidModel').replace('{provider}', provider).replace('{model}', model))
      return
    }
    let efforts: string[] = []
    if (effort !== undefined && effort !== '') {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        efforts = (info.reasoning?.efforts ?? []).map((e) => e.id)
      } catch (error) {
        console.warn('[dsh-message-gateway] resolveModelInfo failed', String(error))
      }
      if (!efforts.includes(effort)) {
        reply(this.t('modelInvalidEffort')
          .replace('{provider}', provider)
          .replace('{model}', model)
          .replace('{effort}', effort)
          .replace('{efforts}', efforts.join(', ') || '-'))
        return
      }
    }
    const slot = this.chatModels.get(key) ?? { picked: undefined as ModelSelection | undefined }
    slot.picked = {
      provider,
      model,
      ...(effort !== undefined && effort !== '' ? { reasoningEffort: effort as unknown as ModelSelection['reasoningEffort'] } : {}),
    }
    this.chatModels.set(key, slot)
    console.log('[dsh-message-gateway] chat model switched', { key, provider, model, effort })
    let replyText = this.t('modelOk')
      .replace('{provider}', provider)
      .replace('{model}', model)
      .replace('{effort}', effort !== undefined && effort !== '' ? ` · effort ${effort}` : '')
    // 未指定思考力度时，附带该模型的可选力度列表（用户可随后 /effort 选择）。
    if (effort === undefined || effort === '') {
      const lines = await this.effortLinesFor(llm, provider, model)
      if (lines.length > 0) replyText += `\n${lines.join('\n')}`
    }
    reply(replyText)
  }

  /** `/effort <id>`：本聊天思考力度切换（作用于当前选定的模型）。 */
  private async handleEffortCommand(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    arg: string,
    reply: (content: string) => void,
  ): Promise<void> {
    const llm = (this.ctx as { get?: (name: string) => unknown }).get?.('llm') as LlmServiceLike | undefined
    if (llm === undefined) {
      reply(this.t('modelUnavailable'))
      return
    }
    const slot = this.chatModels.get(key) ?? { picked: undefined as ModelSelection | undefined }
    this.chatModels.set(key, slot)
    if (arg === '') {
      // 不带参数：列出当前模型的思考力度（含默认标记）。
      const current = slot.picked ?? this.resolveDefaultModel(route)
      if (current === undefined) {
        reply(this.t('modelUnavailable'))
        return
      }
      const lines = await this.effortLinesFor(llm, current.provider, current.model)
      if (lines.length === 0) {
        reply(this.t('effortListNone'))
        return
      }
      reply(this.t('effortListTitle').replace('{provider}', current.provider).replace('{model}', current.model) + lines.join('\n'))
      return
    }
    if (arg === 'reset') {
      slot.picked = undefined
      reply(this.t('effortReset'))
      return
    }
    const current = slot.picked ?? this.resolveDefaultModel(route)
    if (current === undefined) {
      reply(this.t('modelUnavailable'))
      return
    }
    let efforts: string[] = []
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      efforts = (info.reasoning?.efforts ?? []).map((e) => e.id)
    } catch (error) {
      console.warn('[dsh-message-gateway] resolveModelInfo failed', String(error))
    }
    if (!efforts.includes(arg)) {
      reply(this.t('effortInvalid').replace('{effort}', arg).replace('{efforts}', efforts.join(', ') || '-'))
      return
    }
    slot.picked = { ...current, reasoningEffort: arg as unknown as ModelSelection['reasoningEffort'] }
    console.log('[dsh-message-gateway] chat effort switched', { key, effort: arg })
    reply(this.t('effortOk')
      .replace('{effort}', arg)
      .replace('{provider}', current.provider)
      .replace('{model}', current.model))
  }

  /** 列出可用供应商与模型（紧凑格式，适合聊天窗口）。 */
  private async replyModelList(llm: LlmServiceLike, reply: (content: string) => void): Promise<void> {
    const providers = llm.listProviders()
    if (providers.length === 0) {
      reply(this.t('modelNone'))
      return
    }
    const lines: string[] = []
    for (const provider of providers.slice(0, 10)) {
      let models: Array<{ id: string }> = []
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        console.warn('[dsh-message-gateway] listModels failed', String(error))
      }
      const ids = models.slice(0, 6).map((mo) => mo.id).join(', ')
      lines.push(`- \`${provider.id}\`: ${ids}${models.length > 6 ? ` (+${models.length - 6} more)` : ''}`)
    }
    reply(this.t('modelListTitle') + lines.join('\n'))
  }

  /** 取某模型可选思考力度的展示行（含默认标记）；模型未暴露力度时返回空数组。 */
  private async effortLinesFor(llm: LlmServiceLike, provider: string, model: string): Promise<string[]> {
    let info: Awaited<ReturnType<LlmServiceLike['resolveModelInfo']>>
    try {
      info = await llm.resolveModelInfo(provider, model)
    } catch (error) {
      console.warn('[dsh-message-gateway] resolveModelInfo failed', String(error))
      return []
    }
    const efforts = info.reasoning?.efforts ?? []
    if (efforts.length === 0) return []
    const defaultEffort = info.reasoning?.defaultEffort
    return efforts.map((e) => `- \`${e.id}\` → ${e.name}${e.id === defaultEffort ? this.t('effortDefaultSuffix') : ''}`)
  }

  /** 透传执行 Web 指令注册表里的 /指令名（与 Web / 面板共用同一注册表）。 */
  private async runWebCommand(
    key: string,
    route: NonNullable<GatewayConfig['routes']>[number] | undefined,
    line: string,
    reply: (content: string) => void,
  ): Promise<AgentCommandOutcome> {
    const agent = await this.ensureAgentForKey(key, route)
    if (agent === null) {
      reply(this.t('noAgent'))
      return { status: 'reply' }
    }
    const commands = (this.ctx as { get?: (name: string) => unknown }).get?.('commands') as CommandsRuntimeLike | undefined
    if (commands === undefined || typeof commands.execute !== 'function') {
      // 无指令服务：不拦截，原样交给模型（保持兼容）。
      return { status: 'none' }
    }
    let outcome: Awaited<ReturnType<CommandsRuntimeLike['execute']>>
    try {
      outcome = await commands.execute(agent, line, AbortSignal.timeout(30_000))
    } catch (error) {
      reply(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
      return { status: 'reply' }
    }
    if (outcome === undefined) return { status: 'none' }
    if (outcome.result.kind === 'error') {
      reply(`⚠️ ${outcome.result.text}`)
      return { status: 'reply' }
    }
    const text = outcome.result.text ?? ''
    if (text.trim() === '') {
      reply(this.t('cmdDone'))
      return { status: 'reply' }
    }
    console.log('[dsh-message-gateway] web command executed', { key, line: sanitizeSecrets(line.slice(0, 40)) })
    return { status: 'run', text }
  }
}

/** 从 assistant 消息中提取纯文本（text 块拼接）。 */
function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
}

/** 整段消息是否只是 XML 工具调用（模型以文本形式输出工具调用时，不能当回复发出）。 */
function isToolCallOnly(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('<tool_calls>') && trimmed.endsWith('</tool_calls>')) return true
  // 宽松匹配：整段只有工具调用标签（允许前后少量空白）。
  return /^<tool_calls>[\s\S]*<\/tool_calls>\s*$/.test(trimmed)
}

/** 去掉消息开头的 @机器人名（群聊提及）。 */
function stripMention(content: string): string {
  const text = content.trim()
  if (text.startsWith('@')) {
    const space = text.indexOf(' ')
    // 只剥离开头的 @提及（token 不超过 64 字符），其余原样保留。
    if (space !== -1 && space <= 64) return text.slice(space + 1).trim()
  }
  return text
}

/**
 * 解析工作区指令：`/workspace <目录>` 或 `工作区 <目录>`。
 * 命中返回目录参数（无参数返回 ''）；未命中返回 null。
 */
function parseWorkspacePath(text: string): string | null {
  const trimmed = text.trim()
  const slash = /^\/workspace(?:\s+(.*))?$/.exec(trimmed)
  if (slash !== null) return (slash[1] ?? '').trim()
  const cn = /^工作区(?:\s*(.*))?$/.exec(trimmed)
  if (cn !== null) return (cn[1] ?? '').trim()
  return null
}

/** 当前上海时间（Asia/Shanghai）。 */
function nowInShanghai(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date())
}