# dsh-tavern-bridge

让 **DeepSeek Harness** 通过局域网操作**酒馆**（SillyTavern / TauriTavern）。

不依赖酒馆侧装任何插件，只用酒馆原生 `/api/*`，所以 TT 这种社区二创也能用。

## 能做什么

| 工具 | 作用 | 需要开关 |
| --- | --- | --- |
| `tavern_ping` | 检查连通性，返回版本、角色数、当前角色 | — |
| `tavern_list_characters` | 列出全部角色卡（名字、头像、内嵌世界书条目数、绑定世界书） | — |
| `tavern_get_character` | 读一张卡的完整字段（description / scenario / first_mes / …） | — |
| `tavern_list_chats` | 列出某张卡下的聊天文件 | — |
| `tavern_read_chat` | 读聊天消息（角色、正文、是否隐藏） | — |
| `tavern_list_worldbooks` | 列出全部世界书 | — |
| `tavern_get_worldbook` | 读一本世界书的全部条目（标题/关键词/内容/常驻/顺序） | — |
| `tavern_generate` | 在酒馆里跑一次独立生成（不写正文） | `allowGenerate` |
| `tavern_edit_character` | 改角色卡字段 | `allowWrite` |
| `tavern_edit_worldbook_entry` | 改世界书某一条 | `allowWrite` |

**默认只读。** 写和生成都要在设置里显式打开，防止误改。

## 安装

**手机 / 远程安装（推荐）**：直接用 GitHub 链接。

```
https://github.com/LingYuYue1/dsh-tavern-bridge
```

在 DSH 的插件管理里粘贴这个地址即可。也可以用简写：

```
github:LingYuYue1/dsh-tavern-bridge
```

已实测：`pnpm add github:LingYuYue1/dsh-tavern-bridge` 能正常装，依赖（`@deepseek-ai/schemastery`）在公共 npm 上有，模块能正常 import。

**本地安装**：把整个目录放进 DSH 的本地插件目录：

```powershell
Copy-Item "D:\牢凌的知识库\ST角色卡库\50-插件\dsh-tavern-bridge" `
          "$env:USERPROFILE\.dsh\_local-plugins\dsh-tavern-bridge" -Recurse
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加一行，
或者让插件管理器处理 `cordis.patch.yml`。

## 配置

`cordis.patch.yml` 里的 config：

```yaml
targets:
  - name: pc          # 电脑上的酒馆
    url: http://127.0.0.1:8000
    username: ''
    password: ''
  - name: phone       # 手机上的 TT
    url: http://192.168.1.20:8000
    username: ''
    password: ''
allowWrite: false     # 改卡 / 改世界书
allowGenerate: false  # 跑生成（会消耗模型额度）
timeoutMs: 20000
```

`targets` 可以配多个，工具参数 `target` 用 `name` 选。省略就用第一个。

## 手机上的 TT 怎么连

1. **酒馆要允许局域网访问**。TT 的设置里把监听地址改成 `0.0.0.0`，或者开启「局域网访问」。
2. **手机和电脑同一 Wi-Fi**。
3. **地址填手机的局域网 IP**，不是 `127.0.0.1`（那是电脑自己）。
   - 手机上查看：Wi-Fi 设置里点当前网络，看 IP 地址
   - 或者在手机浏览器打开酒馆，看地址栏
4. 先跑 `tavern_ping` 验证。连不上时它会给出具体原因（超时 / 拒绝连接 / 403）。

**防火墙**：Windows 第一次可能弹窗询问，要允许。

## 两个已知的技术点

### CSRF

酒馆默认开 CSRF。它的 token **存在 cookie session 里**：

```
GET /csrf-token
  → Set-Cookie: session-xxx=...   ← 这个必须保存
  → {"token":"..."}                ← token 是这个 session 的字段
```

只带 token 不带 cookie → 一律 `403 Invalid CSRF token`。
插件会自动保存并回传 cookie，token 过期时自动重取一次。

### 端点形状

酒馆 1.15 的 `/api/worldinfo/list` 返回 `[{ file_id, name, extensions }]`，
早期版本返回字符串数组。插件统一成 `{ name, file_id }`，并额外给一份 `names` 纯名字列表。

## 开发

```powershell
# 语法检查
node --check lib/index.js

# 端到端测试（需要酒馆在跑）
$env:TAVERN_URL="http://127.0.0.1:8099"
node test-e2e.mjs
```

`test-e2e.mjs` 会真的打酒馆，验证每个端点的参数形状。

## 许可

MIT
