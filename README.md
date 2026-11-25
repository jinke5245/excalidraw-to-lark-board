# Excalidraw to Lark Board

把 `.excalidraw` 导入飞书或 Lark 画板。传入文档链接会在文末新建画板，传入画板直达链接会导入已有画板。

## 安装

- 运行 CLI 需要 Node.js 22.12 及以上版本。从源码安装和构建时使用 pnpm。
- 导入飞书需要具有编辑权限的账号，并通过 `lark-cli auth login` 登录。

转换和导入均无需安装浏览器。

在仓库根目录安装依赖。

```sh
pnpm install --frozen-lockfile
pnpm build
```

## 使用

传入 Docx 或 Wiki 文档链接，工具会先验证并转换场景，再新建画板。终端会输出画板直达链接，标准输出为提交给飞书的节点 JSON。

```sh
node dist/index.js examples/feishu-all-features-poc.excalidraw \
  'https://your-tenant.feishu.cn/wiki/DOCUMENT_TOKEN'
```

把第二个参数换成文档地址带 `#画板块ID` 的直达链接，即可导入已有画板。也可使用 `--whiteboard-token` 指定已知的画板 token。

只传文件路径可生成节点 JSON。下面的基础样例无需调用飞书。

```sh
node dist/index.js examples/feishu-poc.excalidraw
```

包含原生图片的场景需要指定导入目标，以便上传图片取得素材 token。

## 元素支持情况

| Excalidraw 元素          | 飞书对应节点                        | 支持情况                                             |
| ------------------------ | ----------------------------------- | ---------------------------------------------------- |
| 矩形 `rectangle`         | `composite_shape`（普通或圆角矩形） | 支持，绑定文字合并到图形内。                         |
| 椭圆 `ellipse`           | `composite_shape`（椭圆）           | 支持，绑定文字合并到图形内。                         |
| 菱形 `diamond`           | `composite_shape`（菱形）           | 支持，绑定文字合并到图形内。                         |
| 文字 `text`              | `text_shape` 或所属节点的文字       | 支持独立文字，以及图形、便签和连线上的绑定文字。     |
| 箭头 `arrow`             | `connector`                         | 支持可转换图形的端点绑定。                           |
| 分区 `frame`             | `section`                           | 支持分区及其内部可转换的节点。                       |
| 线条 `line`              | `connector`                         | 支持直线和折线。                                     |
| 自由笔迹 `freedraw`      | `paint`                             | 支持，压感转为统一线宽。                             |
| 便签 `stickynote`        | `sticky_note`                       | 支持，绑定文字合并到便签内。                         |
| 图片 `image`             | `image`                             | 支持场景内嵌的原始 PNG 或 JPEG。裁剪和翻转暂不支持。 |
| 网页嵌入 `embeddable`    | —                                   | 暂不支持，导入时跳过。                               |
| HTML 框 `iframe`         | —                                   | 暂不支持，导入时跳过。                               |
| Magic Frame `magicframe` | —                                   | 暂不支持容器，内部可转换的元素仍导入到画布。         |

有可转换节点时，导入会继续，并逐项提示跳过的元素。没有可转换节点时，命令会报错并停止导入。

## 样例

- [全功能样例](examples/feishu-all-features-poc.excalidraw)覆盖目前支持的十种元素。
- [基础样例](examples/feishu-poc.excalidraw)包含带中文标签的形状和绑定箭头。其余演示样例及节点 JSON 在 [examples](examples/) 中。

## 测试

```sh
pnpm test
pnpm typecheck
```

单元测试以 `*.test.ts` 命名，放在被测源码旁边，并用代码构造小输入来验证单项规则。

[画板请求体集成测试](tests/integration/whiteboard-payload.test.ts)读取
[`tests/fixtures/whiteboard-payload/`](tests/fixtures/whiteboard-payload/) 下的
`.excalidraw` 场景，并把 CLI 最终请求体与对应的 `.nodes.json` 比对。
目前支持的十种元素都有[单项用例](tests/fixtures/whiteboard-payload/elements/)。
矩形、椭圆和菱形各覆盖无文字、带绑定文字两种情况，另有组合场景和跳过不支持元素的用例。
测试使用模拟的 `lark-cli`，无需连接飞书。
