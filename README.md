# 侧边对话（side-chat）

DSH Web UI 的客户端插件。**会话 header 里多一枚「侧边对话」，点开右侧栏就多一个附着在
当前对话上的临时侧边对话：它读得到主对话的上下文，你在侧边问什么都不写进主对话。**

```
┌─────────────────────────────┬──────────────────────────────┐
│  主对话（一个字都不会变）      │ ⟡ 附着主对话 · 双向独立  [重新附着][结束] │
│                             ├──────────────────────────────┤
│  ...你要继续推进的内容...     │ 侧边对话（= 主对话在最近完成轮次 │
│                             │ 处的 fork，上下文一模一样）        │
│  [ 主对话输入框 ]             │ ...你在这问、它在这答...          │
│                             │ [ 侧边输入框 ]                  │
└─────────────────────────────┴──────────────────────────────┘
```

## 它解决的问题

主对话正在推进时，你常常想插一句「刚才那段为什么这么改」「这个函数还有别的写法吗」
「把刚才那个结论也套到另一个文件上」。打在主输入框里会打断主线的节奏、污染主线的日志；
另开一个会话又要重新贴一遍上下文。

侧边对话把这两件事拆开：**上下文是主对话的（fork 出来的），输出只落在侧边。**

## 怎么做的（对着宿主源码核对过）

1. **共享上下文只有一条正路**：`ctx.sessions.fork({ sessionId })`。省略 `atSeq` 时由 Host
   自己取「最近的完整轮次前缀」；切在开启中的轮次里也会由 Host 用合成收尾补齐，不会把主
   对话写坏。fork 出来的子会话是**另一个会话**，它的每一轮、每个工具调用都只写自己的日志 ——
   所以「侧边用主对话的上下文，主对话不受侧边影响」是结构保证，不是约定。
2. **侧边 tab 的座位**：`ctx.sidebarRightTabs.register({ id, kind: 'sidechat' })` 注册类型，
   `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id })` 注册正文。
   打开是 `ctx.sidebarRight.openTab('sidechat')`，`openTab` 自己会展开面板。
3. **正文里怎么画「另一个会话」的对话界面**：宿主自己就是这么干的
   （`@deepseek-ai/dsh-client-ui-subagent` 的右侧栏子智能体对话）——
   用 `SessionProvider` 把作用域换成子会话的 `SessionReference`，再渲一个挂在它下面的
   会话槽位；槽位里 `renderFactorySlot('conversation.content', { variant: 'embedded' })`
   就是完整的宿主对话外壳。**输入框、停止、流式输出、工具卡片全是原生的**，
   本插件没有重写任何聊天渲染。
4. **附着点记在 localStorage**：`dsh.side-chat.v1.<主会话 id>` → 侧边会话 id。
   关掉 tab 不销毁侧边会话，下次打开接着聊；点「结束」才归档并断开。

## 三个座位

| 部件 | 槽位 | 作用域 | 说明 |
| --- | --- | --- | --- |
| 触发按钮 | `conversation.session.header.utilities`（`order: -20`） | session | 排在宿主那几枚（-10 / -5 / 0）之前，最靠标题 |
| 侧边 tab | `sidebar.right.pane.tab`（key = `@local/side-chat`） | session | 页类型，`multiple` 未开：每个会话只有一张侧边对话 |
| 对话外壳 | `side.chat.conversation`（本插件自己声明的 single 子槽位） | session | 存在只为让 `SessionProvider` 换作用域 |

## 顶部那条

- `⟡ 附着主对话 · 双向独立 · 收起即归档` —— 一句说明，没有别的装饰。
- **重新附着**：主对话又推进了很多时，按最新进展重建侧边对话。旧的侧边会话会被归档
  （`archiveSession`，可逆），新的从当前主对话重新 fork。
- **结束**：归档当前侧边会话并断开，tab 里显示「已结束 / 重新开始」。主对话一概不动。

## 关于“不要新建对话”（2026-11-03 实测结论）

这一条**做不到纯字面**，原因是平台约束，不是没接好线：

