/**
 * 侧边对话（Side Chat）—— 附着于主对话的侧边临时辅助对话
 *
 * 干的事：
 *   1) 会话 header 右侧工具组里多一枚「侧边对话」；
 *   2) 点一下 → 右侧栏多一个 `sidechat` tab，里面是**一个真正独立会话**的完整对话界面
 *      （聊天流 + 输入框 + 停止 + 流式输出，全是宿主自己的组件）；
 *   3) 那个会话是主会话在「最近一次完成的轮次」处的 fork：它继承了主对话的全部上下文，
 *      之后的提问只写进它自己的日志 —— 主对话一个字都不会变。
 *
 * 为什么这么实现（对着宿主源码核对过，不是猜）：
 *   · 共享上下文只有一条正路：`ctx.sessions.fork({sessionId})`。省略 `atSeq` 时由 Host
 *     自己取「最近的完整轮次前缀」，切在开启中的轮次里也会被 Host 用合成收尾补齐，
 *     不会把主对话写坏。fork 出来的子会话是**另一个会话**，所以它回什么都不进主日志 ——
 *     这正是「侧边用主对话的上下文，主对话不受侧边影响」。
 *   · 侧边 tab 的座位：`ctx.sidebarRightTabs.register({id, kind})` 注册类型，
 *     `ctx.slots.register({name:'sidebar.right.pane.tab', key:id})` 注册正文。
 *   · 正文里怎么把「另一个会话」的对话界面画出来：宿主自己就是这么干的
 *     （`dsh-client-ui-subagent` 的右侧栏子智能体对话）——用 `SessionProvider` 把作用域
 *     换成子会话的 `SessionReference`，再 `renderSlot` 渲一个挂在它下面的会话槽位；
 *     槽位里 `renderFactorySlot('conversation.content', {variant:'embedded'})` 就是完整的
 *     宿主对话外壳。输入框、停止按钮、流式渲染因此都是原生的，不需要自己重写。
 *   · 侧边的「附着点」记在 localStorage：`dsh.side-chat.v1.<主会话 id>` → 子会话 id。
 *     关掉 tab 不销毁侧边会话，下次打开接着聊；点「结束」才归档断开。
 *
 * 落点（都由 cordis_inspect_query 核对过）：
 *   · 触发按钮 → `conversation.session.header.utilities`（list / session 作用域）
 *   · 侧边 tab → `sidebar.right.pane.tab`（keyed / session 作用域，key = 类型 id）
 *   · 侧边对话 → 本插件自己声明的子槽位 `side.chat.conversation`（single / session）
 */

