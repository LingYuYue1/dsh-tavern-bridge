/**
 * Tavern Bridge — 让 DSH 通过局域网操作酒馆（SillyTavern / TauriTavern）
 * ----------------------------------------------------------------------
 * 酒馆本身没有对外 SDK，但它所有功能都在 `/api/*` 下，且是同一套 REST 形状。
 * 这个插件把这些端点包成 DSH 工具，让 agent 能：
 *   读角色卡 / 读聊天 / 改角色卡 / 读世界书 / 改世界书 / 直接生成一段正文
 *
 * 设计要点：
 *   1. **不依赖酒馆侧装插件**。只用酒馆原生 `/api/*`，TT 这种社区二创也能用。
 *   2. **CSRF 自动处理**。酒馆默认开 CSRF，`getRequestHeaders()` 会带 `X-CSRF-Token`；
 *      这里在首次请求时抓一次 `/csrf-token`，之后自动带上，过期自动重取。
 *   3. **多实例**。配置里可以存多个酒馆地址（电脑一个、手机一个），工具参数 `target` 选。
 *   4. **只读优先**。默认不提供删除类工具；写操作单独标注、需要显式调用。
 *
 * 已知边界：
 *   - 酒馆的 `/api/chats/get` 需要 `avatar_url` + `file_name`，不是聊天 id。
 *   - 世界书按「名字」取，不是按 id。
 *   - TT 的部分端点可能和上游有差异，所以每个工具都做了形状校验并给出可读错误。
 *
 * @module dsh-tavern-bridge
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Stable Loader identity. */
const name = 'tavern-bridge';

/** 只依赖 tools 服务。 */
const inject = ['tools'];

const DEFAULT_TIMEOUT = 20000;

/** 一个酒馆实例。 */
const Target = z.object({
    /** 显示名，工具里用它选实例。 */
    name: z.string().default('default'),
    /** 形如 http://192.168.1.20:8000 */
    url: z.string().default('http://127.0.0.1:8000'),
    /** 若酒馆开了 basicAuth，填这里（可选）。 */
    username: z.string().default(''),
    password: z.string().default(''),
});

const Config = z.object({
    /** 多个酒馆实例。 */
    targets: z.array(Target).default([
        { name: 'default', url: 'http://127.0.0.1:8000', username: '', password: '' },
    ]),
    /** 单次请求超时。 */
    timeoutMs: z.number().default(DEFAULT_TIMEOUT),
    /** 允许写操作（改角色卡 / 改世界书 / 保存聊天）。默认关，防止误改。 */
    allowWrite: z.boolean().default(false),
    /** 允许触发生成（会消耗模型额度）。默认关。 */
    allowGenerate: z.boolean().default(false),
});

/* ------------------------------ HTTP 基础 ------------------------------ */

/** 每个实例的会话状态：CSRF token + 服务端下发的 session cookie。 */
const sessionCache = new Map();

