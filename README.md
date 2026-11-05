# 📺哔哩哔哩视频下载器（搭手插件版）

B 站视频下载器：普通视频、充电视频、番剧、电视剧、电影、课程都能下载，带图形界面、nfo 刮削、广告标记、字幕下载、弹幕下载，方便把视频加入 Emby 等媒体库。

本工程由原 [bilibili-video-downloader](https://github.com/lanyeeee/bilibili-video-downloader)（Tauri v2）迁移为搭手（da-shou）插件：前端页面保留，Rust 后端整体改写为运行在插件 core 里的 Node 脚本。

## ✨ 主要特性

| 特性 | 说明 |
| :--- | :--- |
| 🖥️ 图形界面 | 基于搭手插件窗口（Vue 3 + naive-ui），保留原应用的布局与交互 |
| ⚡ 分片下载 | 2MB 分片并发下载，支持断点续传、暂停/继续/重来/批量操作 |
| 📁 自定义命名 | `bv号`、`标题`、`分P`、`发布时间`、`UP昵称` 自由组合目录与文件名 |
| 🔍 视频搜索 | 视频（av/bv）、番剧（ep/ss）、课程（ep/ss）、UP 投稿（uid）、收藏夹（fid） |
| 👤 账号相关 | Cookie 登录、二维码登录；收藏夹、历史记录、稍后再看、追番追剧 |
| 🎬 视频下载 | 合集、分P、充电视频、番剧、课程；AVC / HEVC / AV1；8K / 杜比视界 / HDR / 4K 等 |
| 🎵 音频下载 | Hi-Res 无损、杜比全景声、192K / 132K / 64K |
| 📝 字幕下载 | 获取全部 CC 字幕并以 `srt` 保存 |
| 🖼️ 封面下载 | 下载最高清、无压缩的原始封面 |
| 💬 弹幕下载 | `xml` / `json` / 可定制样式的 `ass` 字幕 |
| 📺 NFO 刮削 | 同时下载 poster / fanart，方便加入 Emby 等媒体库 |
| 🎞️ 章节标记 | 把原视频章节信息写入 mp4 元数据 |
| 🚫 广告标记 | 把广告片段以章节形式写入 mp4，兼容播放器可自动跳过 |

原项目的进程内动态库插件系统没有迁移（搭手宿主不加载第三方二进制插件）。

## 📥 安装

构建产物在 `dashou-dist/`：

- `com.dashou.bilibili-<version>.dsp` —— 安装包
- `com.dashou.bilibili/` —— 解包目录（用于检查包内容）

在搭手「插件管理 → 安装插件」选择 `.dsp`，或直接双击 `.dsp`。

## 🛠️ 构建

前提：Node.js、pnpm。

```bash
pnpm install
pnpm build            # 类型检查 + 前端构建
pnpm plugin:build     # 打包成 dashou-dist/com.dashou.bilibili-<version>.dsp
```

## 🧑‍💻 开发

```bash
pnpm dev              # Vite dev server（http://localhost:5176）
```

在搭手「开发者工具 → 添加项目」选择本工程的 `src-dashou/`，点「开发 / 打开」。修改页面由 dev server 热更新；修改 `src-dashou/*.ts`（core）后点「重新加载」。

## 📂 结构

```text
.
├── src/                    # 原 Vite 前端工程（页面、组件、状态）
│   ├── bindings.ts         # 类型 + 调用层（已改为搭手插件 API）
│   ├── ffmpeg.ts           # 窗口侧 ffmpeg 封装（拿退出码）
│   └── ffmpegBridge.ts     # 接收 core 的 ffmpeg 任务并回传结果
├── src-dashou/             # 插件根
│   ├── plugin.json         # 插件清单（权限、窗口、命令）
│   ├── index.ts            # core 入口：definePluginApi + API 表
│   ├── bili.ts             # B 站接口客户端（WBI、二维码、弹幕 protobuf）
│   ├── download.ts         # 下载任务 / 分片 / 断点续传
│   ├── danmaku.ts          # 弹幕 XML / ASS
│   ├── nfo.ts              # movie / tvshow / episodedetails NFO
│   ├── net.ts              # Node 网络层与代理
│   └── ...
└── dashou-dist/            # 构建产物
```

## 🔐 权限

插件申请的能力：

- 窗口：事件监听、窗口关闭/最小化/最大化/置顶、系统文件选择框、ffmpeg
- core：写插件日志

网络请求、文件读写、ffmpeg 调度都在 core 的 Node 环境完成；窗口只负责展示。

## ⚠️ 说明

- 登录状态、下载目录、配置保存在插件的私有数据目录。卸载插件会一并删除。
- 高画质（1080P+ / 4K / 杜比 / 8K）通常需要登录且有对应大会员权限。
- 部分接口会触发 B 站风控（HTTP 412），稍后重试或登录后再试。

## 📄 License

MIT。原项目版权归 [lanyeeee](https://github.com/lanyeeee) 所有。
