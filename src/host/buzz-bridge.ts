/**
 * Buzz（Nostr 工作区）机器人桥：NIP-42 认证 WebSocket 长连接。
 *
 * 协议事实（对照 block/buzz + hermes-agent / deer-flow 两个生产级适配器，
 * 均已在真实 relay 上验证）：
 * - 订阅必须是「频道级」：每个频道一条 REQ {"kinds":[9], "#h":[uuid]}；
 *   全局 kinds:[9] 订阅会被 EOSE 但永远收不到消息，多值 #h 不生效。
 * - 频道发现：历史 REQ kinds:[39000]（元数据 d=频道id / t=类型 / name=名称）；
 *   实时成员变化：REQ kinds:[44100,44101] #p=本机 pubkey（since=now-60s 回看）。
 * - 出站：kind-9 聊天事件（tags: h 频道 / e 回复目标 / p 提及），
 *   流式体验 = 先发占位 kind-9，再以 kind-40003 就地编辑（仅 h+e 标签），
 *   relay 编辑内容上限 64KB，故每条 ≤ 60000 字节；超长回复分块，
 *   编辑承载第 0 块，其余块以 e→线程根 的追加 kind-9 发出。
 * - CLOSED 帧：认证完成前 auth-required 是正常引导流程（AUTH 成功后统一重开）；
 *   认证后被关 = 故障，每订阅最多重订阅 3 次（0/1/2s 退避），重连时全量重建。
 * - relay 每订阅历史上限 2000 条且最新优先（即使带 since）：断开期间的积压
 *   按此边界有界跳过（已文档化）。
 * - 门控：只处理 @提及（p 标签含本机 pubkey）/ DM 频道（元数据 type=dm）/
 *   本机线程中的回复（e 根为本机事件）；忽略本机 pubkey 的事件（防自循环）。
 * - 入站附件走 NIP-92 imeta 标签（url/sha256/m），下载后校验 SHA-256，20MB 上限。
 * - 出站文本原样发布（deer-flow 已验证 relay 不做 @token 预检，那是 CLI 行为）。
 *
 * 加密/签名/编码全部使用 nostr-tools（pure + nip19）；传输层沿用本仓库
 * Discord/QQ 桥的原生/undici WebSocket 模式，以获得代理支持与逐订阅
 * CLOSED 恢复能力。Buzz 尚处 pre-1.0，所有 kind 常量集中在本文件顶部。
 * @module dsh-message-gateway/host/buzz-bridge
 */

import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'
import type { IncomingAttachment } from './incoming.ts'
import { downloadBytes } from './incoming.ts'
import { getProxyDispatcher } from './proxy.ts'
import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { WebSocket as UndiciWebSocket } from 'undici'

/** Buzz 事件 kind（pre-1.0，集中管理以便上游变更时快速适配）。 */
const KIND_CHAT = 9
const KIND_EDIT = 40003
const KIND_AUTH = 22242
const KIND_CHANNEL_META = 39000
const KIND_MEMBER_ADDED = 44100
const KIND_MEMBER_REMOVED = 44101

/** 流式编辑限频（对齐其它平台约 1 次/秒）。 */
const EDIT_INTERVAL_MS = 1200
/** relay 编辑内容上限 64KB，留安全边距。 */
const EDIT_MAX_BYTES = 60_000
/** 入站附件上限（hermes 同款）。 */
const ATTACH_MAX_BYTES = 20 * 1024 * 1024
const ATTACH_MAX_COUNT = 4
/** 事件去重集合上限（LRU）。 */
const SEEN_CAP = 500
/** 单连接频道订阅上限（refuse + log，不驱逐现有订阅）。 */
const MAX_CHANNEL_SUBSCRIPTIONS = 256
/** 单订阅被 CLOSED 后的重订阅预算。 */
const MAX_RESUBSCRIBE_ATTEMPTS = 3
/** 成员变化订阅的回看窗口（秒）：覆盖连接/认证握手期间的成员变更。 */
const MEMBERSHIP_LOOKBACK_SECONDS = 60
/** 断线重连退避。 */
const RECONNECT_DELAY_MS = 3000