window.__ModuleLoader__.load({
  id: '@local/side-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本插件的文案命名空间。 */
    const NS = 'sideChat';
    /** 右侧栏 tab 类型：kind 是用户可见的页类型，id 是它在 tab 系统里的实现身份。 */
    const TAB_KIND = 'sidechat';
    const TAB_ID = '@local/side-chat';
    /** 宿主的三个扩展席位 + 本插件自己的会话槽位。 */
    const SLOT_TRIGGER = 'conversation.session.header.utilities';
    const SLOT_TAB = 'sidebar.right.pane.tab';
    const SLOT_CHAT = 'side.chat.conversation';
    /** 附着关系：主会话 id → 侧边会话 id。 */
    const STORAGE_PREFIX = 'dsh.side-chat.v1.';
    /** 子会话标题最长多少字（宿主侧栏里一行放不下会截断，先自己截）。 */
    const TITLE_MAX = 48;
    /** 等 `reference.ready` 的上限；超过就先把界面放出来，会话自己的 loading 态会接手。 */
    const READY_TIMEOUT_MS = 8000;
    /** 触发按钮在 header 工具组里的位置：排在宿主那几枚（-10 / -5 / 0）之前，最靠标题。 */
    const TRIGGER_ORDER = -20;

    const DICT = {
      zh: {
        'trigger.label': '侧边对话',
        'trigger.tip': '在右侧栏开一个附着于本对话的侧边对话：共享上下文，不改动主对话',
        'tab.title': '侧边对话',
        'guide.title': '侧边对话',
        'guide.description': '附着在主对话上，另开一个问题不打断它',
        'childTitle.prefix': '侧边对话',
        'note.shared': '附着主对话 · 双向独立',
        'state.attaching': '正在附着主对话…',
        'state.failed': '附着失败：{message}',
        'state.ended': '侧边对话已结束（已归档并断开）',
        'state.restart': '重新开始',
        'state.retry': '重试',
        'state.unavailable': '侧边对话不可用：宿主缺少会话渲染能力',
        'reattach': '重新附着',
        'reattach.tip': '按主对话的最新进展重建侧边对话（当前侧边对话会归档）',
        'end': '结束',
        'end.tip': '归档这个侧边对话并断开连接（主对话不受影响）',
        'error.noSession': '没有可附着的会话'
      },
      en: {
        'trigger.label': 'Side chat',
        'trigger.tip': 'Open a side conversation attached to this one: shared context, main log untouched',
        'tab.title': 'Side chat',
        'guide.title': 'Side chat',
        'guide.description': 'Attached to the main conversation; ask without interrupting it',
        'childTitle.prefix': 'Side chat',
        'note.shared': 'Attached to main · both sides independent',
        'state.attaching': 'Attaching to the main conversation…',
        'state.failed': 'Attach failed: {message}',
        'state.ended': 'Side chat ended (archived and detached)',
        'state.restart': 'Start again',
        'state.retry': 'Retry',
        'state.unavailable': 'Side chat unavailable: this Harness cannot render a conversation here',
        'reattach': 'Re-attach',
        'reattach.tip': 'Rebuild the side chat from the latest main conversation (the current one is archived)',
        'end': 'End',
        'end.tip': 'Archive this side chat and detach it (the main conversation is untouched)',
        'error.noSession': 'No conversation to attach to'
      }
    };

    // 所有颜色都走 --dsw-alias-* / --dsw-radius-*，深浅色主题自动跟随。
    const CSS =
      '.sdc-root{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;' +
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);' +
      'font-size:12px;line-height:1.5}' +
      '.sdc-strip{flex:none;display:flex;align-items:center;gap:6px;min-width:0;' +
      'padding:4px 8px 4px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);' +
      'color:var(--dsw-alias-label-tertiary);font-size:11px}' +
      '.sdc-dot{flex:none;width:6px;height:6px;border-radius:50%;' +
      'background:var(--dsw-alias-brand-primary)}' +
      '.sdc-stripText{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;color:var(--dsw-alias-label-secondary)}' +
      '.sdc-spacer{flex:1 1 auto;min-width:4px}' +
      '.sdc-link{border:none;background:transparent;color:inherit;font:inherit;font-size:11px;' +
      'cursor:pointer;padding:1px 5px;border-radius:var(--dsw-radius-sm,4px);flex:none;' +
      'line-height:1.5;white-space:nowrap}' +
      '.sdc-link:hover:not(:disabled){color:var(--dsw-alias-label-primary);' +
      'background:var(--dsw-alias-interactive-bg-hover)}' +
      '.sdc-link:disabled{opacity:.5;cursor:default}' +
      '.sdc-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}' +
      '.sdc-state{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;padding:24px 18px;text-align:center;' +
      'color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.sdc-stateText{max-width:32em;color:var(--dsw-alias-label-secondary)}' +
      '.sdc-stateAction{border:.5px solid var(--dsw-alias-border-l2);' +
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);' +
      'font:inherit;font-size:11px;cursor:pointer;padding:3px 12px;' +
      'border-radius:var(--dsw-radius-sm,4px)}' +
      '.sdc-stateAction:hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.sdc-trigger{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;' +
      'border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;' +
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;' +
      'cursor:pointer;white-space:nowrap;flex:none}' +
      '.sdc-trigger:hover{color:var(--dsw-alias-label-primary);' +
      'background:var(--dsw-alias-interactive-bg-hover)}' +
      '.sdc-trigger:focus-visible{outline:none;color:var(--dsw-alias-label-primary);' +
      'background:var(--dsw-alias-interactive-bg-hover)}' +
      '.sdc-trigger svg{flex:none}';

    // #region 小工具
    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /** setTimeout 包一层：没这个全局也能跑（冒烟测试里就是这么喂的）。 */
    function later(fn, ms) {
      return typeof setTimeout === 'function' ? setTimeout(fn, ms) : 0;
    }
    function cancelLater(handle) {
      if (handle && typeof clearTimeout === 'function') clearTimeout(handle);
    }

    /**
     * 等一个 promise 落定，但最多等 ms：超时不算失败，只是「先不拦着」。
     * @returns 'ok' | 'timeout' | 原始错误对象
     */
    function settleWithin(promise, ms) {
      return new Promise(function (resolve) {
        let done = false;
        const timer = later(function () {
          if (done) return;
          done = true;
          resolve('timeout');
        }, ms);
        promise.then(
          function () {
            if (done) return;
            done = true;
            cancelLater(timer);
            resolve('ok');
          },
          function (error) {
            if (done) return;
            done = true;
            cancelLater(timer);
            resolve(error);
          }
        );
      });
    }

    function box() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
      } catch (_unavailable) {
        /* 无痕模式/被禁用：附着关系退化成只在内存里 */
      }
      return undefined;
    }

    function readChild(parentId) {
      const store = box();
      if (!store || typeof parentId !== 'string') return undefined;
      try {
        const raw = store.getItem(STORAGE_PREFIX + parentId);
        return typeof raw === 'string' && raw !== '' ? raw : undefined;
      } catch (_unreadable) {
        return undefined;
      }
    }

    function writeChild(parentId, childId) {
      const store = box();
      if (!store) return;
      try {
        store.setItem(STORAGE_PREFIX + parentId, childId);
      } catch (_unwritable) {
        /* 配额满：本次会话仍然可用，只是刷新后要重新附着 */
      }
    }

    function clearChild(parentId) {
      const store = box();
      if (!store) return;
      try {
        store.removeItem(STORAGE_PREFIX + parentId);
      } catch (_unwritable) {
        /* 同上 */
      }
    }

    /**
     * 侧边对话外壳的相位，抄宿主 `conversation.content` 的判据（子智能体侧栏对话同款）。
     * @returns {phase, hero}
     */
    function resolvePhase(session, conversation, summaryBlank) {
      const snapshot = session || {};
      const targets = conversation && conversation.activeTargets ? conversation.activeTargets.size : 0;
      const engaged = (!snapshot.blank && !snapshot.awaitingFirstTurn) || snapshot.running === true || targets > 0;
      const shellPhase = engaged ? 'active' : snapshot.promptAttempted ? 'engaging' : 'blank';
      const settling = shellPhase === 'blank' && snapshot.openState === 'loading' && summaryBlank !== true;
      const hero = shellPhase === 'blank' && (snapshot.openState === 'open' || summaryBlank === true);
      return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero: hero };
    }

    function truncate(text, max) {
      if (typeof text !== 'string') return '';
      if (text.length <= max) return text;
      return text.slice(0, Math.max(1, max - 1)) + '…';
    }
    // #endregion

    // #region 侧边会话的附着关系
    /** 当前 apply 注入给组件的服务；插件卸载时清空，组件据此退化成不可用态。 */
    let runtime = null;

    /**
     * 每个主会话对应一个侧边会话：先认本地记下的那个，认不出来（被删/被归档/读不出）就 fork 一个新的。
     * 引用由本模块持有、只在「替换」和「插件卸载」时释放，所以 tab 关掉再打开能接着聊。
     */
    function createAttachments(ctx, t) {
      /** parentId → { parentId, childId, ref, phase } */
      const entries = new Map();
      /** parentId → Promise<entry>（同一个会话并发打开两次时只 fork 一次） */
      const inflight = new Map();

      /** 引用还是这个 Controller 的当次世代吗（重连后旧引用会失效）。 */
      function live(entry) {
        if (!entry || !entry.ref || typeof entry.childId !== 'string') return false;
        try {
          return ctx.sessions.binding(entry.childId) === entry.ref.binding;
        } catch (_stale) {
          return false;
        }
      }

      function drop(entry) {
        if (!entry) return;
        // 只删自己那一格：重新附着时新条目已经占住了同一个 parentId，别把它一起删掉。
        if (entries.get(entry.parentId) === entry) entries.delete(entry.parentId);
        const ref = entry.ref;
        entry.ref = undefined;
        entry.phase = 'dropped';
        if (ref) {
          try {
            ref.release();
          } catch (_released) {
            /* 已经释放过 */
          }
        }
      }

      /** 归档一个侧边会话（可逆：`unarchiveSession`）。失败不影响界面。 */
      function archive(childId) {
        const workspace = ctx.get('uiWorkspace') || ctx.get('workspaces');
        if (!workspace || typeof workspace.archiveSession !== 'function') return;
        try {
          const running = workspace.archiveSession(childId, { stopActivity: true });
          if (running && typeof running.catch === 'function') running.catch(function () {});
        } catch (_unsupported) {
          /* 归档只是收拾屋子，做不成也不报错 */
        }
      }

      function childTitle(parentId) {
        const listing = ctx.sessions.list && ctx.sessions.list.getSnapshot ? ctx.sessions.list.getSnapshot() : undefined;
        const row = listing && listing.byId ? listing.byId[parentId] : undefined;
        const parentTitle = row && typeof row.title === 'string' ? row.title.trim() : '';
        const head = t('childTitle.prefix');
        return truncate(parentTitle === '' ? head : head + ' · ' + parentTitle, TITLE_MAX);
      }

      /** 认领一个已存在的子会话：`ready` 落定且不是错误态才算数。 */
      async function retain(childId) {
        let ref;
        try {
          ref = ctx.sessions.retain({ sessionId: childId }, { source: 'gateway' });
        } catch (_unknown) {
          return undefined;
        }
        const outcome = await settleWithin(ref.ready, READY_TIMEOUT_MS);
        if (outcome !== 'ok' && outcome !== 'timeout') {
          try {
            ref.release();
          } catch (_released) {
            /* ignore */
          }
          return undefined;
        }
        if (outcome === 'ok') {
          const snapshot = ref.binding && ref.binding.session ? ref.binding.session.getSnapshot() : undefined;
          if (snapshot && (snapshot.openState === 'error' || snapshot.removed === true)) {
            try {
              ref.release();
            } catch (_released) {
              /* ignore */
            }
            return undefined;
          }
        }
        return ref;
      }

      /** fork 一个继承主对话上下文的新会话，改个能认出来的名字，然后认领它。 */
      async function fork(parentId) {
        const childId = await ctx.sessions.fork({ sessionId: parentId });
        writeChild(parentId, childId);
        const ref = await retain(childId);
        if (!ref) throw new Error(t('state.failed', { message: 'fork' }));
        try {
          const renamed = ref.binding.session.rename(childTitle(parentId));
          if (renamed && typeof renamed.catch === 'function') renamed.catch(function () {});
        } catch (_renameFailed) {
          /* 名字只是给人看的 */
        }
        return { parentId: parentId, childId: childId, ref: ref, phase: 'ready' };
      }

      function peek(parentId) {
        const entry = entries.get(parentId);
        if (!entry) return undefined;
        if (entry.phase === 'ready' && !live(entry)) {
          drop(entry);
          return undefined;
        }
        return entry;
      }

      /** 拿到（或建立）这个主会话的侧边会话。 */
      function ensure(parentId) {
        if (typeof parentId !== 'string' || parentId === '') return Promise.reject(new Error(t('error.noSession')));
        const ready = peek(parentId);
        if (ready && ready.phase === 'ready') return Promise.resolve(ready);
        const running = inflight.get(parentId);
        if (running) return running;
        const task = (async function () {
          const remembered = readChild(parentId);
          if (remembered) {
            const ref = await retain(remembered);
            if (ref) {
              const entry = { parentId: parentId, childId: remembered, ref: ref, phase: 'ready' };
              entries.set(parentId, entry);
              return entry;
            }
            clearChild(parentId);
          }
          const entry = await fork(parentId);
          entries.set(parentId, entry);
          return entry;
        })();
        const tracked = task.finally(function () {
          inflight.delete(parentId);
        });
        inflight.set(parentId, tracked);
        return tracked;
      }

      /** 按主对话最新进展重建：新 fork 一个，旧的释放并归档。 */
      async function reattach(parentId) {
        const previous = peek(parentId);
        const entry = await fork(parentId);
        entries.set(parentId, entry);
        if (previous) {
          const oldChild = previous.childId;
          drop(previous);
          archive(oldChild);
        }
        return entry;
      }

      /** 结束：断开、忘掉、归档。主对话一概不动。 */
      async function end(parentId) {
        const previous = peek(parentId);
        clearChild(parentId);
        if (!previous) return;
        const oldChild = previous.childId;
        drop(previous);
        archive(oldChild);
      }

      function dispose() {
        for (const entry of Array.from(entries.values())) drop(entry);
        entries.clear();
        inflight.clear();
      }

      return { peek: peek, ensure: ensure, reattach: reattach, end: end, dispose: dispose };
    }
    // #endregion

    // #region 图标
    function SideChatIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 15;
      const stroke = { stroke: 'currentColor', strokeWidth: '1.1', fill: 'none' };
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
        // 主对话那个大气泡（左下）
        h('path', {
          d: 'M2.9 4.6h6.6a1.5 1.5 0 0 1 1.5 1.5v3.6a1.5 1.5 0 0 1-1.5 1.5H6.1L3.9 13a.42.42 0 0 1-.7-.33V11.2h-.3a1.5 1.5 0 0 1-1.5-1.5V6.1a1.5 1.5 0 0 1 1.5-1.5Z',
          ...stroke,
          strokeLinejoin: 'round'
        }),
        // 侧边那个小气泡（右上，与大气泡不相交）
        h('path', {
          d: 'M11.7 1.4h2.3a1.3 1.3 0 0 1 1.3 1.3v1.6a1.3 1.3 0 0 1-1.3 1.3h-2.3a1.3 1.3 0 0 1-1.3-1.3V2.7a1.3 1.3 0 0 1 1.3-1.3Z',
          ...stroke,
          strokeLinejoin: 'round'
        }),
        h('circle', { cx: '4.5', cy: '8.1', r: '0.72', fill: 'currentColor' }),
        h('circle', { cx: '6.9', cy: '8.1', r: '0.72', fill: 'currentColor' }),
        h('circle', { cx: '9.3', cy: '8.1', r: '0.72', fill: 'currentColor' })
      );
    }
    // #endregion

    // #region header 触发按钮
    /**
     * 会话 header 里那一枚。点它只做一件事：把侧边 tab 开到右侧栏
     * （`openTab` 自己会展开面板，所以用户看得见）。
     */
    function SideChatTrigger(props) {
      const t = props.t;
      const sessionId = props.sessionId;
      return h(
        'button',
        {
          type: 'button',
          className: 'sdc-trigger',
          'data-side-chat-trigger': '',
          title: t('trigger.tip'),
          'aria-label': t('trigger.tip'),
          onClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            openSideTab(sessionId);
          }
        },
        h(SideChatIcon, { size: 14 }),
        h('span', null, t('trigger.label'))
      );
    }

    function openSideTab(sessionId) {
      if (!runtime || !runtime.right) return;
      try {
        runtime.right.openTab(TAB_KIND, {});
      } catch (error) {
        console.error('[side-chat] 打开侧边对话失败：', error, sessionId);
      }
    }
    // #endregion

    // #region 侧边 tab 正文
    /** 只画聊天流的视图：侧边对话不需要 trajectory / 视图 tab 那一套。 */
    function ChatOnlyView(props) {
      if (!props || typeof props.renderSlot !== 'function') return null;
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    /** 把「另一个会话」的完整宿主对话外壳画出来（嵌进窄栏的 embedded 形态）。 */
    function EmbeddedConversationBody(props) {
      const session = props.useSession(function (value) {
        return value;
      });
      const conversation = props.useConversation(function (value) {
        return value;
      });
      const sessions = props.useSessions(function (state) {
        return state && state.byId ? state.byId[props.sessionId] : undefined;
      });
      const summaryBlank = sessions ? sessions.blank : undefined;
      const phase = resolvePhase(session, conversation, summaryBlank);
      return props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: phase.phase, hero: phase.hero },
        { slots: { views: ChatOnlyView } }
      );
    }

    /** 入口：宿主能力不全时给一句话，而不是让整个 slot 崩掉。 */
    function SideChatConversation(props) {
      const usable =
        props &&
        typeof props.useSession === 'function' &&
        typeof props.useConversation === 'function' &&
        typeof props.useSessions === 'function' &&
        typeof props.renderFactorySlot === 'function';
      if (!usable) {
        const t = (props && props.t) || function (key) {
          return key;
        };
        return h('div', { className: 'sdc-state' }, h('span', { className: 'sdc-stateText' }, t('state.unavailable')));
      }
      return h(EmbeddedConversationBody, props);
    }

    /** 顶部那一条：一句说明 + 重新附着 + 结束。 */
    function SideChatStrip(props) {
      const t = props.t;
      return h(
        'div',
        { className: 'sdc-strip' },
        h('span', { className: 'sdc-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'sdc-stripText' }, t('note.shared')),
        h('span', { className: 'sdc-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'sdc-link',
            'data-side-chat-reattach': '',
            title: t('reattach.tip'),
            disabled: props.busy === true,
            onClick: props.onReattach
          },
          t('reattach')
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sdc-link',
            'data-side-chat-end': '',
            title: t('end.tip'),
            disabled: props.busy === true,
            onClick: props.onEnd
          },
          t('end')
        )
      );
    }

    function StateBlock(props) {
      return h(
        'div',
        { className: 'sdc-state' },
        h('span', { className: 'sdc-stateText' }, props.text),
        props.actionLabel
          ? h(
              'button',
              { type: 'button', className: 'sdc-stateAction', onClick: props.onAction },
              props.actionLabel
            )
          : null
      );
    }

    /**
     * 侧边 tab 的正文：认领子会话的引用 → 换作用域 → 画宿主对话外壳。
     * 组件不持有任何「每个会话一份」的写状态，全部来自 `attachments` 缓存。
     */
    function SideChatTab(props) {
      const t =
        typeof props.t === 'function'
          ? props.t
          : function (key) {
              return key;
            };
      const parentId = props.parentSessionId || props.sessionId;
      const attachments = runtime ? runtime.attachments : undefined;

      const [entry, setEntry] = React.useState(function () {
        return attachments ? attachments.peek(parentId) : undefined;
      });
      const [failure, setFailure] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [ended, setEnded] = React.useState(false);
      const [revision, setRevision] = React.useState(0);

      React.useEffect(
        function () {
          if (!attachments || ended) return undefined;
          let cancelled = false;
          const current = attachments.peek(parentId);
          if (current && current.phase === 'ready') {
            setEntry(current);
            return undefined;
          }
          attachments.ensure(parentId).then(
            function (next) {
              if (!cancelled) {
                setEntry(next);
                setFailure(null);
              }
            },
            function (error) {
              if (!cancelled) setFailure(messageOf(error));
            }
          );
          return function () {
            cancelled = true;
          };
        },
        [attachments, parentId, revision, ended]
      );

      /** 所有动作共用的「忙时忽略、错就写在脸上」外壳。 */
      function act(run) {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        Promise.resolve()
          .then(run)
          .then(
            function () {
              setBusy(false);
            },
            function (error) {
              setBusy(false);
              setFailure(messageOf(error));
            }
          );
      }

      function handleReattach() {
        if (!attachments) return;
        act(function () {
          return attachments.reattach(parentId).then(function (next) {
            setEntry(next);
            setEnded(false);
          });
        });
      }

      function handleEnd() {
        if (!attachments) return;
        act(function () {
          return attachments.end(parentId).then(function () {
            setEntry(undefined);
            setEnded(true);
          });
        });
      }

      function handleRestart() {
        setEnded(false);
        setFailure(null);
        setRevision(function (value) {
          return value + 1;
        });
      }

      function handleRetry() {
        setFailure(null);
        setRevision(function (value) {
          return value + 1;
        });
      }

      const style = h('style', null, CSS);

      if (!attachments) {
        return h(
          'div',
          { className: 'sdc-root', 'data-side-chat': 'unavailable' },
          style,
          h(StateBlock, { text: t('state.unavailable') })
        );
      }

      if (failure) {
        return h(
          'div',
          { className: 'sdc-root', 'data-side-chat': 'failed' },
          style,
          h(StateBlock, { text: t('state.failed', { message: failure }), actionLabel: t('state.retry'), onAction: handleRetry })
        );
      }

      if (ended) {
        return h(
          'div',
          { className: 'sdc-root', 'data-side-chat': 'ended' },
          style,
          h(StateBlock, { text: t('state.ended'), actionLabel: t('state.restart'), onAction: handleRestart })
        );
      }

      if (!entry) {
        return h(
          'div',
          { className: 'sdc-root', 'data-side-chat': 'attaching' },
          style,
          h(StateBlock, { text: t('state.attaching') })
        );
      }

      const ready = entry.phase === 'ready' && entry.ref;
      return h(
        'div',
        { className: 'sdc-root', 'data-side-chat': 'ready' },
        style,
        h(SideChatStrip, {
          t: t,
          busy: busy,
          onReattach: handleReattach,
          onEnd: handleEnd
        }),
        h(
          'div',
          { className: 'sdc-body' },
          ready && typeof props.SessionProvider === 'function' && typeof props.renderSlot === 'function'
            ? h(props.SessionProvider, { session: entry.ref }, props.renderSlot(SLOT_CHAT, {}))
            : h(StateBlock, { text: t('state.unavailable') })
        )
      );
    }
    // #endregion

    // #region apply
    function apply(ctx) {
      const t = ctx.locale.bind(NS);

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
      }, 'side-chat: copy');

      const attachments = createAttachments(ctx, t);
      runtime = {
        ctx: ctx,
        t: t,
        attachments: attachments,
        right: ctx.sidebarRight
      };
      ctx.effect(function () {
        return function () {
          attachments.dispose();
          if (runtime && runtime.attachments === attachments) runtime = null;
        };
      }, 'side-chat: attachments');

      // 1) 右侧栏的 tab 类型（页类型：不挂资源地址，按 kind 打开）。
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          keepMounted: true,
          title: function () {
            return t('tab.title');
          },
          guide: [
            {
              id: 'side',
              order: 30,
              title: function () {
                return t('guide.title');
              },
              description: function () {
                return t('guide.description');
              },
              icon: SideChatIcon
            }
          ]
        });
      }, 'side-chat: tab type');

      // 2) tab 正文；子槽位让 SessionProvider 能把作用域换成侧边会话。
      ctx.effect(function () {
        return ctx.slots.inject(SLOT_TAB, function () {
          const children = {};
          children[SLOT_CHAT] = { kind: 'single', scope: 'session' };
          return ctx.slots.register(
            { name: SLOT_TAB, key: TAB_ID, locale: NS, children: children },
            SideChatTab
          );
        });
      }, 'side-chat: tab body');

      // 3) 侧边会话自己的对话槽位。
      ctx.effect(function () {
        return ctx.slots.inject(SLOT_CHAT, function () {
          return ctx.slots.register({ name: SLOT_CHAT, locale: NS }, SideChatConversation);
        });
      }, 'side-chat: conversation');

      // 4) 会话 header 里的入口。
      ctx.effect(function () {
        return ctx.slots.inject(SLOT_TRIGGER, function () {
          return ctx.slots.register(
            { name: SLOT_TRIGGER, id: 'side-chat-trigger', order: TRIGGER_ORDER, locale: NS },
            SideChatTrigger
          );
        });
      }, 'side-chat: header trigger');
    }
    // #endregion

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'],
      apply: apply,
      __internals: {
        NS: NS,
        TAB_KIND: TAB_KIND,
        TAB_ID: TAB_ID,
        SLOT_CHAT: SLOT_CHAT,
        SLOT_TAB: SLOT_TAB,
        SLOT_TRIGGER: SLOT_TRIGGER,
        STORAGE_PREFIX: STORAGE_PREFIX,
        DICT: DICT,
        CSS: CSS,
        resolvePhase: resolvePhase,
        messageOf: messageOf,
        truncate: truncate,
        readChild: readChild,
        writeChild: writeChild,
        clearChild: clearChild,
        createAttachments: createAttachments,
        runtimeOf: function () {
          return runtime;
        },
        openSideTab: openSideTab,
        SideChatTrigger: SideChatTrigger,
        SideChatTab: SideChatTab,
        SideChatConversation: SideChatConversation,
        SideChatStrip: SideChatStrip,
        ChatOnlyView: ChatOnlyView
      }
    };
  }
});