- 左侧边栏 `sessionVisible()` 只对 `origin === 'subagent'` 的会话直接返回 false（另一个入口是
  归档过滤器）。
- 但 subagent-origin 会话**客户端不能 prompt**：`validateAddress` 与 prompt 路径都会报
  `session/agent-busy: subagent Sessions require their durable parent address`，必须走
  subagent delivery —— 那是「Agent 起一个任务」，不是自由对话。
- 归档能隐藏，可归档会话的 `agent/pre-step` 会被直接 reject，答不了话。

于是：**任何客户端创建的会话（fork / create）都必然在侧边栏出现一行。** 现在取的是能做到的折中：

- **面板不显示时就归档**：tab 关掉、或切走到别的会话（正文卸载）→ `suspend()` 释放引用 + `archiveSession`，
  侧栏那条同步消失；localStorage 里的附着记录保留，下次打开先 `unarchiveSession` 再认领，接着聊。
- 用着的时候那一行在（标题 `侧边对话 · <主对话标题>`）。
- 失败/重建留下的旧侧边会话会被归档，不会堆在侧栏里。

## 边界

- 侧边对话是**另一个会话**，所以它会出现在侧栏的会话列表里（标题 `侧边对话 · <主对话标题>`）。
  这是它「真独立」的代价；点「结束」或手动归档就收拾掉了。
- 侧边对话的上下文冻结在 fork 那一刻。主对话继续推进后，想让侧边跟上就点「重新附着」。
- 侧边对话跑的是同一个 Agent 配置，所以它也有工具权限 —— 「顺便让它去改个文件」是支持的，
  改动落在同一个工作区里（这正是「进一步操作」）。
- 没有会话就没有侧边栏，所以 hero 画面（未选会话）里没有入口。

## 安装

```bash
# 本机（desktop profile）手工 link —— profile 里的 dsh-purge-community 是 GitHub
# Releases tarball，pnpm add 会先 HEAD github.com，本机超时，install_bundle 必然失败：
#   1) node_modules/@local/side-chat 建 junction 指向本目录
#   2) profile package.json 加 link: 依赖 + dsh.profile.bundles
#   3) pnpm-lock.yaml 的 importer 补 specifier / link: 版本
#   4) plugin_manager set_bundle target=@local/side-chat  → application: applied
```

新增**客户端** bundle 不需要重启宿主（客户端会自己把模块拉起来）；改 `client.js` 时宿主
开着的 HMR 会在约 0.5s 轮询 + 一次页面 swap 后换上新的一代。

## 验收

- 零依赖冒烟测试（107 项，不需要宿主/浏览器）：
  `node plugins/side-chat/test/client-smoke.cjs`
  —— 断言注册面（tab 类型 / 三个座位 / 语言包）、文案 key 一致、CSS 只用主题变量、
  附着关系（fork / 复用 / **瞬时未物化后重试接住** / 失效重 fork / 并发去重 / 重新附着 / 结束 /
  收起归档 / 卸载）、组件三态与回调、`resolvePhase` 判据。
  其中 `flaky: {'side-1': 2}` 那一条是「附着失败」的回归测试：让前两次 `retain` 抛
  `sessions.retain: unknown session`，断言第三次接住、只 fork 一次、不把自己刚建的会话归档掉。
- 活体：`cordis_inspect_query` Client `Slots.listSubTree`
  root=`conversation.session.header.utilities` → occupants 里应有
  `{"id":"side-chat-trigger","order":-20,"active":true}`；
  root=`sidebar.right.pane.tab` → occupants 里应有 key=`@local/side-chat`。
- 本会话**没有浏览器控制**：颜色、宽度、和 header 其它按钮的对齐是照宿主同名控件抄的，
  但渲染观感未经肉眼确认。

## 关联文件

- `client.js` —— 全部逻辑（纯 JS，`window.__ModuleLoader__.load` 注册，只 `require('react')`）。
- `index.js` —— Host 半边，空的（本插件不注册任何面向模型的内容）。
- `cordis.patch.yml` —— bundle 的 loader 行。
- `locale/{zh,en}.json` —— 插件管理页显示的标题与描述。
