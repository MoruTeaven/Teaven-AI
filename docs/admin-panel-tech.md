# 管理面板流畅体验方案

实现"切换无感 + 数据按需加载 + 自动刷新"的技术组合，零依赖。

---

## 一、SPA Hash 路由（无感切换）

所有 section 写在同一 HTML 中，通过 CSS `display` 控制显隐，切换只改 `#` hash，不触发网络请求。

```html
<!-- 侧边栏每个链接绑定一个 data-section -->
<a href="#dashboard" data-section="dashboard">仪表盘</a>
<a href="#users" data-section="users">用户管理</a>

<!-- 每个页面是一个 section -->
<section id="dashboard" class="section active">...</section>
<section id="users" class="section">...</section>
```

```css
.section { display: none; }
.section.active { display: block; }
```

```javascript
var titles = { dashboard: '仪表盘', users: '用户管理', tasks: '任务管理' };

function showSection(section) {
  section = titles[section] ? section : 'dashboard';
  document.querySelectorAll('.section').forEach(function (el) {
    el.classList.toggle('active', el.id === section);
  });
  document.querySelectorAll('.nav a').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-section') === section);
  });
  document.getElementById('page-title').textContent = titles[section];
}

// 侧边栏点击切换
document.querySelector('.nav').addEventListener('click', function (e) {
  var link = e.target.closest('[data-section]');
  if (link) showSection(link.getAttribute('data-section'));
});

// 页面初始化恢复上次页面
showSection((location.hash || '#dashboard').slice(1));
```

---

## 二、分层按需加载（Layered Loading）

按数据特征分三层：

| 层级 | 特征 | 加载时机 | 示例 |
|------|------|---------|------|
| **L0 实时指标** | 轻量、需最新 | 每次切回该页重新拉 | overview |
| **L1 列表/配置** | 中等量、变化少 | 首次随 L0 一起预加载，缓存住 | models, users, config |
| **L2 分页/详情** | 量大、用户触发 | 翻页/点击时随用随拉 | tasks 第 N 页 |

```javascript
var loaded = {};         // L1 缓存标记
var pageCache = {};      // L2 分页缓存
var currentTaskPage = 0;

// 页面初始化：预加载 L0 + 所有 L1
async function initData() {
  var results = await Promise.all([
    api('/api/overview'),              // L0
    api('/api/models'),                // L1
    api('/api/users'),                 // L1
    api('/api/tasks?limit=50')         // L1（首页）
  ]);
  renderDashboard(results[0]);
  renderModels(results[1]);
  renderUsers(results[2]);
  renderTasks(results[3]);

  // 标记 L1 已加载
  ['models', 'users', 'tasks'].forEach(function (key) { loaded[key] = true; });
}

// showSection 增强：L0 切回刷新，L1 直接显示
function showSection(section) {
  section = titles[section] ? section : 'dashboard';
  // ...切换 DOM 显隐（同上）...

  if (section === 'dashboard') {
    // L0: 切回仪表盘重新拉
    api('/api/overview').then(renderDashboard);
  }
  // L1 数据已预加载，直接显示，不做额外请求
}
```

### L1 优化：Stale-While-Revalidate

已加载的 L1 页面，切换时**先展示缓存**（瞬间显示），然后**后台静默刷新**：

```javascript
function showSection(section) {
  // ...切换 DOM 显隐...
  if (section === 'dashboard') return api('/api/overview').then(renderDashboard);
  if (loaded[section]) {
    refreshL1InBackground(section); // 不 await，后台静默更新
  } else {
    loaded[section] = true;
    loadL1(section); // 首次加载，有 loading
  }
}
async function refreshL1InBackground(section) {
  try {
    var data = await api('/api/' + section);
    updateUI(section, data); // 静默更新
  } catch (e) { /* 静默失败，保留缓存 */ }
}
```

### L2 优化：预加载前/后页

当前页显示后，后台预加载相邻页。用户翻页时从缓存读取，**瞬间显示**：

