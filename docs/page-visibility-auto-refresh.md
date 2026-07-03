# 页面聚焦自动刷新（Page Visibility Auto-Refresh）

后台管理面板中切换页面"无感"且数据自动更新的核心技术。不需要 WebSocket、SSE 等实时推送方案，仅依赖浏览器原生 API。

## 核心原理

利用 `visibilitychange` 和 `focus` 事件，在用户**切回当前页面**时自动重新拉取数据并渲染。

## 事件监听

绑定两个事件：

| 事件 | 目标 | 作用 |
|------|------|------|
| `visibilitychange` | `document` | 浏览器 Tab 切换、最小化/恢复时触发 |
| `focus` | `window` | 窗口重新获得焦点（从其他应用切换回来）时触发 |

```javascript
document.addEventListener('visibilitychange', refreshAfterTabSwitch);
window.addEventListener('focus', refreshAfterTabSwitch);
```

## 核心刷新函数

```javascript
// 上次自动刷新的时间戳，用于节流
var lastAutoRefreshAt = 0;

function refreshAfterTabSwitch() {
  // 页面不可见时不做任何事
  if (document.visibilityState !== 'visible') return;

  var now = Date.now();

  // 1 秒内不重复刷新，防止 handler 重复触发
  if (now - lastAutoRefreshAt < 1000) return;

  lastAutoRefreshAt = now;

  loadAll(); // 去拉取数据
}
```

## 数据拉取

用 `Promise.all` 并发请求所有 API，全部完成后统一渲染：

```javascript
async function loadAll() {
  try {
    setStatus('正在刷新...', '');

    // 并发请求多个接口
    var results = await Promise.all([
      api('/api/overview'),
      api('/api/config'),
      api('/api/models'),
      // ...
    ]);

    state.overview = results[0];
    state.config = results[1];
    // ...

    renderAll(); // 统一渲染
    setStatus('已刷新：' + new Date().toLocaleString(), 'ok');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}
```

## 可复用的最小实现

以下是一段可以直接引入任何 HTML 页面的通用代码：

```javascript
// ===== 切回页面自动刷新 =====
(function() {
  var lastRefreshAt = 0;

  function onPageVisible() {
    if (document.visibilityState !== 'visible') return;
    var now = Date.now();
    if (now - lastRefreshAt < 1000) return;
    lastRefreshAt = now;
    refreshData();
  }

  document.addEventListener('