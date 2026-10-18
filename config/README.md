# 配置

这些文件描述约束，不含密钥，可以进入版本库。

| 文件 | 作用 |
|---|---|
| `gdal.lock.json` | GDAL 预编译包钉死为 `gdal-js@2.2.0`。wasm 不提交。OpenFileGDB 驱动在构建中，但没有成功打开真实 gdb 的夹具，且不等价于 ArcGIS Pro |
| `licenses.lock.json` | `gdal-js`（MIT）和 GDAL（MIT/X）已记录。`gdal3.js`（LGPL）在拒绝名单里，没有安装。直接链接的 GPL/LGPL/AGPL 拒绝，独立进程中的 GPL 不拦截。qgis-wasm 排除在仓库之外 |
| `models.lock.json` | 不内置基座模型。提供方为 deepseek、千问、grok 和本地模型 |
| `retrieval.json` | 本地检索。`cloudEnabled` 出厂为 `false`，不调用云端嵌入。进程内哈希写在该文件的 `note` 里 |
| `audit.json` | 账本默认记录图层名，禁止记录几何坐标 |
| `llm.api.example.json` | 外部 LLM API 模板。只写环境变量名：`DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`GROK_API_KEY`、`LOCAL_LLM_API_KEY`。`llm.local.json` 已被 gitignore，只有勾选「保存配置到后端」才写入 |

API 密钥默认只来自环境变量（例如当前提供方对应的 `DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`GROK_API_KEY` 或 `LOCAL_LLM_API_KEY`），不写入磁盘。界面只有在模型对话框里勾选「保存配置到后端」时，才会把本次配置写入 gitignore 的 `config/llm.local.json`，并且文件里带 `"persist": true`。未勾选时密钥只留在 desktop-api 进程内存；页面刷新后输入框为空，不回显完整密钥；进程重启后内存配置消失，重新使用环境变量。用户配置优先于环境变量。没有 `persist: true` 的旧文件不会在启动时载入。接口响应只回掩码或“是否已配置”，不回完整密钥。local-mock 忽略地址和密钥。
