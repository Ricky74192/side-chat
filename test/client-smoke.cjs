/**
 * 零依赖冒烟测试：不装 DSH、不开浏览器，按宿主的方式把 client.js 喂一遍。
 *
 * 覆盖：
 *   1) 模块契约：`__ModuleLoader__.load` → 工厂返回 `{inject, apply, __internals}`；
 *   2) 注册面：语言包、右侧栏 tab 类型（kind/id/keepMounted/guide）、三个座位
 *      （header 触发按钮 / `sidebar.right.pane.tab` / 自建会话子槽位）；
 *   3) 文案：中英 key 集合一致，源码里用到的每个 key 都存在；CSS 只引用主题变量；
 *   4) 附着关系：没有记录 → fork 一次 + 落 localStorage + 改标题；已有记录 → 复用不 fork；
 *      记录失效（认领抛错 / 打开态是 error）→ 丢弃重 fork；并发只 fork 一次；
 *      重新附着 → 新 fork + 归档旧的；结束 → 归档 + 忘掉；卸载 → 释放引用；
 *   5) 组件：触发按钮点一下 → `sidebarRight.openTab('sidechat')`（它抛错也不外溢）；
 *      侧边 tab 的三种状态（attaching / ready / ended）与 ready 态里 SessionProvider 拿到的引用；
 *      顶部条两个按钮、宿主能力缺失时的降级；
 *   6) 相位判据 `resolvePhase`：fork 出来的非空会话直接 active，空会话走 hero/settling。
 *
 * 跑法：node plugins/side-chat/test/client-smoke.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

let checks = 0;
let failures = 0;
function ok(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log('  ok    ' + name);
    return;
  }
  failures += 1;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
function deepEq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) + ' vs ' + JSON.stringify(expected));
}

// #region 假 React
function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2).flat(Infinity).filter(function (kid) {
    return kid !== null && kid !== undefined && kid !== false;
  });
  const merged = Object.assign({}, props);
  if (children.length > 0) merged.children = children;
  return { type: type, props: merged };
}

/** 一次渲染用的假 React：useState 给初值、useEffect 立即跑并收集清理函数。 */
function makeReact(effects) {
  const values = [];
  let cursor = 0;
  return {
    createElement: createElement,
    useState: function (init) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) values[index] = typeof init === 'function' ? init() : init;
      return [
        values[index],
        function (next) {
          values[index] = typeof next === 'function' ? next(values[index]) : next;
        }
      ];
    },
    useEffect: function (effect) {
      const cleanup = effect();
      if (typeof cleanup === 'function') effects.push(cleanup);
    }
  };
}

/** 把一棵假元素树里的可见文字摊平（跳过 <style>，函数组件按宿主方式调一次）。 */
function texts(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach(function (kid) {
      texts(kid, acc);
    });
    return acc;
  }
  if (node.type === 'style') return acc;
  if (typeof node.type === 'function') return texts(node.type(node.props), acc);
  if (node.props && node.props.children) texts(node.props.children, acc);
  return acc;
}

