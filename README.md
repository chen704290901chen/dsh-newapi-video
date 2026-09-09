# dsh-newapi-video

一个 DeepSeek Harness（DSH）插件：在对话里用 `@` 引用素材（图片 / 视频），再加一句提示词，调用 **new-api（one-api 风格中转站）** 的视频大模型生成视频。

## 功能

- 注册两个工具：
  - `newapi_generate_video` —— 文生视频 / 图生视频 / 首尾帧视频。
  - `newapi_task_status` —— 查询本地任务台账，恢复因超时或中断而丢失的异步任务。
- 通过 `@` 引用素材：把 `@` 引用的图片路径传给 `first_frame`（首帧图生视频）、`last_frame`（尾帧）、`reference_images`（外观一致性参考图）；视频素材传给 `video`（视频生视频，视模式而定）。
- 四种中转协议：
  - `v1-videos`（**默认**）：new-api 统一任务接口 `POST {base}/v1/videos` + `GET /v1/videos/{task_id}`，适配 **Seedance 2.0** 与 **Happyhorse**（快乐马）。按模型名自动识别请求体：`happyhorse-*` 走顶层 `size`+`images`；`doubao-seedance-*` 走 `metadata.resolution/ratio` + `metadata.content`（`first_frame` / `last_frame` / `reference_image` / `reference_video`）。
  - `openai-videos`：OpenAI 兼容 `POST {base}/videos/generations` + `GET /videos/{task_id}`。
  - `modelverse-tasks`：`POST {base}/tasks/submit` + `GET /tasks/status?task_id=...`（可灵 / 即梦 Seedance 等常用）。
  - `generic-rest`：自定义提交 / 查询路径 + JSON 字段提取，适配任意 new-api 部署。
- **Seedance 2.0 / Happyhorse 接入要点**：`seconds` 一律发送**字符串**（如 `"5"`）；分辨率用小写精确值 `720p` / `1080p` / `480p` / `4k`（Seedance 不支持 `2K`/`1080P`，Happyhorse 只用 `720p`/`1080p`）；Seedance 支持 `first_frame`+`last_frame`（首尾帧）、`reference_images`、`video`（参考视频）和 `ratio: adaptive`；Happyhorse 的 i2v（如 `happyhorse-1.1-i2v`）**只传一张**参考图，t2v 不传参考图。
- 结果视频自动下载到工作区输出目录，返回本地路径 + 原始 URL（取 `metadata.url`，可能有时效，建议成功后及时本地保存）。
- **可视化生成面板**：为 `newapi_generate_video` / `newapi_task_status` 注册了独立卡片（`tool.call.toolview`）。模型调用工具后，聊天里会直接显示一块面板——含提示词、参数、素材引用（点击可打开文件）、任务状态，以及生成结果的**视频播放器**，而不是一段 JSON。生成期间面板会**实时轮询 `/newapi/tasks` 显示进度状态**（如「生成中…（processing）」）。
- **按项目（工作区）隔离**：每条任务记录都带 `project`（会话工作区根目录 = 工作区路径）。`/newapi/tasks` 通过请求头 `x-newapi-project` / 查询参数 `project` 定位项目，按项目读取各自的任务台账，多个工作区并行生成互不干扰。
- **宽容的项目校验**：`/newapi/tasks` 会校验 `project` 是否落在已注册工作区内（`ctx.get("workspaceRegistry").list()`，读不到再回退到 `DSH_HOME/storages/workspace.json`）。**取不到工作区列表时一律放行**，只有能确认列表、且 `project` 确实不在其中才返回 403。
- **友好状态文案**：把原始中转站状态映射成中文——`queued/pending/submitted → 排队中`，`processing/running/rendering/generating → 渲染中`，`succeeded/completed/finished → 已完成`，`failed/error/cancelled → 失败`，未知则原样显示。面板状态标签与 `newapi_task_status` 都会展示该文案（`stateLabel`）。
- **设置页**：`settings.section` 提供独立的「NewAPI 视频」设置页（侧边栏出现入口），可视化编辑 Base URL / API Key / model / 模式 / 轮询间隔等。

## 安装

### 方式一：插件市场（推荐）

插件已收录到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，在 DSH 里打开 **设置 → 插件市场**，搜索 `dsh-newapi-video` 一键安装。

### 方式二：从源码构建

```powershell
git clone https://github.com/chen704290901chen/dsh-newapi-video.git
cd dsh-newapi-video
npm pack
dsh plugin --profile web add file:./dsh-newapi-video-1.0.0.tgz
```