const DISCOVERY_SUB = 'buzz-discovery'
const MEMBERSHIP_SUB = 'buzz-membership'
const chatSubId = (uuid: string): string => `buzz-chat-${uuid}`

/** Buzz 面向 UI 的文案语言（跟随消息平台页当前语言；缺省 zh）。 */
export type BuzzLocale = 'zh' | 'en' | 'es'

/** Buzz 测试结果 / 桥状态文案（会展示在消息平台页，必须跟随 UI 语言）。 */
const BUZZ_TEXT: Record<BuzzLocale, {
  invalidNsec: string
  testTimeout: string
  testRejected: string
  testClosed: string
  testError: string
  authOk: (npub: string) => string
  connected: (npub: string, count: number) => string
  reconnecting: (seconds: number) => string
  closed: (reason: string) => string
}> = {
  zh: {
    invalidNsec: 'nsec 无效：需要 nsec1… 或 64 位 hex 私钥',
    testTimeout: '连接超时',
    testRejected: '认证被拒绝',
    testClosed: '连接已关闭',
    testError: '连接错误',
    authOk: (npub) => `认证成功 · npub ${npub}…`,
    connected: (npub, count) => `npub ${npub}… · ${count} 频道`,
    reconnecting: (seconds) => `连接断开，${seconds} 秒后重连`,
    closed: (reason) => `订阅被关闭: ${reason}`,
  },
  en: {
    invalidNsec: 'Invalid nsec: expected nsec1… or a 64-hex private key',
    testTimeout: 'Connection timed out',
    testRejected: 'Authentication rejected',
    testClosed: 'Connection closed',
    testError: 'Connection error',
    authOk: (npub) => `Auth OK · npub ${npub}…`,
    connected: (npub, count) => `npub ${npub}… · ${count} channel${count === 1 ? '' : 's'}`,
    reconnecting: (seconds) => `Disconnected, reconnecting in ${seconds}s`,
    closed: (reason) => `Subscription closed: ${reason}`,
  },
  es: {
    invalidNsec: 'nsec no válida: se espera nsec1… o una clave hex de 64 dígitos',
    testTimeout: 'Tiempo de conexión agotado',
    testRejected: 'Autenticación rechazada',
    testClosed: 'Conexión cerrada',
    testError: 'Error de conexión',
    authOk: (npub) => `Autenticación OK · npub ${npub}…`,
    connected: (npub, count) => `npub ${npub}… · ${count} canal${count === 1 ? '' : 'es'}`,
    reconnecting: (seconds) => `Desconectado, reconectando en ${seconds}s`,
    closed: (reason) => `Suscripción cerrada: ${reason}`,
  },
}

function buzzText(locale: BuzzLocale): (typeof BUZZ_TEXT)[BuzzLocale] {
  return BUZZ_TEXT[locale] ?? BUZZ_TEXT.zh
}

/** Buzz 平台凭据（字段名与平台表单一致）。 */
export interface BuzzCred {
  /** Agent 私钥：nsec1… 或 64 位 hex。 */
  nsec: string
  /** relay 地址（http(s):// 自动转 ws(s)://；缺省 ws://localhost:3000）。 */
  relay?: string
  /** 可选：逗号分隔的频道 UUID 白名单（留空自动发现全部成员频道）。 */
  channels?: string
  /** 可选：relay 启用 Token 认证时填写（作为 ?token= 查询参数附带）。 */
  apiToken?: string
}

/** 桥回调（与其它平台一致：状态 + 归一化文本/附件）。 */
export interface BuzzBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity, attachments?: IncomingAttachment[]): void
}

/** 单条聊天消息的回复定位信息。 */
export interface BuzzFrame {
  channelId: string
  eventId: string
  /** 直接回复目标（e 标签首项；无则为空串）。 */
  replyTo: string
  /** 原消息作者 pubkey。 */
  author: string
  /** 该频道是否为 DM 频道（元数据 type=dm）。 */
  dm: boolean
  /** 回复时需要 p 提及的 pubkey 列表（原消息作者 + 其他被提及者）。 */
  mentionPubkeys: string[]
}

