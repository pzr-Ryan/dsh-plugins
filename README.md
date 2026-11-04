# dsh-plugins

DeepSeek Harness（DSH）桌面端的插件合集。每个子目录是一个可独立安装的 DSH 插件包。

## 这个仓库解决什么问题

DSH 桌面端是一个 Electron 应用，窗口标题栏用的是系统原生的
minimize / maximize / close 三连按钮（`titleBarOverlay`），渲染层既不暴露
窗口控制 API，也没有"置顶"这类桌面窗口能力。

本仓库的第一个插件 `dsh-always-on-top` 补上了这个缺口：在原生按钮组左侧
加一个同款按钮，点一下就能让 DSH 工作界面始终停留在其它窗口之上——写文档、
对照网页、盯日志时不用来回切换窗口。

## 包含的插件

| 插件 | 作用 |
| --- | --- |
| [`dsh-always-on-top`](./dsh-always-on-top) | 窗口右上角新增"置顶"按钮，一键让工作界面保持在桌面最顶层 |

### dsh-always-on-top

**主要功能**

- 在窗口右上角、原生最小化按钮**左侧**新增一个图钉按钮，尺寸 / 悬停底色 /
  图标笔画与相邻的最小化、最大化、关闭按钮一致（46px 单元格、标题栏等高、无圆角）。
- 点击切换窗口的 `WS_EX_TOPMOST`，即"始终位于最顶层"；再点一次取消。
- 置顶状态会记住，下次启动 DSH 时自动恢复。
- 按钮位置用 `env(titlebar-area-x/width/height)` 计算，紧贴原生按钮组，
  不依赖写死的屏幕坐标，窗口最大化 / 还原 / 不同缩放比例下都对得齐。

**工作原理**

```
浏览器(渲染层) ──点击──> 插件 Client 半 ──fetch──> 插件 Host 半
                                                    │
                                          spawn powershell.exe
                                                    │
                                    Win32 SetWindowPos(HWND_TOPMOST)
```

渲染层拿不到原生窗口句柄，所以置顶动作放在 DSH 的 Host 进程里，
通过随包附带的 `pin-window.ps1`（P/Invoke `user32.dll`）完成。
Client 半只负责画按钮和调用插件自己的 HTTP 路由。

### 安装

1. 把仓库克隆到本地：

   ```bash
   git clone https://github.com/<your-name>/dsh-plugins.git
   ```

2. 在 DSH 中安装这个插件目录（`plugin_manager` 的 `install_bundle`，
   target 指向 `dsh-plugins/dsh-always-on-top`）：

   ```
   plugin_manager install_bundle  target = <绝对路径>\dsh-plugins\dsh-always-on-top
   ```

   DSH 会把它装进当前 profile，并在 `cordis.patch.yml` 里插入一条
   `id: dsh-always-on-top` 的 loader 记录。

3. 重载页面（`Ctrl+R`）或重启 DSH。

> 仅在 Windows 上可用：脚本通过 `user32.dll` 操作窗口，其它平台会返回
> `unsupported-platform`，按钮自动隐藏。

### 使用方法

- 打开 DSH，右上角、最小化键左边会出现一个图钉图标。
- 单击：窗口置顶（图钉变成品牌色并填充）。
- 再单击：取消置顶。
- 按钮与原生按钮组共用同一行、同一高度和同一种悬停配色，不会挡住它们。

### 输入输出示例

插件对外暴露三个 HTTP 路由（由 Host 半注册在 DSH 的 web 服务上）：

```bash
# 查询当前是否置顶
$ curl http://127.0.0.1:<dsh-port>/dsh-always-on-top/status
{"ok":true,"topmost":false,"hwnd":67696,"pid":30284}

# 切换
$ curl -X POST http://127.0.0.1:<dsh-port>/dsh-always-on-top/toggle
{"ok":true,"topmost":true,"hwnd":67696,"pid":30284}

# 显式设置
$ curl -X POST "http://127.0.0.1:<dsh-port>/dsh-always-on-top/set?on=0"
{"ok":true,"topmost":false,"hwnd":67696,"pid":30284}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `ok` | 本次操作是否成功 |
| `topmost` | 操作后窗口是否处于置顶状态 |
| `hwnd` / `pid` | 被操作的窗口句柄与进程号 |
| `reason` | 失败原因（如 `unsupported-platform`、`window-not-found`、`win32-error-5`） |

## 目录结构

```
dsh-plugins/
└── dsh-always-on-top/
    ├── package.json        # 包元数据 + dsh.bundle / dsh.client 声明
    ├── cordis.patch.yml    # 装进 profile 的 loader 补丁
    ├── index.js            # Host 半：HTTP 路由 + 调用 PowerShell
    ├── pin-window.ps1      # Win32 P/Invoke：读写 WS_EX_TOPMOST
    ├── client.js           # Client 半：标题栏按钮（shell.overlay 插槽）
    ├── icon.svg            # 插件管理器图标
    └── locale/{en,zh}.json # 插件管理器里的标题与描述
```

## 开发说明

- 插件以"工作区目录 + 软链"的方式装进 profile，改完源码重载页面即可生效，
  不需要重新安装。
- 渲染层不要直接碰 `document.body` 或替换 app root；按钮挂在
  `shell.overlay` 这个全框浮动层上，并自行开启 `pointer-events`。
- 样式只用 DSH 主题变量（`--dsw-alias-*`），深浅色主题都能跟随。

## License

MIT