## 配置（WebUI Settings → NewAPI Video）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否注册工具。由输入栏「视频创作」开关驱动：关闭时从 agent 工具列表**彻底移除**生成工具（agent 感知不到插件），同时隐藏上传/预览/资产库 UI。 |
| `mode` | `v1-videos` | 中转协议：`v1-videos`（默认，适配 Seedance/Happyhorse）/ `openai-videos` / `modelverse-tasks` / `generic-rest`。 |
| `baseURL` | 空 | 中转站 Base URL（含 `/v1`）。**留空则默认读取 DSH「模型配置」里的 baseURL**。 |
| `apiKey` | 空 | 中转站 API Key。**留空则用「模型配置」里的 key**；不再支持环境变量回退。 |
| `model` | `doubao-seedance-2-0-mini-260615` | 视频模型 id（默认固定 Seedance mini；可切 `happyhorse-1.1-i2v` 等）。 |
| `imageModel` | `gpt-image-2` | 图片模型 id（默认固定；可切 `qwen-image-2.0`、Seedream 等）。 |
| `imageSize` | `1024x1024` | 默认图片尺寸（OpenAI 式 `1024x1024`，或 qwen 式 `宽x高`）。 |
| `outputDir` | `newapi_output` | 下载视频与任务台账目录（相对会话工作区）。 |
| `timeoutMs` | `120000` | 单次 HTTP 请求超时（毫秒）。 |
| `pollIntervalMs` | `5000` | 异步任务轮询间隔。 |
| `maxPollAttempts` | `360` | 最大轮询次数。 |
| `aspectRatio` | `16:9` | 默认画幅比。 |
| `durationSeconds` | `5` | 默认时长（秒）。 |
| `resolution` | `1080p` | 输出档位：v1-videos 用小写 `720p`/`1080p`/`480p`/`4k`；modelverse-tasks 用 `2K` 等。 |
| `submitPath` | `/videos/generations` | 提交任务路径（openai-videos / generic-rest）。 |
| `statusPathTemplate` | `/videos/{task_id}` | 查询状态路径模板。 |
| `taskIdField` / `statusField` / `urlsField` | 空 | generic-rest 的 JSON 点路径提取（如 `output.task_id`）。 |

也可以直接在 profile 的 `cordis.patch.yml` 里按 id 覆盖配置：

```yaml
- id: newapi-video
  name: dsh-newapi-video
  config:
    mode: modelverse-tasks
    baseURL: https://api.modelverse.cn/v1
    apiKey: your-key
    model: doubao-seedance-2-0-260128
    resolution: 2K
```

## 视频创作开关（输入栏）

对话输入栏「上传素材」旁有一个**「视频创作」开关**（蓝紫渐变胶囊 + 滑块，切换有平滑过渡）。它是整个插件的**总开关**：

- **开**：显示「上传素材」按钮、`@` 引用预览条、以及页面顶部的「资产库」标签页；agent 工具可用。
- **关**：隐藏「上传素材」按钮、`@` 预览条，并**移除资产库标签页**；同时 `settings.enabled` 置为 `false`，宿主把 `newapi_generate_video` / `newapi_generate_image` 两个工具**从 agent 工具列表彻底注销**并移除 system-prompt 指引——agent 完全感知不到插件，等同于在插件市场里禁用。

> 开关状态存在 `settings.enabled`（服务端 `newapi-video` 命名空间），浏览器端也缓存到 localStorage。关闭时即使绕过前端直接调用生成工具，宿主也会拒绝（工具不存在/被注销）。

## 方向门控（生成前必选方向）

生成前 agent **必须先选定「方向（skill）」并与用户确认**，未锁定方向 + 规格（模型 / 画幅 / 时长 / 张数）之前不得调用生成工具：

- 默认方向：**电商视觉套件 `ecommerce-visual-suite`**（电商主图 / 详情图 / 宣传视频）。
- 用户明确指定其它 skill / 方向时，按该 skill 的流程执行。
- 方向不明确时先询问用户（如「用哪个方向？电商视觉套件 / 宣传视频 / 其它」），不替用户猜。

> 该约束由插件注入的 system-prompt（`registerGuidance`）实现，是行为约定（提示词级）；如需硬校验请加工具 `direction` 再拦截。

## 使用示例

在对话里（`v1-videos` 模式）：

**Seedance 2.0 文生视频**
> 用 doubao-seedance-2-0-260128 生成一只猫在雨夜城市奔跑，1080p，16:9，5 秒。

**Seedance 2.0 首尾帧**
> @first.png 做首帧 @last.png 做尾帧，让小猫从坐着站起来走向镜头，720p，自适应比例。

**Happyhorse 图生视频**
> 用 happyhorse-1.1-i2v，@ref.png 做参考图，让主体缓慢转身看向镜头，1080p，5 秒。

模型会调用 `newapi_generate_video`，插件自动拼出对应协议体（如上文「接入要点」）。

> 用 @cat.png 做首帧，让这只猫在草地上奔跑，电影感运镜，16:9，5 秒。

模型会调用：

```json
{
  "prompt": "A cat running across a grassy field, cinematic camera, ...",
  "first_frame": "cat.png",
  "aspect_ratio": "16:9",
  "duration": 5
}
```

返回：

```json
{
  "model": "doubao-seedance-2-0-260128",
  "prompt": "...",
  "taskId": "abc123",
  "status": "succeeded",
  "mode": "modelverse-tasks",
  "urls": ["https://..."],
  "files": [{ "path": "newapi_output/video-....mp4", "url": "https://...", "mimeType": "video/mp4" }]
}
```

## 说明与限制

- `@` 引用本质是「路径文本」：模型需要先用 `read` 工具确认文件存在，再把路径传给工具；插件会把本地文件读成 base64 data URL，URL 原样透传。
- 图片内联上限 20 MB，视频内联上限 100 MB。
- `openai-videos` 模式不接受视频素材（只支持首帧图片）；视频素材请在 `modelverse-tasks` / `generic-rest` 模式使用。
- 各 new-api 中转站 / 模型的具体请求字段差异较大，若默认协议不匹配，请切换 `generic-rest` 模式并配置路径与字段提取。