/** 深度优先找第一个满足条件的节点（同样跳过 <style>）。 */
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const kid of node) {
      const hit = find(kid, predicate);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node.type === 'style') return undefined;
  if (predicate(node)) return node;
  if (node.props && node.props.children) {
    const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    for (const kid of kids) {
      const hit = find(kid, predicate);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 假 React 只搭树不渲染函数组件；需要看子组件产物时手动调一次。 */
function renderOnce(node) {
  if (node && typeof node === 'object' && typeof node.type === 'function') return node.type(node.props);
  return node;
}

function format(text, vars) {
  if (typeof text !== 'string') return String(text);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, function (whole, name) {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole;
  });
}

/** 用一份字典当翻译器（不依赖 ctx.locale）。 */
function makeT(dict) {
  return function (key, vars) {
    return typeof dict[key] === 'string' ? format(dict[key], vars) : key;
  };
}
// #endregion

// #region 假宿主
/**
 * 造一份宿主侧的 ctx 与它的记账本。
 * options:
 *   stored         Map       localStorage 的初始内容（key 已带前缀）
 *   unknown        Set       retain 时要抛「会话不存在」的 id
 *   openError      Set       认领得到、但打开态是 error 的 id
 *   titles         object    会话列表里的标题（byId）
 *   openTabThrows  boolean   openTab 抛错，验触发按钮不外溢
 */
function createEnv(options) {
  const opts = options || {};
  const record = {
    locales: [],
    registrations: [],
    tabTypes: [],
    effects: [],
    retain: [],
    release: [],
    fork: [],
    rename: [],
    archive: [],
    openTab: [],
    getCalls: []
  };
  const dicts = {};
  const liveBindings = new Map();
  const storage = opts.stored instanceof Map ? opts.stored : new Map();
  const titles = opts.titles || {};
  let forkCount = 0;

  const localStorage = {
    getItem: function (key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem: function (key, value) {
      storage.set(key, String(value));
    },
    removeItem: function (key) {
      storage.delete(key);
    }
  };

  function makeBinding(childId) {
    const binding = {
      sessionId: childId,
      session: {
        getSnapshot: function () {
          const broken = opts.openError instanceof Set && opts.openError.has(childId);
          return { openState: broken ? 'error' : 'open', removed: false };
        },
        rename: function (title) {
          record.rename.push({ id: childId, title: title });
          return Promise.resolve({ ok: true, value: { title: title } });
        }
      },
      eventSource: {
        getSnapshot: function () {
          return { entries: [], hasMore: false, revision: 0 };
        }
      }
    };
    liveBindings.set(childId, binding);
    return binding;
  }

  const sessions = {
    list: {
      getSnapshot: function () {
        return { byId: titles };
      }
    },
    retain: function (target, retainOptions) {
      const id = typeof target === 'string' ? target : target.sessionId;
      record.retain.push({ id: id, source: retainOptions && retainOptions.source });
      if (opts.unknown instanceof Set && opts.unknown.has(id)) throw new Error('unknown session ' + id);
      const binding = makeBinding(id);
      return {
        sessionId: id,
        binding: binding,
        ready: Promise.resolve(binding),
        release: function () {
          record.release.push(id);
          if (liveBindings.get(id) === binding) liveBindings.delete(id);
        }
      };
    },
    binding: function (id) {
      return liveBindings.get(id);
    },
    fork: function (request) {
      record.fork.push(request.sessionId);
      forkCount += 1;
      return Promise.resolve('side-' + forkCount);
    }
  };

  const uiWorkspace = {
    archiveSession: function (sessionId, archiveOptions) {
      record.archive.push({ id: sessionId, options: archiveOptions });
      return Promise.resolve();
    }
  };

  const ctx = {
    sessions: sessions,
    locale: {
      bind: function (ns) {
        return function (key, vars) {
          const dict = dicts[ns] || {};
          return typeof dict[key] === 'string' ? format(dict[key], vars) : key;
        };
      },
      register: function (ns, dictionaries) {
        record.locales.push({ ns: ns, dictionaries: dictionaries });
        dicts[ns] = dictionaries.zh;
        return function () {};
      }
    },
    effect: function (fn, label) {
      const dispose = fn();
      record.effects.push({ label: label, dispose: dispose });
      return dispose;
    },
    slots: {
      inject: function (name, callback) {
        const before = record.registrations.length;
        const dispose = callback();
        for (let index = before; index < record.registrations.length; index += 1) {
          record.registrations[index].slot = name;
        }
        return typeof dispose === 'function' ? dispose : function () {};
      },
      register: function (definition, component) {
        record.registrations.push({ definition: definition, component: component });
        return function () {};
      }
    },
    sidebarRightTabs: {
      register: function (definition) {
        record.tabTypes.push(definition);
        return function () {};
      }
    },
    sidebarRight: {
      openTab: function (kind, tabOptions) {
        record.openTab.push({ kind: kind, options: tabOptions });
        if (opts.openTabThrows) throw new Error('no on-screen session');
        return 'tab-1';
      }
    },
    get: function (name) {
      record.getCalls.push(name);
      if (name === 'uiWorkspace') return uiWorkspace;
      return undefined;
    }
  };

  return {
    ctx: ctx,
    record: record,
    storage: storage,
    sessions: sessions,
    localStorage: localStorage,
    readStored: function (key) {
      return storage.has(key) ? storage.get(key) : undefined;
    }
  };
}

/** 加载 client.js，返回工厂产出的模块（每次调用都是新的一代，绑定自己那份 window）。 */
function loadModule(env) {
  const effects = [];
  const logged = [];
  let definition = null;
  const sandbox = {
    window: {
      localStorage: env.localStorage,
      __ModuleLoader__: {
        load: function (def) {
          definition = def;
        }
      }
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: {
      log: function () {},
      error: function () {
        logged.push(Array.prototype.slice.call(arguments).map(String).join(' '));
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  if (!definition) throw new Error('client.js 没有调用 __ModuleLoader__.load');
  if (definition.id !== '@local/side-chat') throw new Error('id 不对：' + definition.id);
  const plugin = definition.factory(function (id) {
    if (id !== 'react') throw new Error('意外 require：' + id);
    return makeReact(effects);
  });
  plugin.__effects = effects;
  plugin.__logged = logged;
  return plugin;
}

/** 造环境 + 加载模块 + 跑 apply：一份独立的一代宿主。 */
function boot(options, runApply) {
  const env = createEnv(options);
  const plugin = loadModule(env);
  if (runApply !== false) plugin.apply(env.ctx);
  return { env: env, plugin: plugin, I: plugin.__internals, t: makeT(plugin.__internals.DICT.zh) };
}
// #endregion

async function main() {
  // #region 1) 模块契约
  console.log('\n[1] 模块契约');
  const base = boot({ titles: { p1: { title: '主对话标题', blank: false } } });
  const plugin = base.plugin;
  const I = base.I;
  ok('工厂返回 apply', typeof plugin.apply === 'function');
  deepEq('inject 覆盖五个必需服务', plugin.inject, [
    'slots',
    'locale',
    'sessions',
    'sidebarRight',
    'sidebarRightTabs'
  ]);
  ok('导出 internals 供测试驱动', typeof I.createAttachments === 'function');
  // #endregion

  // #region 2) 注册面
  console.log('\n[2] 注册面');
  deepEq(
    '语言包注册在 sideChat 命名空间',
    base.env.record.locales.map(function (row) {
      return row.ns;
    }),
    ['sideChat']
  );

  eq('tab 类型只注册一次', base.env.record.tabTypes.length, 1);
  const tabType = base.env.record.tabTypes[0];
  eq('tab id', tabType.id, '@local/side-chat');
  eq('tab kind', tabType.kind, 'sidechat');
  eq('tab 优先档 extension', tabType.priority, 'extension');
  eq('keepMounted 保活侧边正文', tabType.keepMounted, true);
  eq('tab chip 文字', tabType.title('addr'), '侧边对话');
  eq('引导页一个入口', tabType.guide.length, 1);
  eq('引导页入口标题', tabType.guide[0].title(), '侧边对话');
  eq('引导页入口图标是组件', typeof tabType.guide[0].icon, 'function');

  const bySlot = function (slot) {
    return base.env.record.registrations.filter(function (row) {
      return row.slot === slot;
    });
  };

  const triggerRegs = bySlot('conversation.session.header.utilities');
  eq('header 触发按钮注册一次', triggerRegs.length, 1);
  eq('触发按钮 id', triggerRegs[0].definition.id, 'side-chat-trigger');
  eq('触发按钮排在 header 工具组最前', triggerRegs[0].definition.order, -20);

  const tabRegs = bySlot('sidebar.right.pane.tab');
  eq('tab 正文注册一次', tabRegs.length, 1);
  eq('tab 正文 key 等于类型 id', tabRegs[0].definition.key, '@local/side-chat');
  deepEq(
    'tab 正文声明自建会话子槽位',
    tabRegs[0].definition.children['side.chat.conversation'],
    { kind: 'single', scope: 'session' }
  );

  const chatRegs = bySlot('side.chat.conversation');
  eq('会话槽位注册一次', chatRegs.length, 1);

  ok(
    '三个座位都是真组件',
    [triggerRegs[0], tabRegs[0], chatRegs[0]].every(function (row) {
      return typeof row.component === 'function';
    })
  );
  ok(
    '三个座位都带 locale 命名空间（组件才拿得到 t）',
    [triggerRegs[0], tabRegs[0], chatRegs[0]].every(function (row) {
      return row.definition.locale === 'sideChat';
    })
  );
  eq('apply 之后 runtime 就位', typeof I.runtimeOf().attachments.ensure, 'function');
  // #endregion

  // #region 3) 文案与样式
  console.log('\n[3] 文案与样式');
  deepEq('中英 key 集合一致', Object.keys(I.DICT.zh).sort(), Object.keys(I.DICT.en).sort());
  const used = new Set();
  const callRe = /\bt\(\s*'([a-zA-Z.]+)'/g;
  let match = callRe.exec(SOURCE);
  while (match) {
    used.add(match[1]);
    match = callRe.exec(SOURCE);
  }
  deepEq(
    '源码里用到的 key 都在字典里',
    Array.from(used).filter(function (key) {
      return !(key in I.DICT.zh);
    }),
    []
  );
  ok('用到的 key 数量合理（≥ 15）', used.size >= 15, 'used=' + used.size);
  ok('CSS 只引用主题变量', /--dsw-alias-|--dsw-radius-/.test(I.CSS) && !/#[0-9a-fA-F]{3,6}\b/.test(I.CSS));
  ok('CSS 带插件前缀', I.CSS.indexOf('.sdc-') === 0);
  // #endregion

  // #region 4) 附着关系
  console.log('\n[4] 附着关系');
  const PREFIX = I.STORAGE_PREFIX;

  // 4.1 没有记录 → fork 一次
  const A = boot({ titles: { p1: { title: '主对话标题', blank: false } } });
  const managerA = A.I.createAttachments(A.env.ctx, A.t);
  const firstA = await managerA.ensure('p1');
  deepEq('无记录时 fork 主会话', A.env.record.fork, ['p1']);
  eq('认领 fork 出来的子会话', firstA.childId, 'side-1');
  eq('认领用了 gateway 来源', A.env.record.retain[0].source, 'gateway');
  eq('附着关系写进 localStorage', A.env.readStored(PREFIX + 'p1'), 'side-1');
  eq('子会话被改名', A.env.record.rename[0].title, '侧边对话 · 主对话标题');

  const againA = await managerA.ensure('p1');
  ok('再取一次复用同一个引用', againA === firstA);
  eq('不会重复 fork', A.env.record.fork.length, 1);
  eq('不会重复认领', A.env.record.retain.length, 1);

  // 4.2 有记录且认得到 → 不 fork
  const stored = new Map();
  stored.set(PREFIX + 'p2', 'side-old');
  const B = boot({ stored: stored });
  const managerB = B.I.createAttachments(B.env.ctx, B.t);
  const firstB = await managerB.ensure('p2');
  eq('复用记下的子会话', firstB.childId, 'side-old');
  eq('复用时零 fork', B.env.record.fork.length, 0);
  eq('复用时零改名', B.env.record.rename.length, 0);

  // 4.3 记录失效（认领抛错）→ 丢掉重 fork
  const staleStorage = new Map();
  staleStorage.set(PREFIX + 'p3', 'ghost');
  const C = boot({ stored: staleStorage, unknown: new Set(['ghost']) });
  const managerC = C.I.createAttachments(C.env.ctx, C.t);
  const firstC = await managerC.ensure('p3');
  eq('失效记录被换掉', firstC.childId, 'side-1');
  eq('失效记录触发 fork', C.env.record.fork.length, 1);
  eq('localStorage 被改写', C.env.readStored(PREFIX + 'p3'), 'side-1');

  // 4.4 记录能认领但打开态是 error → 也丢掉重 fork
  const brokenStorage = new Map();
  brokenStorage.set(PREFIX + 'p4', 'broken');
  const D = boot({ stored: brokenStorage, openError: new Set(['broken']) });
  const managerD = D.I.createAttachments(D.env.ctx, D.t);
  const firstD = await managerD.ensure('p4');
  eq('打开态 error 的记录被换掉', firstD.childId, 'side-1');
  ok('坏引用被释放', D.env.record.release.indexOf('broken') >= 0, JSON.stringify(D.env.record.release));

  // 4.5 并发打开只 fork 一次
  const E = boot();
  const managerE = E.I.createAttachments(E.env.ctx, E.t);
  const both = await Promise.all([managerE.ensure('p5'), managerE.ensure('p5')]);
  eq('并发 ensure 只 fork 一次', E.env.record.fork.length, 1);
  ok('并发 ensure 拿到同一份', both[0] === both[1]);

  // 4.6 重新附着：新 fork + 归档旧的
  const beforeReattach = firstA.childId;
  const nextA = await managerA.reattach('p1');
  eq('重新附着产生新子会话', nextA.childId, 'side-2');
  eq('旧子会话被归档', A.env.record.archive[0].id, beforeReattach);
  deepEq('归档时停掉活动', A.env.record.archive[0].options, { stopActivity: true });
  ok('旧引用被释放', A.env.record.release.indexOf(beforeReattach) >= 0, JSON.stringify(A.env.record.release));
  eq('localStorage 指向新子会话', A.env.readStored(PREFIX + 'p1'), 'side-2');

  // 4.7 结束：归档 + 忘掉
  await managerA.end('p1');
  eq('结束后忘掉记录', A.env.readStored(PREFIX + 'p1'), undefined);
  eq('结束后归档当前子会话', A.env.record.archive[1].id, 'side-2');
  eq('结束后缓存清空', managerA.peek('p1'), undefined);

  // 4.8 关闭 tab 不等于结束：引用还在，缓存不丢
  const F = boot();
  const managerF = F.I.createAttachments(F.env.ctx, F.t);
  const firstF = await managerF.ensure('p6');
  ok('缓存里还留着', managerF.peek('p6') === firstF);
  eq('没有归档', F.env.record.archive.length, 0);

  // 4.9 卸载释放引用
  managerF.dispose();
  ok('卸载释放引用', F.env.record.release.indexOf(firstF.childId) >= 0, JSON.stringify(F.env.record.release));
  eq('卸载后缓存清空', managerF.peek('p6'), undefined);

  // 4.10 空主会话 id
  let rejected = null;
  try {
    await managerF.ensure('');
  } catch (error) {
    rejected = error;
  }
  ok('空主会话 id 直接拒绝', Boolean(rejected) && typeof rejected.message === 'string', String(rejected));
  // #endregion

  // #region 5) 组件
  console.log('\n[5] 组件');
  // 5.1 触发按钮
  const G = boot({ titles: { p1: { title: '主对话', blank: false } } });
  const trigger = G.I.SideChatTrigger({ t: G.t, sessionId: 'p1' });
  eq('触发按钮有类名', trigger.props.className, 'sdc-trigger');
  eq('触发按钮带 data 标记', trigger.props['data-side-chat-trigger'], '');
  deepEq('触发按钮可见文字', texts(trigger), ['侧边对话']);
  eq('悬停提示写明不改动主对话', trigger.props.title.indexOf('不改动主对话') >= 0, true);
  trigger.props.onClick({ preventDefault: function () {}, stopPropagation: function () {} });
  eq('点一下打开 sidechat tab', G.env.record.openTab[0].kind, 'sidechat');
  eq('只开一个 tab', G.env.record.openTab.length, 1);

  // 5.2 openTab 抛错也不外溢
  const H = boot({ openTabThrows: true });
  let escaped = null;
  try {
    H.I.openSideTab('p1');
  } catch (error) {
    escaped = error;
  }
  ok('openTab 抛错被吞掉', escaped === null);
  ok(
    '抛错时留下一条日志',
    H.plugin.__logged.some(function (line) {
      return line.indexOf('打开侧边对话失败') >= 0;
    }),
    JSON.stringify(H.plugin.__logged)
  );

  // 5.3 侧边 tab：attaching 态
  const K = boot({ titles: { p9: { title: '主对话', blank: false } } });
  const attaching = K.I.SideChatTab({
    t: K.t,
    sessionId: 'p9',
    SessionProvider: function () {},
    renderSlot: function () {}
  });
  eq('未附着时是 attaching 态', attaching.props['data-side-chat'], 'attaching');
  ok('attaching 态写着「正在附着」', texts(attaching).join(' ').indexOf('正在附着') >= 0, texts(attaching).join(' '));

  // 5.3b 插件已卸载（没有 runtime）时给「不可用」，而不是永远转圈
  const L = boot({}, false);
  const noRuntime = L.I.SideChatTab({
    t: L.t,
    sessionId: 'p9',
    SessionProvider: function () {},
    renderSlot: function () {}
  });
  eq('没有 runtime 时降级', noRuntime.props['data-side-chat'], 'unavailable');

  // 5.4 侧边 tab：ready 态
  const runtimeK = K.I.runtimeOf();
  ok('runtime 里有 apply 建的附着关系', typeof runtimeK.attachments.ensure === 'function');
  const readyEntry = await runtimeK.attachments.ensure('p9');
  eq('侧边会话建好', readyEntry.childId, 'side-1');

  const providerFn = function SideChatSessionProvider() {
    return null;
  };
  const slotCalls = [];
  const readyTab = K.I.SideChatTab({
    t: K.t,
    sessionId: 'p9',
    SessionProvider: providerFn,
    renderSlot: function (name) {
      slotCalls.push(name);
      return 'conversation-here';
    }
  });
  eq('ready 态标记', readyTab.props['data-side-chat'], 'ready');
  const stripText = texts(readyTab).join(' ');
  ok('条上写着「附着主对话」', stripText.indexOf('附着主对话') >= 0, stripText);
  ok('条上有「重新附着」', stripText.indexOf('重新附着') >= 0, stripText);
  ok('条上有「结束」', stripText.indexOf('结束') >= 0, stripText);
  const providerNode = find(readyTab, function (node) {
    return node.type === providerFn;
  });
  ok('SessionProvider 拿到了侧边会话的引用', Boolean(providerNode) && providerNode.props.session === readyEntry.ref);
  deepEq('会话槽位被渲染一次', slotCalls, ['side.chat.conversation']);

  // 5.5 顶部条的两个按钮真的接到回调
  let reattachHits = 0;
  let endHits = 0;
  const strip = K.I.SideChatStrip({
    t: K.t,
    busy: false,
    onReattach: function () {
      reattachHits += 1;
    },
    onEnd: function () {
      endHits += 1;
    }
  });
  const reattachBtn = find(strip, function (node) {
    return node.props && node.props['data-side-chat-reattach'] !== undefined;
  });
  const endBtn = find(strip, function (node) {
    return node.props && node.props['data-side-chat-end'] !== undefined;
  });
  reattachBtn.props.onClick();
  endBtn.props.onClick();
  eq('「重新附着」接上回调', reattachHits, 1);
  eq('「结束」接上回调', endHits, 1);

  // 5.6 忙碌时两个按钮禁用
  const busyStrip = K.I.SideChatStrip({ t: K.t, busy: true, onReattach: function () {}, onEnd: function () {} });
  const busyBtn = find(busyStrip, function (node) {
    return node.props && node.props['data-side-chat-end'] !== undefined;
  });
  eq('忙碌时禁用', busyBtn.props.disabled, true);

  // 5.7 宿主能力缺失时给一句话而不是崩溃
  const unavailable = K.I.SideChatConversation({ t: K.t });
  ok('缺能力时降级成提示', texts(unavailable).join(' ').indexOf('不可用') >= 0, texts(unavailable).join(' '));

  // 5.8 侧边对话外壳：把宿主的 embedded 形态喂上去
  const factoryCalls = [];
  const wrapper = K.I.SideChatConversation({
    t: K.t,
    sessionId: 'side-1',
    useSession: function (selector) {
      return selector({ blank: false, awaitingFirstTurn: false, running: false, openState: 'open', promptAttempted: true });
    },
    useConversation: function (selector) {
      return selector({ activeTargets: new Set() });
    },
    useSessions: function (selector) {
      return selector({ byId: { 'side-1': { blank: false } } });
    },
    renderFactorySlot: function (name, props, options) {
      factoryCalls.push({ name: name, props: props, options: options });
      return 'embedded-conversation';
    }
  });
  const embedded = renderOnce(wrapper);
  eq('会话外壳渲染成 embedded', embedded, 'embedded-conversation');
  eq('外壳走宿主的 conversation.content', factoryCalls[0].name, 'conversation.content');
  eq('embedded 变体', factoryCalls[0].props.variant, 'embedded');
  eq('fork 出来的会话直接 active', factoryCalls[0].props.phase, 'active');
  eq('视图固定为聊天', factoryCalls[0].options.slots.views, K.I.ChatOnlyView);

  // 5.9 视图只画聊天流
  const viewCalls = [];
  K.I.ChatOnlyView({
    renderSlot: function (name, props) {
      viewCalls.push({ name: name, props: props });
      return null;
    }
  });
  eq('视图渲染 conversation.session', viewCalls[0].name, 'conversation.session');
  eq('视图选中 chat', viewCalls[0].props.view, 'chat');
  // #endregion

  // #region 6) 相位判据
  console.log('\n[6] 相位判据');
  eq('非空会话 → active', I.resolvePhase({ blank: false, awaitingFirstTurn: false, openState: 'cold' }, { activeTargets: new Set() }, undefined).phase, 'active');
  eq('加载中的空会话 → settling', I.resolvePhase({ blank: true, awaitingFirstTurn: true, openState: 'loading' }, { activeTargets: new Set() }, undefined).phase, 'settling');
  const blankOpen = I.resolvePhase({ blank: true, awaitingFirstTurn: true, openState: 'open' }, { activeTargets: new Set() }, true);
  eq('已打开的空会话 → hero', blankOpen.phase, 'hero');
  eq('hero 标记同步', blankOpen.hero, true);
  eq('正在跑的会话 → active', I.resolvePhase({ blank: true, awaitingFirstTurn: true, openState: 'open', running: true }, { activeTargets: new Set() }, true).phase, 'active');
  eq('有活动目标 → active', I.resolvePhase({ blank: true, awaitingFirstTurn: true, openState: 'open' }, { activeTargets: new Set(['x']) }, true).phase, 'active');
  // #endregion

  console.log('\n' + checks + ' 项检查，' + failures + ' 项失败');
  if (failures > 0) process.exitCode = 1;
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