function normalizeBase(url) {
    let text = String(url || '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
    return text.replace(/\/+$/, '');
}

function basicAuthHeader(target) {
    if (!target?.username) return {};
    const raw = target.username + ':' + (target.password || '');
    return { Authorization: 'Basic ' + Buffer.from(raw, 'utf8').toString('base64') };
}

/**
 * 取（或刷新）CSRF token。
 *
 * 🔴 关键：酒馆的 CSRF token 存在 **cookie session** 里。
 * `/csrf-token` 会通过 `Set-Cookie: session-xxx=...` 下发一个 session，
 * token 本身是这个 session 的一个字段。所以：
 *   1. 必须保存并回传那个 cookie
 *   2. 拿 token 和用 token 必须用同一个 session
 * 不带 cookie 只带 token → 一律 403 Invalid CSRF token。
 */
async function csrfSession(target, timeoutMs) {
    const base = normalizeBase(target.url);
    const cached = sessionCache.get(base);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;

    const empty = { token: '', cookie: '', at: Date.now() };
    try {
        const response = await fetch(base + '/csrf-token', {
            headers: { ...basicAuthHeader(target) },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return empty;
        const json = await response.json();
        const token = String(json?.token || '');
        // 把 Set-Cookie 全部收集起来（session + 签名 cookie，两个都要）
        const cookies = [];
        try {
            for (const raw of response.headers.getSetCookie?.() || []) {
                const pair = String(raw).split(';')[0];
                if (pair.includes('=')) cookies.push(pair);
            }
        } catch { /* 老 node 没有 getSetCookie，退回单条 */ }
        if (!cookies.length) {
            const single = response.headers.get('set-cookie');
            if (single) {
                for (const part of single.split(/,(?=\s*[^;=]+=)/)) {
                    const pair = part.split(';')[0].trim();
                    if (pair.includes('=')) cookies.push(pair);
                }
            }
        }
        const session = { token, cookie: cookies.join('; '), at: Date.now() };
        sessionCache.set(base, session);
        return session;
    } catch {
        return empty;
    }
}

/** 一次请求，自动带 CSRF / session cookie / Basic Auth，返回解析后的 JSON。 */
async function call(target, path, { method = 'POST', body = {}, timeoutMs = DEFAULT_TIMEOUT, retryOn403 = true } = {}) {
    const base = normalizeBase(target.url);
    if (!base) throw new Error('没有配置酒馆地址');
    const session = await csrfSession(target, timeoutMs);
    const headers = {
        'Content-Type': 'application/json',
        ...basicAuthHeader(target),
    };
    if (session.token && session.token !== 'disabled') headers['X-CSRF-Token'] = session.token;
    if (session.cookie) headers.Cookie = session.cookie;

    let response;
    try {
        response = await fetch(base + path, {
            method,
            headers,
            body: method === 'GET' ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const reason = String(error?.message || error);
        if (/timeout|aborted/i.test(reason)) throw new Error('请求酒馆超时：确认酒馆在跑、地址对、手机和电脑在同一局域网');
        if (/fetch failed|ECONNREFUSED/i.test(reason)) throw new Error('连不上酒馆（' + base + '）：确认地址端口，以及酒馆的 listen / whitelist 允许局域网访问');
        throw new Error('请求酒馆失败：' + reason);
    }

    // session 过期 / token 失效：丢掉缓存重取一次
    if (response.status === 403 && retryOn403) {
        sessionCache.delete(base);
        return call(target, path, { method, body, timeoutMs, retryOn403: false });
    }

    const text = await response.text();
    if (!response.ok) {
        const hint = response.status === 403 ? '（多半是 CSRF 或 basicAuth）' : '';
        throw new Error('酒馆返回 ' + response.status + hint + '：' + text.slice(0, 300));
    }
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** 按名字取实例。 */
function pickTarget(config, targetName) {
    const list = Array.isArray(config.targets) ? config.targets : [];
    if (!list.length) throw new Error('没有配置任何酒馆实例');
    if (!targetName) return list[0];
    const found = list.find(item => String(item.name) === String(targetName));
    if (!found) {
        throw new Error('没有名为「' + targetName + '」的酒馆实例。已配置：' + list.map(item => item.name).join('、'));
    }
    return found;
}

/** 写操作守卫。 */
function assertWrite(config, what) {
    if (!config.allowWrite) {
        throw new Error('写操作被关闭（' + what + '）。在插件设置里打开 allowWrite 再试。');
    }
}

function assertGenerate(config, what) {
    if (!config.allowGenerate) {
        throw new Error('生成被关闭（' + what + '）。在插件设置里打开 allowGenerate 再试（会消耗模型额度）。');
    }
}

/** 统一把「名字/头像文件名」归一化：酒馆到处要 `xxx.png`。 */
function avatarOf(name) {
    const text = String(name || '').trim();
    if (!text) throw new Error('缺少角色名 / avatar');
    return text.endsWith('.png') ? text : text + '.png';
}

/* --------------------------- 工具输出约定 --------------------------- */

/**
 * 这些工具返回的都是「松散的诊断型结果」（不同工具字段完全不同），
 * 用一个宽松的对象 schema 收口，再靠 render 给模型看一段可读摘要。
 * 严格 schema 在这里没有价值：模型关心的是内容，不是校验。
 */
const LOOSE_SCHEMA = { type: 'object', additionalProperties: true };

/** 把任意返回值压成一段可读文本（模型看到的就是这段）。 */
function summarize(value) {
    if (value === null || value === undefined) return '（空）';
    if (typeof value !== 'object') return String(value);
    const text = JSON.stringify(value);
    return text.length > 12000 ? text.slice(0, 12000) + '\n…（已截断）' : text;
}

/** 给 defineTool 补上必需的 output.schema / output.render。 */
function withOutput(spec) {
    return {
        ...spec,
        output: {
            schema: spec.output?.schema || LOOSE_SCHEMA,
            render: spec.output?.render || ((_args, value) => summarize(value)),
            ...(spec.output?.presentationMeta ? { presentationMeta: spec.output.presentationMeta } : {}),
        },
    };
}

/** 注册工具：统一补 output 约定。 */
function register(ctx, spec) {
    ctx.tools.register(defineTool(withOutput(spec)));
}

/* ------------------------------ 工具实现 ------------------------------ */

function apply(ctx, config) {
    for (const key of ['timeoutMs']) {
        const value = config[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error('tavern-bridge: config ' + key + ' 必须是正数');
        }
    }
    if (!Array.isArray(config.targets) || !config.targets.length) {
        throw new Error('tavern-bridge: 至少要配置一个酒馆实例');
    }

    const targetParam = {
        type: 'string',
        description: '酒馆实例名（配置里的 targets[].name）。省略则用第一个。',
    };

    /* ---------------------- 1. 连通性与实例 ---------------------- */

    register(ctx, ({
        name: 'tavern_ping',
        description: [
            '检查酒馆是否连得上，并返回版本、当前角色、当前聊天等状态。',
            '任何 tavern_* 工具报「连不上」时先用这个排查。',
        ].join(' '),
        parameters: { target: targetParam },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const base = normalizeBase(t.url);
            const result = { target: t.name, url: base, ok: false };
            try {
                // 拿角色列表当作连通性验证：这是酒馆最基础也最稳的端点
                const list = await call(t, '/api/characters/all', { body: {}, timeoutMs: config.timeoutMs });
                result.ok = true;
                result.characters = Array.isArray(list) ? list.length : 0;
                result.characterNames = (Array.isArray(list) ? list : [])
                    .map(item => String(item?.name || ''))
                    .filter(Boolean)
                    .slice(0, 20);
                const settings = await call(t, '/api/settings/get', { body: {}, timeoutMs: config.timeoutMs }).catch(() => null);
                if (settings && typeof settings === 'object') {
                    result.currentCharacter = settings.character || '';
                    result.firstRun = settings.firstRun === true;
                }
            } catch (error) {
                result.error = String(error?.message || error);
            }
            return result;
        },
    }));

    /* ---------------------- 2. 角色卡 ---------------------- */

    register(ctx, ({
        name: 'tavern_list_characters',
        description: '列出酒馆里的全部角色卡（名字、头像文件名、创建时间、是否有内嵌世界书）。',
        parameters: { target: targetParam },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const list = await call(t, '/api/characters/all', { body: {}, timeoutMs: config.timeoutMs });
            if (!Array.isArray(list)) return { characters: [], note: '酒馆没有返回数组' };
            return {
                count: list.length,
                characters: list.map(item => {
                    const data = item?.data || item || {};
                    const book = data.character_book || data.data?.character_book;
                    return {
                        name: String(item?.name || data.name || ''),
                        avatar: String(item?.avatar || ''),
                        created: item?.create_date || data.create_date || '',
                        entries: Array.isArray(book?.entries) ? book.entries.length : 0,
                        world: data.extensions?.world || '',
                    };
                }),
            };
        },
    }));

    register(ctx, ({
        name: 'tavern_get_character',
        description: [
            '读一张角色卡的完整字段：description / personality / scenario / first_mes /',
            'mes_example / creator_notes / system_prompt / post_history_instructions，',
            '以及内嵌世界书的条目数与绑定的世界书名。',
            '默认返回截断后的字段，传 full: true 拿原文。',
        ].join(' '),
        parameters: {
            target: targetParam,
            avatar: { type: 'string', description: '角色名或头像文件名（都可，自动补 .png）' },
            full: { type: 'boolean', description: '返回完整原文（默认截断到 2000 字/字段）' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const avatar = avatarOf(args.avatar);
            const json = await call(t, '/api/characters/get', { body: { avatar_url: avatar }, timeoutMs: config.timeoutMs });
            if (!json || typeof json !== 'object') throw new Error('酒馆没有返回这张卡');
            const data = json.data || json;
            const limit = args.full === true ? Infinity : 2000;
            const cut = value => {
                const text = String(value || '');
                return text.length > limit ? text.slice(0, limit) + '…（共 ' + text.length + ' 字）' : text;
            };
            const book = data.character_book || data.data?.character_book;
            return {
                name: String(json.name || data.name || ''),
                avatar,
                description: cut(data.description),
                personality: cut(data.personality),
                scenario: cut(data.scenario),
                first_mes: cut(data.first_mes),
                mes_example: cut(data.mes_example),
                creator_notes: cut(data.creator_notes),
                system_prompt: cut(data.system_prompt),
                post_history_instructions: cut(data.post_history_instructions),
                tags: Array.isArray(data.tags) ? data.tags : [],
                world: data.extensions?.world || '',
                embeddedEntries: Array.isArray(book?.entries) ? book.entries.length : 0,
                spec: json.spec || data.spec || '',
            };
        },
    }));

    /* ---------------------- 3. 聊天 ---------------------- */

    register(ctx, ({
        name: 'tavern_list_chats',
        description: '列出某张角色卡下的所有聊天文件（文件名、大小、最后修改时间）。',
        parameters: {
            target: targetParam,
            avatar: { type: 'string', description: '角色名或头像文件名' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const avatar = avatarOf(args.avatar);
            const list = await call(t, '/api/characters/chats', { body: { avatar_url: avatar }, timeoutMs: config.timeoutMs });
            if (!Array.isArray(list)) return { chats: [] };
            return {
                count: list.length,
                chats: list.map(item => ({
                    file: String(item?.file_name || item?.file || ''),
                    size: Number(item?.file_size || 0),
                    modified: Number(item?.last_mes || item?.modified || 0),
                })),
            };
        },
    }));

    register(ctx, ({
        name: 'tavern_read_chat',
        description: [
            '读一段聊天的消息。返回每条消息的角色、名字、正文、是否隐藏。',
            'limit 从末尾往前取（默认 50），可用 start 指定起点。',
            '这是只读操作，不会改动聊天。',
        ].join(' '),
        parameters: {
            target: targetParam,
            avatar: { type: 'string', description: '角色名或头像文件名' },
            file: { type: 'string', description: '聊天文件名（从 tavern_list_chats 拿）' },
            limit: { type: 'number', description: '取最后多少条，默认 50' },
            start: { type: 'number', description: '从第几条开始（0 基），省略则按 limit 取末尾' },
            includeHidden: { type: 'boolean', description: '是否包含隐藏楼层（默认 true）' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const avatar = avatarOf(args.avatar);
            const file = String(args.file || '').trim();
            if (!file) throw new Error('缺少 file（聊天文件名），先用 tavern_list_chats 查');
            const list = await call(t, '/api/chats/get', {
                body: { avatar_url: avatar, file_name: file.replace(/\.jsonl$/, '') },
                timeoutMs: config.timeoutMs,
            });
            if (!Array.isArray(list)) return { messages: [], note: '这个聊天是空的或不存在' };
            const includeHidden = args.includeHidden !== false;
            const rows = list
                .map((msg, index) => ({ msg, index }))
                .filter(item => item.msg && (includeHidden || !(item.msg.is_system || item.msg.is_hidden)));
            const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
            const start = Number.isInteger(args.start) ? Math.max(0, args.start) : Math.max(0, rows.length - limit);
            const slice = rows.slice(start, start + limit);
            return {
                file,
                total: list.length,
                from: start,
                count: slice.length,
                messages: slice.map(item => ({
                    index: item.index,
                    isUser: !!item.msg.is_user,
                    name: String(item.msg.name || ''),
                    text: String(item.msg.mes || ''),
                    hidden: !!(item.msg.is_system || item.msg.is_hidden),
                })),
            };
        },
    }));

    /* ---------------------- 4. 世界书 ---------------------- */

    register(ctx, ({
        name: 'tavern_list_worldbooks',
        description: '列出酒馆里所有世界书（名字，用于 tavern_get_worldbook）。',
        parameters: { target: targetParam },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const list = await call(t, '/api/worldinfo/list', { body: {}, timeoutMs: config.timeoutMs });
            // 酒馆 1.15 返回 [{ file_id, name, extensions }]，早期版本返回字符串数组。
            // 统一成 { name, file_id }，并给一份纯名字列表方便下游直接用。
            const rows = Array.isArray(list) ? list : [];
            const worldbooks = rows.map(item => {
                if (typeof item === 'string') return { name: item, file_id: item };
                return {
                    name: String(item?.name || item?.file_id || ''),
                    file_id: String(item?.file_id || item?.name || ''),
                };
            }).filter(item => item.name);
            return {
                count: worldbooks.length,
                names: worldbooks.map(item => item.name),
                worldbooks,
            };
        },
    }));

    register(ctx, ({
        name: 'tavern_get_worldbook',
        description: [
            '读一本世界书的全部条目：标题、关键词、内容、是否常驻、插入顺序。',
            '返回按 insertion_order 降序（和酒馆的注入顺序一致）。',
            '内容默认截断到 1500 字/条，传 full: true 拿原文。',
        ].join(' '),
        parameters: {
            target: targetParam,
            name: { type: 'string', description: '世界书名字' },
            full: { type: 'boolean', description: '返回完整条目内容' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            const bookName = String(args.name || '').trim();
            if (!bookName) throw new Error('缺少世界书名字');
            const json = await call(t, '/api/worldinfo/get', { body: { name: bookName }, timeoutMs: config.timeoutMs });
            const entries = json?.entries || {};
            const limit = args.full === true ? Infinity : 1500;
            const list = Object.entries(entries).map(([uid, entry]) => {
                const content = String(entry?.content || '');
                const keys = Array.isArray(entry?.key) ? entry.key : (Array.isArray(entry?.keys) ? entry.keys : []);
                return {
                    uid,
                    title: String(entry?.comment || keys[0] || ''),
                    keys: keys.map(item => String(item)),
                    constant: !!entry?.constant,
                    disabled: !!entry?.disable,
                    order: Number(entry?.insertion_order) || 0,
                    content: content.length > limit ? content.slice(0, limit) + '…（共 ' + content.length + ' 字）' : content,
                };
            }).sort((a, b) => b.order - a.order);
            return { name: bookName, count: list.length, entries: list };
        },
    }));

    /* ---------------------- 5. 生成（可选） ---------------------- */

    register(ctx, ({
        name: 'tavern_generate',
        description: [
            '在酒馆里跑一次独立生成（不写进正文，用酒馆当前配置的模型）。',
            '适合：让酒馆的模型帮你写一段内容、分析一张卡、生成世界书条目。',
            '需要插件设置里打开 allowGenerate。',
        ].join(' '),
        parameters: {
            target: targetParam,
            system: { type: 'string', description: 'system prompt' },
            prompt: { type: 'string', description: '用户消息' },
            length: { type: 'number', description: '最大 token 数，默认 600' },
            model: { type: 'string', description: '覆盖模型名（可选）' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            assertGenerate(config, 'tavern_generate');
            const prompt = String(args.prompt || '').trim();
            if (!prompt) throw new Error('缺少 prompt');
            const body = {
                chat_completion_source: 'openai',
                messages: [
                    ...(args.system ? [{ role: 'system', content: String(args.system) }] : []),
                    { role: 'user', content: prompt },
                ],
                max_tokens: Math.max(64, Math.round(Number(args.length) || 600)),
                stream: false,
            };
            if (args.model) body.model = String(args.model);
            const json = await call(t, '/api/backends/chat-completions/generate', { body, timeoutMs: 120000 });
            if (json?.error) {
                throw new Error('酒馆生成失败：' + (typeof json.error === 'string' ? json.error : JSON.stringify(json.error)).slice(0, 300));
            }
            const choice = json?.choices?.[0];
            const text = String(choice?.message?.content ?? choice?.text ?? '').trim();
            return { model: json?.model || '', text, usage: json?.usage || null };
        },
    }));

    /* ---------------------- 6. 写操作（默认关） ---------------------- */

    register(ctx, ({
        name: 'tavern_edit_character',
        description: [
            '改一张角色卡的字段（description / personality / scenario / first_mes / mes_example /',
            'creator_notes / system_prompt / post_history_instructions / tags）。',
            '只改你传进来的字段，其余保持原样。需要 allowWrite。',
            '危险操作：会覆盖酒馆里的卡，先备份。',
        ].join(' '),
        parameters: {
            target: targetParam,
            avatar: { type: 'string', description: '角色名或头像文件名' },
            fields: { type: 'string', description: 'JSON 字符串，要改的字段，例如 {"scenario":"新的场景"}' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            assertWrite(config, 'tavern_edit_character');
            const avatar = avatarOf(args.avatar);
            let patch;
            try {
                patch = JSON.parse(String(args.fields || '{}'));
            } catch {
                throw new Error('fields 不是合法 JSON');
            }
            const allowed = ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
                'creator_notes', 'system_prompt', 'post_history_instructions', 'tags'];
            const clean = {};
            for (const [key, value] of Object.entries(patch)) {
                if (!allowed.includes(key)) continue;
                clean[key] = value;
            }
            if (!Object.keys(clean).length) throw new Error('没有可改的字段，允许：' + allowed.join(', '));
            await call(t, '/api/characters/edit-attribute', {
                body: { avatar_url: avatar, ...clean },
                timeoutMs: config.timeoutMs,
            });
            return { ok: true, avatar, changed: Object.keys(clean) };
        },
    }));

    register(ctx, ({
        name: 'tavern_edit_worldbook_entry',
        description: [
            '改世界书里的某一条（内容 / 标题 / 关键词 / 常驻 / 插入顺序 / 启用）。',
            '需要 allowWrite。uid 从 tavern_get_worldbook 拿。',
            '危险操作：会覆盖酒馆里的世界书，先备份。',
        ].join(' '),
        parameters: {
            target: targetParam,
            name: { type: 'string', description: '世界书名字' },
            uid: { type: 'string', description: '条目 uid' },
            fields: { type: 'string', description: 'JSON 字符串，例如 {"content":"新内容","constant":true}' },
        },
        async execute(args) {
            const t = pickTarget(config, args.target);
            assertWrite(config, 'tavern_edit_worldbook_entry');
            const bookName = String(args.name || '').trim();
            const uid = String(args.uid || '').trim();
            if (!bookName || !uid) throw new Error('缺少世界书名字或 uid');
            let patch;
            try {
                patch = JSON.parse(String(args.fields || '{}'));
            } catch {
                throw new Error('fields 不是合法 JSON');
            }
            // 先取原条目，合并后再写回（酒馆的 edit 是整条覆盖）
            const json = await call(t, '/api/worldinfo/get', { body: { name: bookName }, timeoutMs: config.timeoutMs });
            const original = json?.entries?.[uid];
            if (!original) throw new Error('世界书里没有 uid=' + uid + ' 的条目');
            const allowed = ['content', 'comment', 'key', 'constant', 'disable', 'insertion_order', 'depth', 'position', 'selective'];
            const merged = { ...original };
            for (const [key, value] of Object.entries(patch)) {
                if (allowed.includes(key)) merged[key] = value;
            }
            await call(t, '/api/worldinfo/edit', {
                body: { name: bookName, entries: { [uid]: merged } },
                timeoutMs: config.timeoutMs,
            });
            return { ok: true, name: bookName, uid, changed: Object.keys(patch).filter(key => allowed.includes(key)) };
        },
    }));
}

export { Config, apply, inject, name };
