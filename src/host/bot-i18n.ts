/**
 * 机器人回复文案（host 侧 i18n）：语言由插件配置 botLocale 决定，
 * 让任何语言环境的安装者都能使用本插件。
 * @module dsh-message-gateway/host/bot-i18n
 */

import type { BotLocale } from '../core/config.ts'

type Messages = Record<string, string>

const MSGS: Record<BotLocale, Messages> = {
  zh: {
    ack: '正在处理…',
    busy: '⏳ 上一条消息还在处理中，请稍后再试',
    noAgent: '⚠️ DSH 助手暂不可用，请稍后再试',
    welcome:
      '您好！我是智能助手 🤖\n\n' +
      '- 直接发消息和我 AI 对话\n' +
      '- 每个聊天自动拥有独立会话，上下文超长自动压缩，和 Web 对话一致\n' +
      '- 输入 /help 查看全部指令',
    help:
      '🤖 **智能助手指令**\n' +
      '- 直接发消息 → AI 对话（与 Web 一致：独立会话 + 自动压缩）\n' +
      '- `/new` 或 `/clear` → 开启新会话（清空本聊天上下文）\n' +
      '- `/time` → 当前时间\n' +
      '- `/status` → 查看机器人状态\n' +
      '- `/workspace <目录>`（或 `工作区 <目录>`）→ 把目录添加为工作区并切换本聊天的工作目录（需开启 allowWorkspace）\n' +
      '- `/commands` → 列出全部指令（与 Web 的 / 面板一致）\n' +
      '- `/<指令名> …` → 直接执行任意 Web 指令（如 /plan、/goal）\n' +
      '- `/files <前缀>` → 浏览工作区文件/文件夹（单独发 `@` 或 `@前缀` 也可浏览）\n' +
      '- `@路径` → 引用工作区文件（与 Web 的 @ 提及一致）\n' +
      '- `/model [provider model effort]` → 切换本聊天的模型与思考力度（`/model` 列出可选）\n' +
      '- `/effort [id]` → 设置思考力度（不带参数列出可选；`/effort reset` 恢复默认）\n' +
      '- `/help` → 查看指令',
    newOk: '✅ 已开启新会话，之前的对话上下文已清空',
    newIdle: 'ℹ️ 当前会话已是新会话',
    timeout: '⚠️ 回复超时了，请稍后再试一次',
    statusTitle: '📡 **机器人状态**',
    statusOnline: '✅ 在线',
    statusOffline: '❌ 离线',
    statusBotId: 'BotID',
    statusChats: '活跃会话',
    statusAgent: 'DSH 助手',
    statusTime: '时间',
    statusAvailable: '可用',
    statusUnavailable: '不可用',
    timePrefix: '🕐',
    stepLoading: '⏳ 正在处理中，请稍候…',
    wsDisabled: '⚠️ 工作区指令未启用：请在插件配置中开启 allowWorkspace',
    wsUsage: 'ℹ️ 用法：`/workspace <目录>` 或 `工作区 <目录>`（目录需已存在）',
    wsInvalid: '⚠️ 目录无效（不存在或不是文件夹）',
    wsFail: '⚠️ 工作区服务不可用或注册失败',
    wsOk: '✅ 已把「{path}」添加为工作区，本聊天后续会话将在该目录中运行（下一条消息生效）',
    cmdListTitle: '🤖 **指令列表**（与 Web 的 / 面板一致）\n',
    cmdListEmpty: 'ℹ️ 当前没有可用指令',
    cmdUnavailable: '⚠️ 指令服务不可用（部署未挂载 dsh-commands）',
    cmdDone: '✅ 指令已执行',
    filesTitle: '📂 匹配的文件/文件夹：\n',
    filesEmpty: 'ℹ️ 没有匹配的文件/文件夹',
    filesUnavailable: '⚠️ 文件浏览服务不可用（部署未挂载 fileReferences）',
    modelUsage: 'ℹ️ 用法：`/model <provider> <model> [effort]`；单独 `/model` 列出可选模型',
    modelUnavailable: '⚠️ 模型服务不可用（无法列出/切换模型）',
    modelNone: 'ℹ️ 当前没有可用模型',
    modelListTitle: '🧠 **可用模型**（用 `/model <provider> <model> [effort]` 切换）\n',
    modelOk: '✅ 本聊天模型已切换为 {provider} / {model}{effort}（下一条消息生效）',
    modelInvalidProvider: '⚠️ 未找到供应商 "{provider}"，用 `/model` 查看列表',
    modelInvalidModel: '⚠️ 供应商 "{provider}" 下没有模型 "{model}"',
    modelInvalidEffort: '⚠️ 模型 {provider}/{model} 不支持思考力度 "{effort}"（可用：{efforts}）',
    modelReset: '✅ 已恢复默认模型配置',
    effortUsage: 'ℹ️ 用法：`/effort <id>`；`/effort reset` 恢复默认；单独 `/effort` 列出可选力度',
    effortOk: '✅ 思考力度已设为 "{effort}"（{provider}/{model}）',
    effortInvalid: '⚠️ 当前模型不支持思考力度 "{effort}"（可用：{efforts}）',
    effortReset: '✅ 思考力度已恢复默认',
    effortListTitle: '🧠 **思考力度**（{provider}/{model}）\n',
    effortListNone: 'ℹ️ 该模型未暴露可选思考力度（使用模型默认）',
    effortDefaultSuffix: '（默认）',
  },
  en: {
    ack: 'Processing…',
    busy: '⏳ Still processing your previous message, please wait',
    noAgent: '⚠️ DSH assistant is unavailable, please try again later',
    welcome:
      'Hi! I am your AI assistant 🤖\n\n' +
      '- Chat with me directly\n' +
      '- Each chat gets its own session; long contexts are auto-compressed, same as the web\n' +
      '- Type /help for all commands',
    help:
      '🤖 **Assistant commands**\n' +
      '- Send a message → AI chat (same as web: own session + auto compression)\n' +
      '- `/new` or `/clear` → start a new session (clear this chat context)\n' +
      '- `/time` → current time\n' +
      '- `/status` → bot status\n' +
      '- `/workspace <path>` → register a folder as a workspace and switch this chat to it (requires allowWorkspace)\n' +
      '- `/commands` → list all commands (same as the web / palette)\n' +
      '- `/<name> …` → run any web command (e.g. /plan, /goal)\n' +
      '- `/files <prefix>` → browse workspace files/folders (sending just `@` or `@prefix` also browses)\n' +
      '- `@path` → reference workspace files (same as web @ mentions)\n' +
      '- `/model [provider model effort]` → pick model & effort for this chat (`/model` alone lists options)\n' +
      '- `/effort [id]` → set reasoning effort (bare lists them; `/effort reset` for default)\n' +
      '- `/help` → this help',
    newOk: '✅ New session started, previous context cleared',
    newIdle: 'ℹ️ This chat already has a fresh session',
    timeout: '⚠️ Reply timed out, please try again in a moment',
    statusTitle: '📡 **Bot status**',
    statusOnline: '✅ Online',
    statusOffline: '❌ Offline',
    statusBotId: 'Bot ID',
    statusChats: 'Active chats',
    statusAgent: 'DSH assistant',
    statusTime: 'Time',
    statusAvailable: 'available',
    statusUnavailable: 'unavailable',
    timePrefix: '🕐',
    stepLoading: '⏳ Processing, please wait…',
    wsDisabled: '⚠️ Workspace command is disabled: enable allowWorkspace in the plugin config',
    wsUsage: 'ℹ️ Usage: `/workspace <path>` (the folder must already exist)',
    wsInvalid: '⚠️ Invalid folder: the path does not exist or is not a directory',
    wsFail: '⚠️ Workspace service unavailable or registration failed',
    wsOk: '✅ Folder "{path}" registered as a workspace; this chat now runs in it (from the next message)',
    cmdListTitle: '🤖 **Commands** (same as the web / palette)\n',
    cmdListEmpty: 'ℹ️ No commands available',
    cmdUnavailable: '⚠️ Command service unavailable (dsh-commands not mounted)',
    cmdDone: '✅ Command executed',
    filesTitle: '📂 Matching files/folders:\n',
    filesEmpty: 'ℹ️ No matching files or folders',
    filesUnavailable: '⚠️ File browsing service unavailable (fileReferences not mounted)',
    modelUsage: 'ℹ️ Usage: `/model <provider> <model> [effort]`; `/model` alone lists options',
    modelUnavailable: '⚠️ Model service unavailable (cannot list/switch models)',
    modelNone: 'ℹ️ No models available',
    modelListTitle: '🧠 **Available models** (switch with `/model <provider> <model> [effort]`)\n',
    modelOk: '✅ This chat now uses {provider} / {model}{effort} (from the next message)',
    modelInvalidProvider: '⚠️ Provider "{provider}" not found — run `/model` to list options',
    modelInvalidModel: '⚠️ Provider "{provider}" has no model "{model}"',
    modelInvalidEffort: '⚠️ {provider}/{model} does not support effort "{effort}" (available: {efforts})',
    modelReset: '✅ Model selection reset to default',
    effortUsage: 'ℹ️ Usage: `/effort <id>`; `/effort reset` for default; `/effort` alone lists available efforts',
    effortOk: '✅ Reasoning effort set to "{effort}" ({provider}/{model})',
    effortInvalid: '⚠️ Current model does not support effort "{effort}" (available: {efforts})',
    effortReset: '✅ Reasoning effort reset to default',
    effortListTitle: '🧠 **Reasoning efforts** ({provider}/{model})\n',
    effortListNone: 'ℹ️ This model exposes no selectable reasoning efforts (model default applies)',
    effortDefaultSuffix: ' (default)',
  },
  es: {
    ack: 'Procesando…',
    busy: '⏳ Todavía se está procesando su mensaje anterior, por favor espere',
    noAgent: '⚠️ El asistente de DSH no está disponible en este momento',
    welcome:
      '¡Hola! Soy su asistente de IA 🤖\n\n' +
      '- Chatea conmigo directamente\n' +
      '- Cada chat tiene su propia sesión con compresión automática\n' +
      '- Escriba /help para ver los comandos',
    help:
      '🤖 **Comandos del Asistente**\n' +
      '- Enviar mensaje → Chat con IA\n' +
      '- `/new` o `/clear` → Iniciar nueva sesión\n' +
      '- `/time` → Hora actual\n' +
      '- `/status` → Estado del bot\n' +
      '- `/workspace <ruta>` → registrar una carpeta como espacio de trabajo y cambiar este chat a ella (requiere allowWorkspace)\n' +
      '- `/commands` → listar todos los comandos (igual que la paleta / de la web)\n' +
      '- `/<nombre> …` → ejecutar cualquier comando web (p. ej. /plan, /goal)\n' +
      '- `/files <prefijo>` → explorar archivos/carpetas del espacio de trabajo (enviar solo `@` o `@prefijo` también explora)\n' +
      '- `@ruta` → referenciar archivos del espacio de trabajo (igual que las menciones @ de la web)\n' +
      '- `/model [proveedor modelo esfuerzo]` → elegir modelo y esfuerzo para este chat (`/model` solo lista opciones)\n' +
      '- `/effort [id]` → establecer el esfuerzo de razonamiento (sin argumentos los lista; `/effort reset` para el valor por defecto)\n' +
      '- `/help` → Ayuda',
    newOk: '✅ Nueva sesión iniciada, contexto anterior borrado',
    newIdle: 'ℹ️ Este chat ya tiene una sesión limpia',
    timeout: '⚠️ Se agotó el tiempo de espera, intente de nuevo',
    statusTitle: '📡 **Estado del Bot**',
    statusOnline: '✅ En línea',
    statusOffline: '❌ Desconectado',
    statusBotId: 'ID del Bot',
    statusChats: 'Chats activos',
    statusAgent: 'Asistente DSH',
    statusTime: 'Hora',
    statusAvailable: 'disponible',
    statusUnavailable: 'no disponible',
    timePrefix: '🕐',
    stepLoading: '⏳ Procesando, por favor espere…',
    wsDisabled: '⚠️ Comando de espacio de trabajo desactivado: active allowWorkspace en la configuración del plugin',
    wsUsage: 'ℹ️ Uso: `/workspace <ruta>` (la carpeta debe existir)',
    wsInvalid: '⚠️ Carpeta no válida: la ruta no existe o no es un directorio',
    wsFail: '⚠️ Servicio de espacios de trabajo no disponible o el registro falló',
    wsOk: '✅ Carpeta "{path}" registrada como espacio de trabajo; este chat ahora se ejecuta en ella (desde el próximo mensaje)',
    cmdListTitle: '🤖 **Comandos** (igual que la paleta / de la web)\n',
    cmdListEmpty: 'ℹ️ No hay comandos disponibles',
    cmdUnavailable: '⚠️ Servicio de comandos no disponible (dsh-commands no montado)',
    cmdDone: '✅ Comando ejecutado',
    filesTitle: '📂 Archivos/carpetas coincidentes:\n',
    filesEmpty: 'ℹ️ No hay archivos o carpetas coincidentes',
    filesUnavailable: '⚠️ Servicio de exploración de archivos no disponible (fileReferences no montado)',
    modelUsage: 'ℹ️ Uso: `/model <proveedor> <modelo> [esfuerzo]`; `/model` solo lista opciones',
    modelUnavailable: '⚠️ Servicio de modelos no disponible (no se pueden listar/cambiar modelos)',
    modelNone: 'ℹ️ No hay modelos disponibles',
    modelListTitle: '🧠 **Modelos disponibles** (cambie con `/model <proveedor> <modelo> [esfuerzo]`)\n',
    modelOk: '✅ Este chat ahora usa {provider} / {model}{effort} (desde el próximo mensaje)',
    modelInvalidProvider: '⚠️ Proveedor "{provider}" no encontrado — use `/model` para listar opciones',
    modelInvalidModel: '⚠️ El proveedor "{provider}" no tiene el modelo "{model}"',
    modelInvalidEffort: '⚠️ {provider}/{model} no admite el esfuerzo "{effort}" (disponibles: {efforts})',
    modelReset: '✅ Selección de modelo restablecida al valor por defecto',
    effortUsage: 'ℹ️ Uso: `/effort <id>`; `/effort reset` para el valor por defecto; `/effort` solo lista los esfuerzos disponibles',
    effortOk: '✅ Esfuerzo de razonamiento establecido en "{effort}" ({provider}/{model})',
    effortInvalid: '⚠️ El modelo actual no admite el esfuerzo "{effort}" (disponibles: {efforts})',
    effortReset: '✅ Esfuerzo de razonamiento restablecido al valor por defecto',
    effortListTitle: '🧠 **Esfuerzos de razonamiento** ({provider}/{model})\n',
    effortListNone: 'ℹ️ Este modelo no expone esfuerzos de razonamiento seleccionables (aplica el valor por defecto del modelo)',
    effortDefaultSuffix: ' (por defecto)',
  },
}

/** 取当前语言的文案；语言缺失/未知时一律回退默认语言 English（与配置默认一致）。 */
export function botText(locale: BotLocale | undefined, key: string): string {
  const table = MSGS[locale ?? 'en'] ?? MSGS.en
  return table[key] ?? key
}