/** 极简 Nostr 事件结构（入站校验用；字段名与 NIP-01 一致）。 */
interface NostrEventLike {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** 提取某标签名的全部值。 */
function tagValues(tags: string[][], name: string): string[] {
  const out: string[] = []
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === 'string') out.push(tag[1])
  }
  return out
}

/** 按 UTF-8 字节数分块（编辑/占位事件受 64KB relay 上限约束）。 */
export function chunkText(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  const chunks: string[] = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    let cut = rest.length
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), 'utf8') > maxBytes) cut -= 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** 解析 nsec（nsec1… 或 64 位 hex）→ 私钥字节；非法返回 null。 */
export function parseBuzzSecretKey(nsec: string): Uint8Array | null {
  const value = (nsec ?? '').trim()
  if (value === '') return null
  if (value.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'nsec') return decoded.data
    } catch {
      /* 非法 bech32 */
    }
    return null
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  return null
}

/** 私钥 → npub（展示/注册用，绝不落日志与接口响应之外的明文）。 */
export function npubForSecretKey(sk: Uint8Array): string {
  return nip19.npubEncode(getPublicKey(sk))
}

/** 归一化 relay 地址：http(s)→ws(s)，可选附加 ?token= 查询参数。 */
export function relayWsUrl(relay: string | undefined, apiToken?: string): string {
  const base = (relay ?? '').trim() === '' ? 'ws://localhost:3000' : (relay ?? '').trim()
  let url = base
  if (url.startsWith('http://')) url = `ws://${url.slice(7)}`
  else if (url.startsWith('https://')) url = `wss://${url.slice(8)}`
  const token = (apiToken ?? '').trim()
  if (token !== '') url += `${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  return url
}

/** 构建 NIP-42 AUTH 事件（kind 22242：relay + challenge 标签，空内容）。 */
export function buildAuthEvent(sk: Uint8Array, relayUrl: string, challenge: string): NostrEventLike {
  const event = finalizeEvent(
    {
      kind: KIND_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['relay', relayUrl], ['challenge', challenge]],
      content: '',
    },
    sk,
  )
  return event as unknown as NostrEventLike
}

/** 新生成的密钥对（UI「生成密钥对」按钮使用；只返回一次，不落盘）。 */
export function generateBuzzKeypair(): { nsec: string; npub: string } {
  const sk = generateSecretKey()
  return { nsec: nip19.nsecEncode(sk), npub: nip19.npubEncode(getPublicKey(sk)) }
}

/** 连接测试：建连 → 触发/完成 NIP-42 AUTH → 等待 OK true。文案跟随 UI 语言。 */
export async function testBuzzConnection(cred: BuzzCred, locale: BuzzLocale = 'zh', timeoutMs = 12_000): Promise<{ ok: boolean; detail: string }> {
  const T = buzzText(locale)
  const sk = parseBuzzSecretKey(cred.nsec)
  if (sk === null) return { ok: false, detail: T.invalidNsec }
  const url = relayWsUrl(cred.relay, cred.apiToken)
  return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let ws: WebSocket | UndiciWebSocket | null = null
    let authEventId: string | null = null
    let settled = false
    const settle = (result: { ok: boolean; detail: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        /* 忽略 */
      }
      resolve(result)
    }
    const timer = setTimeout(() => settle({ ok: false, detail: T.testTimeout }), timeoutMs)
    void (async () => {
      try {
        const dispatcher = await getProxyDispatcher()
        ws = dispatcher ? new UndiciWebSocket(url, { dispatcher } as never) : new WebSocket(url)
      } catch (error) {
        settle({ ok: false, detail: error instanceof Error ? error.message : String(error) })
        return
      }
      const target = ws
      target.onopen = () => {
        // 先发一个 REQ 触发 relay 的认证流程（relay 会回 auth-required CLOSED + AUTH 挑战）。
        try {
          target.send(JSON.stringify(['REQ', 'buzz-test', { kinds: [KIND_CHANNEL_META], limit: 1 }]))
        } catch {
          /* 忽略 */
        }
      }
      target.onmessage = (event: { data: unknown }) => {
        let msg: unknown
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!Array.isArray(msg)) return
        if (msg[0] === 'AUTH' && typeof msg[1] === 'string') {
          const authEvent = buildAuthEvent(sk, url, msg[1])
          authEventId = authEvent.id
          try {
            target.send(JSON.stringify(['AUTH', authEvent]))
          } catch {
            /* 忽略 */
          }
          return
        }
        if (msg[0] === 'OK' && authEventId !== null && msg[1] === authEventId) {
          if (msg[2] === true) {
            settle({ ok: true, detail: T.authOk(npubForSecretKey(sk).slice(0, 16)) })
          } else {
            settle({ ok: false, detail: String(msg[3] ?? T.testRejected) })
          }
        }
      }
      target.onerror = () => settle({ ok: false, detail: T.testError })
      target.onclose = () => settle({ ok: false, detail: T.testClosed })
    })()
  })
}

export class BuzzBridge {
  private ws: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private secretKey: Uint8Array | null = null
  private pubkey = ''
  private npub = ''
  private relayUrl = ''
  private authOk = false
  private authEventId: string | null = null
  /** subId → 过滤条件 + 已重订阅次数。 */
  private subs = new Map<string, { filters: Record<string, unknown>; attempts: number }>()
  /** 频道元数据缓存（uuid → type/name；远程投喂，有界）。 */
  private channelMeta = new Map<string, { type: string; name: string }>()
  /** 已知频道集合（= 已打开聊天订阅的集合）。 */
  private channels = new Set<string>()
  /** 入站事件去重（eventId → 时间戳，LRU）。 */
  private seen = new Map<string, number>()
  /** 本机已发布事件（线程跟随门控用，LRU）。 */
  private myEvents = new Map<string, number>()
  /** streamId → 已发出的占位事件（渐进编辑目标）。 */
  private streams = new Map<string, { channelId: string; eventId: string; lastEdit: number; chunks: number }>()
  /** streamId → 最新待推送内容（流式合并，单 worker 消费）。 */
  private state = new Map<string, { content: string; finish: boolean }>()
  private working = new Set<string>()
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: BuzzCred,
    private readonly callbacks: BuzzBridgeCallbacks,
    private readonly locale: BuzzLocale = 'zh',
  ) {}

  private T(): (typeof BUZZ_TEXT)[BuzzLocale] {
    return buzzText(this.locale)
  }

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = { state, detail, connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt }
    this.callbacks.onStatus(this.status)
  }

  private npubShort(): string {
    return this.npub.slice(0, 12)
  }

  /** 可选频道白名单；未配置返回 null（自动发现全部）。 */
  private allowlist(): Set<string> | null {
    const raw = (this.cred.channels ?? '').trim()
    if (raw === '') return null
    return new Set(raw.split(',').map((item) => item.trim()).filter((item) => item !== ''))
  }

  start(): void {
    const sk = parseBuzzSecretKey(this.cred.nsec)
    if (sk === null) {
      this.setStatus('error', this.T().invalidNsec)
      console.warn('[dsh-message-gateway] buzz start aborted: invalid nsec')
      return
    }
    if (!this.stopped && this.ws !== null) return
    this.stopped = false
    this.secretKey = sk
    this.pubkey = getPublicKey(sk)
    this.npub = nip19.npubEncode(this.pubkey)
    this.relayUrl = relayWsUrl(this.cred.relay, this.cred.apiToken)
    this.setStatus('connecting', 'NIP-42 认证中')
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    void (async () => {
      let ws: WebSocket | UndiciWebSocket
      try {
        const dispatcher = await getProxyDispatcher()
        ws = dispatcher ? new UndiciWebSocket(this.relayUrl, { dispatcher } as never) : new WebSocket(this.relayUrl)
      } catch (error) {
        console.error('[dsh-message-gateway] buzz ws create failed', error)
        this.setStatus('error', 'ws create failed')
        return
      }
      this.ws = ws as WebSocket
      ws.onopen = () => {
        console.log('[dsh-message-gateway] buzz ws open', this.relayUrl)
        this.setStatus('connecting', 'NIP-42 认证中')
        this.authOk = false
        this.authEventId = null
        // 先开控制订阅（部分 relay 允许未认证读；被拒则等 AUTH 成功后统一重开）。
        this.sendReq(DISCOVERY_SUB, { kinds: [KIND_CHANNEL_META] })
        this.sendReq(MEMBERSHIP_SUB, {
          kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED],
          '#p': [this.pubkey],
          since: Math.floor(Date.now() / 1000) - MEMBERSHIP_LOOKBACK_SECONDS,
        })
        // 重连时重建已知频道的聊天订阅（since=now：仅实时消息，历史按 relay 2000 条上限有界跳过）。
        for (const uuid of [...this.channels]) {
          this.sendReq(chatSubId(uuid), { kinds: [KIND_CHAT], '#h': [uuid], since: Math.floor(Date.now() / 1000) })
        }
      }
      ws.onmessage = (event: { data: unknown }) => this.onMessage(String(event.data))
      ws.onerror = () => console.warn('[dsh-message-gateway] buzz ws error')
      ws.onclose = () => {
        this.ws = null
        this.authOk = false
        this.authEventId = null
        if (this.stopped) return
        this.setStatus('error', this.T().reconnecting(RECONNECT_DELAY_MS / 1000))
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
      }
    })()
  }

  private sendReq(subId: string, filters: Record<string, unknown>): void {
    if (this.ws === null) return
    this.subs.set(subId, { filters, attempts: 0 })
    try {
      this.ws.send(JSON.stringify(['REQ', subId, filters]))
    } catch (error) {
      console.warn('[dsh-message-gateway] buzz REQ failed', subId, String(error))
    }
  }

  private onMessage(raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const kind = msg[0]
    if (kind === 'AUTH') {
      // ['AUTH', challenge]：应答 NIP-42 挑战。
      const challenge = String(msg[1] ?? '')
      if (this.secretKey === null || challenge === '') return
      const authEvent = buildAuthEvent(this.secretKey, this.relayUrl, challenge)
      this.authEventId = authEvent.id
      try {
        this.ws?.send(JSON.stringify(['AUTH', authEvent]))
      } catch {
        /* 忽略 */
      }
      return
    }
    if (kind === 'OK') {
      // ['OK', id, ok, message]：AUTH 结果或普通事件回执。
      if (this.authEventId !== null && msg[1] === this.authEventId) {
        this.authEventId = null
        if (msg[2] === true) {
          this.authOk = true
          this.setStatus('connected', this.T().connected(this.npubShort(), this.channels.size))
          // 认证成功：重开所有此前被 auth-required 关掉的订阅（REQ 同 id 幂等替换）。
          for (const [subId, sub] of [...this.subs.entries()]) this.sendReq(subId, sub.filters)
        } else {
          this.setStatus('error', String(msg[3] ?? '认证被拒绝'))
        }
      }
      return
    }
    if (kind === 'EVENT') {
      // ['EVENT', subId, event]
      void this.onEvent(msg[2] as unknown as Record<string, unknown>)
      return
    }
    if (kind === 'CLOSED') {
      this.onClosed(String(msg[1] ?? ''), String(msg[2] ?? ''))
      return
    }
    if (kind === 'EOSE') return
    if (kind === 'NOTICE') {
      console.warn('[dsh-message-gateway] buzz relay notice', String(msg[1] ?? ''))
    }
  }

  /** 订阅被 relay 关闭：认证前 auth-required 属正常引导；认证后按预算重订阅。 */
  private onClosed(subId: string, reason: string): void {
    const sub = this.subs.get(subId)
    if (sub === undefined) return
    if (!this.authOk && reason.startsWith('auth-required')) return
    if (sub.attempts >= MAX_RESUBSCRIBE_ATTEMPTS) {
      console.warn('[dsh-message-gateway] buzz subscription closed permanently', { subId, reason })
      this.setStatus('error', this.T().closed(reason))
      return
    }
    sub.attempts += 1
    const delay = (sub.attempts - 1) * 1000
    setTimeout(() => {
      if (this.stopped || this.ws === null) return
      if (this.subs.get(subId) !== sub) return
      this.sendReq(subId, sub.filters)
    }, delay)
  }

  private async onEvent(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null) return
    const e = raw as Record<string, unknown>
    if (
      typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.kind !== 'number' ||
      typeof e.created_at !== 'number' || !Array.isArray(e.tags) || typeof e.content !== 'string' ||
      typeof e.sig !== 'string'
    ) return
    // relay 输入不可信：id 重算 + BIP-340 签名双校验，非法一律丢弃。
    const event = raw as unknown as NostrEventLike
    try {
      if (!verifyEvent(event as never)) return
    } catch {
      return
    }
    const tags = e.tags as string[][]
    if (e.kind === KIND_CHANNEL_META) {
      this.onChannelMeta(tags)
      return
    }
    if (e.kind === KIND_MEMBER_ADDED || e.kind === KIND_MEMBER_REMOVED) {
      this.onMembership(e.kind, tags)
      return
    }
    if (e.kind === KIND_CHAT) {
      await this.onChatEvent(event, tags)
    }
    // 其它 kind（流 / 论坛等）暂不处理。
  }

  /** kind-39000 频道元数据：d=频道id，t=类型（缺省 stream），name=名称。 */
  private onChannelMeta(tags: string[][]): void {
    const d = tagValues(tags, 'd')
    if (d.length === 0) return
    const id = d[0]
    const types = tagValues(tags, 't')
    const names = tagValues(tags, 'name')
    this.channelMeta.set(id, { type: types[0] ?? 'stream', name: names[0] ?? '' })
    while (this.channelMeta.size > 512) {
      const oldest = this.channelMeta.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.channelMeta.delete(oldest)
    }
    this.openChannel(id)
  }

  /** kind-44100/44101 成员变化：p=受影响成员，h=频道 uuid。 */
  private onMembership(kind: number, tags: string[][]): void {
    if (this.pubkey === '' || !tagValues(tags, 'p').includes(this.pubkey)) return
    const h = tagValues(tags, 'h')
    if (h.length === 0) return
    const id = h[0]
    if (kind === KIND_MEMBER_ADDED) {
      this.openChannel(id)
      // 重新触发发现以补上新频道的 type/name（DM 判定依赖元数据）。
      this.sendReq(DISCOVERY_SUB, { kinds: [KIND_CHANNEL_META] })
    } else {
      this.channels.delete(id)
      this.channelMeta.delete(id)
      this.subs.delete(chatSubId(id))
      try {
        this.ws?.send(JSON.stringify(['CLOSE', chatSubId(id)]))
      } catch {
        /* 忽略 */
      }
    }
  }

  private openChannel(id: string): void {
    if (this.channels.has(id)) return
    const allow = this.allowlist()
    if (allow !== null && !allow.has(id)) return
    if (this.channels.size >= MAX_CHANNEL_SUBSCRIPTIONS) {
      console.warn('[dsh-message-gateway] buzz channel subscription cap reached, refusing', id)
      return
    }
    this.channels.add(id)
    this.sendReq(chatSubId(id), { kinds: [KIND_CHAT], '#h': [id], since: Math.floor(Date.now() / 1000) })
  }

  private async onChatEvent(event: NostrEventLike, tags: string[][]): Promise<void> {
    if (event.pubkey === this.pubkey) return // 防自循环：自己的消息绝不处理
    const h = tagValues(tags, 'h')
    if (h.length === 0 || !this.channels.has(h[0])) return
    const channelId = h[0]
    // 去重（重连/重订阅会重放窗口内事件）。
    if (this.seen.has(event.id)) return
    this.seen.set(event.id, Date.now())
    while (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    // 门控：@提及（p 含本机）/ DM 频道 / 本机线程中的回复（e 根为本机事件）。
    const pTags = tagValues(tags, 'p')
    const mentioned = pTags.includes(this.pubkey)
    const meta = this.channelMeta.get(channelId)
    const isDm = meta?.type === 'dm'
    const eTags = tagValues(tags, 'e')
    const inMyThread = eTags.some((id) => this.myEvents.has(id))
    if (!mentioned && !isDm && !inMyThread) return

    // 附件：门控通过后才下载（最多 4 个、20MB、SHA-256 校验）。
    const attachments = await this.collectAttachments(tags)
    let text = event.content.trim()
    const notes: string[] = []
    for (const note of attachments.notes) notes.push(note)
    if (text === '' && notes.length > 0) text = notes.join('\n')
    text = stripOwnMention(text)
    if (text === '' && attachments.list.length === 0) return

    const mentionPubkeys = [event.pubkey, ...pTags.filter((p) => p !== this.pubkey && p !== event.pubkey)].slice(0, 8)
    const frame: BuzzFrame = {
      channelId,
      eventId: event.id,
      replyTo: eTags[0] ?? '',
      author: event.pubkey,
      dm: isDm,
      mentionPubkeys,
    }
    const sink: ReplySink = {
      stream: (f, sid, content, finish) => void this.streamReply(f as BuzzFrame, sid, content, finish),
    }
    const identity: ChatIdentity = {
      key: `buzz:${channelId}`,
      frame,
      sink,
      chatType: isDm ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] buzz text', {
      channelId,
      mentioned,
      dm: isDm,
      thread: inMyThread,
      text: text.slice(0, 60),
    })
    this.callbacks.onText(text, identity, attachments.list.length > 0 ? attachments.list : undefined)
  }

  /** NIP-92 imeta 附件下载：url/sha256/m；失败给用户可见说明，绝不静默丢弃。 */
  private async collectAttachments(tags: string[][]): Promise<{ list: IncomingAttachment[]; notes: string[] }> {
    const list: IncomingAttachment[] = []
    const notes: string[] = []
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'imeta') continue
      if (list.length >= ATTACH_MAX_COUNT) break
      const meta = parseImeta(tag.slice(1))
      const url = meta.url ?? ''
      if (url === '' || !/^https?:\/\//i.test(url)) continue
      try {
        const data = await downloadBytes(url, { maxBytes: ATTACH_MAX_BYTES })
        if (meta.sha256 !== undefined && meta.sha256 !== '') {
          const actual = createHash('sha256').update(Buffer.from(data)).digest('hex')
          if (actual.toLowerCase() !== meta.sha256.toLowerCase()) throw new Error('附件 SHA-256 校验失败')
        }
        const mime = meta.mime ?? ''
        list.push({
          kind: mime.startsWith('image/') ? 'image' : 'file',
          data,
          mediaType: mime === '' ? undefined : mime,
          name: meta.alt ?? urlBasename(url),
        })
      } catch (error) {
        notes.push(`（附件「${meta.alt ?? urlBasename(url)}」下载失败：${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    return { list, notes }
  }

  /** 流式回复：先发 kind-9 占位，随后 kind-40003 渐进编辑（限频 + 分块）。 */
  private async streamReply(frame: BuzzFrame, streamId: string, content: string, finish: boolean): Promise<void> {
    const prev = this.state.get(streamId)
    this.state.set(streamId, { content, finish: finish || (prev?.finish ?? false) })
    if (this.working.has(streamId)) return
    this.working.add(streamId)
    try {
      for (let guard = 0; guard < 200; guard += 1) {
        const current = this.state.get(streamId)
        if (current === undefined) break
        const text = current.content === '' ? ' ' : current.content
        const existing = this.streams.get(streamId)
        if (existing === undefined) {
          if (current.content === '' && !current.finish) break
          // 占位同样受 64KB relay 上限约束：第 0 块承载占位，溢出块立刻以线程消息追加。
          const chunks = chunkText(text, EDIT_MAX_BYTES)
          const eventId = this.publishChat(frame.channelId, chunks[0] ?? '', frame.replyTo, frame.mentionPubkeys)
          if (eventId === null) break
          for (let i = 1; i < chunks.length; i += 1) {
            this.publishChat(frame.channelId, chunks[i], frame.replyTo, [])
          }
          this.streams.set(streamId, { channelId: frame.channelId, eventId, lastEdit: Date.now(), chunks: chunks.length })
          if (current.finish || this.state.get(streamId)!.content === current.content) break
          continue
        }
        const wait = EDIT_INTERVAL_MS - (Date.now() - existing.lastEdit)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        existing.lastEdit = Date.now()
        const ok = await this.pushChunked(frame, existing, text)
        if (!ok && current.finish) {
          this.streams.delete(streamId)
          break
        }
        if (current.finish || this.state.get(streamId)!.content === current.content) break
      }
    } catch (error) {
      console.error('[dsh-message-gateway] buzz reply failed', error)
    } finally {
      this.working.delete(streamId)
    }
  }

  /** 分块推送：第 0 块就地编辑；新溢出的块以线程消息追加（按块数去重，不重复发尾块）。 */
  private async pushChunked(
    frame: BuzzFrame,
    existing: { channelId: string; eventId: string; lastEdit: number; chunks: number },
    text: string,
  ): Promise<boolean> {
    const chunks = chunkText(text, EDIT_MAX_BYTES)
    if (this.publishEdit(existing.channelId, existing.eventId, chunks[0] ?? '') === null) return false
    for (let i = existing.chunks; i < chunks.length; i += 1) {
      this.publishChat(frame.channelId, chunks[i], frame.replyTo, [])
    }
    existing.chunks = Math.max(existing.chunks, chunks.length)
    return true
  }

  private publishEvent(kind: number, tags: string[][], content: string): string | null {
    if (this.secretKey === null || this.ws === null) return null
    const event = finalizeEvent(
      { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
      this.secretKey,
    )
    try {
      this.ws.send(JSON.stringify(['EVENT', event]))
      // 本机事件登记（线程跟随门控），LRU 有界。
      this.myEvents.set(event.id, Date.now())
      while (this.myEvents.size > SEEN_CAP) {
        const oldest = this.myEvents.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.myEvents.delete(oldest)
      }
      return event.id
    } catch (error) {
      console.warn('[dsh-message-gateway] buzz EVENT failed', kind, String(error))
      return null
    }
  }

  private publishChat(channelId: string, content: string, replyTo: string, mentions: string[]): string | null {
    const tags: string[][] = [['h', channelId]]
    if (replyTo !== '') tags.push(['e', replyTo])
    for (const pubkey of new Set(mentions)) tags.push(['p', pubkey])
    return this.publishEvent(KIND_CHAT, tags, content)
  }

  private publishEdit(channelId: string, targetEventId: string, content: string): string | null {
    // kind-40003 编辑只带 h + e 标签（对齐 deer-flow 的 build_edit_event）。
    return this.publishEvent(KIND_EDIT, [['h', channelId], ['e', targetEventId]], content)
  }

  /** 主动推送：向指定频道发一条普通 kind-9 消息（供 pushMessage / 工具调用）。 */
  async send(channelUuid: string, content: string): Promise<boolean> {
    return this.publishChat(channelUuid, content, '', []) !== null
  }

  /** 停止长连接（保留会话上下文由 BridgeManager 管理）。 */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
    this.ws = null
    this.authOk = false
    this.authEventId = null
    this.subs.clear()
    this.channels.clear()
    this.channelMeta.clear()
    this.seen.clear()
    this.myEvents.clear()
    this.streams.clear()
    this.state.clear()
    this.working.clear()
    this.setStatus('idle')
  }
}

/** 解析 imeta 条目（'key value' 对）。 */
function parseImeta(entries: string[]): { url?: string; sha256?: string; mime?: string; alt?: string } {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const idx = entry.indexOf(' ')
    if (idx <= 0) continue
    out[entry.slice(0, idx)] = entry.slice(idx + 1).trim()
  }
  return { url: out.url, sha256: out.sha256, mime: out.m, alt: out.alt }
}

function urlBasename(url: string): string {
  const clean = url.split('?')[0] ?? url
  const name = clean.split('/').pop() ?? ''
  return name === '' ? 'attachment' : name
}

/** 剥离消息开头的 @提及（保守策略：仅当只有单个前缀 @token 时剥离，不猜多提及）。 */
function stripOwnMention(content: string): string {
  const text = content.trim()
  if (!text.startsWith('@')) return text
  const space = text.indexOf(' ')
  if (space === -1) return text
  if (text.slice(space + 1).trimStart().startsWith('@')) return text
  return text.slice(space + 1).trim()
}
