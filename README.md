# Oxipresso VSCode Extension

[Oxipresso](https://github.com/EliorFoy/oxipresso) 渲染服务器的 **VSCode 集成扩展**（TeXpresso 式实时预览）。

## 功能

- **实时增量预览**：在 VSCode 里编辑 `.tex`，右侧预览随增量重排自动刷新（未变页面零成本复用，变化页面交叉淡入）
- **编辑 → 预览同步**：输入爆发结束后自动滚动到编辑行所在的页面（正向 SyncTeX 断点映射）
- **DPI 匹配清晰渲染**：页面按 2× 96dpi 渲染（`oxipresso.renderScale` 可调）

## 使用

1. 构建渲染服务器 `oxipresso.exe`（见 [Oxipresso](https://github.com/EliorFoy/oxipresso)，需真实引擎模式）
2. 本目录 `npm install && npm run compile`（需 Node 18+ 与 VSCode 扩展开发环境）
3. 在 VSCode 中打开本目录（F5 调试运行），或在命令面板执行 **Oxipresso: Open Live Preview**

配置项（settings）：`oxipresso.enginePath`（服务器二进制路径）、`oxipresso.renderScale`、`oxipress
o.formatPath`。

## 协议

[MIT](LICENSE)。原项目：[TeXpresso](https://github.com/let-def/texpresso)（MIT）。

---

# Oxipresso VSCode Extension (English)

A **VSCode integration extension** for the [Oxipresso](https://github.com/EliorFoy/oxipresso) render server (TeXpresso-style live preview).

## Features

- **Live incremental preview**: edit a `.tex` file, and the preview refreshes with each incremental re-typeset (unchanged pages are reused for free, changed pages cross-fade in)
- **Editor → preview sync**: ~350ms after a typing burst settles, the preview scrolls to the page containing your cursor line (forward SyncTeX breakpoint map)
- **DPI-matched crisp rendering**: pages render at 2× 96dpi by default (`oxipresso.renderScale`)

## Usage

1. Build the render server `oxipresso.exe` (see [Oxipresso](https://github.com/EliorFoy/oxipresso), real-engine mode)
2. In this directory: `npm install && npm run compile`
3. Open this folder in VSCode (F5 to debug), or run **Oxipresso: Open Live Preview** from the command palette

Settings: `oxipresso.enginePath`, `oxipresso.renderScale`, `oxipresso.formatPath`.

## License

[MIT](LICENSE). Original project: [TeXpresso](https://github.com/let-def/texpresso) (MIT).