```javascript
async function loadTasksPage(page) {
  currentTaskPage = page;
  // 有缓存就用缓存
  if (pageCache[page]) {
    renderTasks(pageCache[page]);
  } else {
    var data = await api('/api/tasks?limit=50&offset=' + (page * 50));
    pageCache[page] = data;
    renderTasks(data);
  }
  // 后台预加载前一页和后一页
  prefetchPage(page - 1);
  prefetchPage(page + 1);
}
async function prefetchPage(page) {
  if (page < 0 || pageCache[page]) return;
  try {
    pageCache[page] = await api('/api/tasks?limit=50&offset=' + (page * 50));
  } catch (e) { /* 静默失败 */ }
}

// 直接跳转到指定页（如 #tasks?page=10），预加载相邻页
async function jumpToPage(page) {
  await loadTasksPage(page);
  prefetchPage(page - 1);
  prefetchPage(page + 1);
}
```

### 操作后局部刷新

只清除受影响的 section 缓存，不重拉所有数据：

```javascript
async function saveModel(model) {
  await api('/api/models', { method: 'POST', body: JSON.stringify({ model: model }) });
  loaded['models'] = false;      // 清除 models 缓存
  loaded['dashboard'] = false;   // 统计也受影响
  await Promise.all([
    loadL1('models'),
    api('/api/overview').then(renderDashboard)
  ]);
}
```

### 聚焦刷新只刷当前页

```javascript
function refreshCurrentSection() {
  var section = (location.hash || '#dashboard').slice(1);
  if (section === 'dashboard') {
    api('/api/overview').then(renderDashboard);            // L0
  } else if (section === 'tasks') {
    loadTasksPage(currentTaskPage);                         // L2
  } else {
    loaded[section] = false;
    loadL1(section);                                        // L1
  }
}
```

---

## 三、页面聚焦自动刷新（Visibility API）

利用 `visibilitychange` + `focus` 事件，切回页面时自动刷新当前 section。**不需要 WebSocket、SSE 或定时轮询**。

```javascript
document.addEventListener('visibilitychange', onPageVisible);
window.addEventListener('focus', onPageVisible);

var lastAutoRefreshAt = Date.now();

function onPageVisible() {
  if (document.visibilityState !== 'visible') return;
  var now = Date.now();
  if (now - lastAutoRefreshAt < 1000) return; // 1s 防抖
  lastAutoRefreshAt = now;
  refreshCurrentSection(); // 只刷新当前活跃 section
}
```

核心思路：**用户不在看页面时不需要更新，切回来时再刷新**，兼顾实时感与资源开销。

---

## 四、完整优化链路

| 操作 | 用户感知 | 实际发生 |
|------|---------|---------|
| 页面打开 | 所有数据就绪 | 预加载 L0 + 所有 L1 |
| 切到页面 A | **瞬间显示** | 展示缓存 → 后台静默刷新 L1 |
| 切回仪表盘 | 看到最新指标 | 重新拉 L0 |
| 看任务第 0 页 | 看到数据 | 拉 L2 第 0 页 → 预加载第 1 页 |
| 点下一页 | **瞬间翻页** | 从缓存读第 1 页 → 预加载第 2 页 |
| 聚焦回来 | 自动更新 | 只刷新当前活跃 section |
| 保存/删除 | 局部更新 | 清除受影响 section 缓存，刷新局部 |

## 五、要点总结

| 技术 | 作用 | 关键代码 |
|------|------|---------|
| **Hash 路由** | 无网络切换 | `classList.toggle('active', ...)` |
| **L0 实时指标** | 不缓存，切回刷新 | `api('/api/overview')` |
| **L1 列表/配置** | 预加载 + 缓存 | `loaded[key] = true` 标记 |
| **L2 分页** | 预加载前后页 | `prefetchPage(page±1)` |
| **Visibility API** | 聚焦自动刷新 | `visibilitychange` + `focus` |
| **Stale-While-Revalidate** | 先展示缓存，后台静默更新 | `refreshL1InBackground()` |

> 适用场景：管理后台、Dashboard、监控面板、配置工具等（总 HTML 字数 < 10000）。内容型网站建议按需加载路由。