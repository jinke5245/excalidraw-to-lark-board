# Excalidraw to Lark Board

把 `.excalidraw` 导入飞书或 Lark 画板。传入文档链接会在文末新建画板，传入画板直达链接会导入已有画板。

## 安装

- 运行 CLI 需要 Node.js 22.12 及以上版本。从源码安装和构建时使用 pnpm。
- 自动截图需要本机 Chrome，可通过 `FEISHU_CHROME_PATH` 指定可执行文件。
- 导入飞书需要具有编辑权限的账号，并通过 `lark-cli auth login` 登录。

在仓库根目录安装依赖。

```sh
pnpm install --frozen-lockfile
pnpm build
```

## 使用

传入 Docx 或 Wiki 文档链接，工具会先转换节点并生成截图，再新建画板。终端会输出画板直达链接，标准输出为提交给飞书的节点 JSON。

```sh
node dist/index.js examples/feishu-auto-screenshot-poc.excalidraw \
  'https://your-tenant.feishu.cn/wiki/DOCUMENT_TOKEN'
```

把第二个参数换成文档地址带 `#画板块ID` 的直达链接，即可导入已有画板。也可使用 `--whiteboard-token` 指定已知的画板 token。

只传文件路径可生成节点 JSON。下面的基础样例无需调用飞书。

```sh
node dist/index.js examples/feishu-poc.excalidraw
```

包含图片或截图元素的场景需要指定导入目标，以便上传图片取得素材 token。还可通过 `--snapshot 元素ID=文件.png` 覆盖自动截图。

## 样例

- [全功能样例](examples/feishu-auto-screenshot-poc.excalidraw)覆盖矩形、椭圆、菱形、文字、箭头绑定、Frame 分区、线条、自由笔迹、便签、图片及三类截图元素。
- `iframe`、`magicframe` 和 `embeddable` 自动导入为图片。`embeddable` 同时保留指向原网页的可点击链接。网页截图适用于可公开访问且可静态渲染的页面。
- [基础样例](examples/feishu-poc.excalidraw)包含带中文标签的形状和绑定箭头。其余单项样例、PNG 和节点 JSON 在 [examples](examples/) 中。

[查看飞书渲染的全功能样例预览](examples/feishu-auto-screenshot-preview.jpg)

## 测试

```sh
pnpm test
pnpm typecheck
```

Vitest 测试文件以 `*.test.ts` 命名，和被测试的源文件放在同一模块。测试覆盖节点转换、链接解析、文末创建画板、截图前置和导入重试。
