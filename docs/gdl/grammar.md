# Igis GDL（地理描述语言）语法

> 名称说明：Graphisoft ArchiCAD 也有一个叫 GDL（Geometric Description Language）的语言，二者同名但无关。Igis GDL 的语法是独立设计的，没有沿用它的语法。

Igis GDL 用纯文本描述图层、样式、要素和三种空间运算（缓冲、相交、裁剪）。解析器在 `packages/gdl`（`@igis/gdl`），手写词法和语法分析，不依赖解析器生成器。

## 1. 基本规则

- 一行一条语句。空行忽略。
- 注释：记号开头的两个连字符 `--` 起到行尾。
- 关键字不区分大小写（`LAYER` 和 `layer` 等价）。图层名、字段名区分大小写。
- 名称可以直接写（中文、字母、数字、下划线、连字符都可以），含空格时用双引号：`"北京 道路"`。名称最长 80 个字符。
- 字符串用双引号，支持 `\"`、`\\`、`\n` 三种转义。
- 数字：`12`、`-3.5`、`1e3`。
- 文本上限 1MB。语法错误最多一次报 50 条，每条带行号和列号。

## 2. 图层块

```
LAYER <图层名>
  GEOMETRY POINT | LINE | POLYGON | MIXED
  CRS <坐标系标签>
  FIELD <字段名> TEXT | INT | REAL | BOOL
  STYLE <样式属性对...>
  FEATURE [<字段名>=<值> ...] GEOM <几何字面量>
END
```

| 语句 | 说明 |
| --- | --- |
| `GEOMETRY` | 声明几何类型。可省略；省略时按要素实际类型判断。 |
| `CRS` | 坐标系标签，只作记录（例如 `EPSG:4326`），不做投影转换。省略时记为“未声明”。 |
| `FIELD` | 声明字段和类型。声明过字段后，`FEATURE` 里出现未声明的属性或类型不符都会报错。`_fid` 是保留字段。 |
| `STYLE` | 图层初始样式，见第 4 节。 |
| `FEATURE` | 一个要素：若干 `名=值` 属性，然后 `GEOM` 加几何字面量。值可以是 `"文字"`、数字、`true`、`false`、`null`。 |
| `FEATURES n` | 只出现在摘要模式里，表示要素数量，不含几何。载入时忽略。 |

同一段文本里图层名不能重复，`AS` 产生的结果图层名也算在内。

## 3. 几何字面量（类 WKT）

坐标写作 `x y`（经度 纬度），点之间用逗号分隔：

```
POINT (116.39 39.91)
LINESTRING (116.30 39.90, 116.40 39.91)
POLYGON ((116.32 39.88, 116.36 39.88, 116.36 39.93, 116.32 39.88))
MULTIPOINT ((116.30 39.90), (116.31 39.91))      -- 也可写 MULTIPOINT (116.30 39.90, 116.31 39.91)
MULTILINESTRING ((116.30 39.90, 116.31 39.91), (116.32 39.92, 116.33 39.93))
MULTIPOLYGON (((116.30 39.90, 116.31 39.90, 116.31 39.91, 116.30 39.90)))
POLYGON EMPTY                                    -- 任何类型后写 EMPTY 表示空几何
```

面的每个环要首尾相同；不闭合的环不会自动补齐，而是在校验时报为无效几何。载入时逐要素校验：空几何、无效几何会跳过，自相交和类型混杂会提示；问题会在统一错误弹窗里按“第几个要素、什么问题”列出，不列坐标。全部要素都无效时，这个图层不载入，报运行错误。

## 4. 样式

```
STYLE fill #2f6f5e outline #1c2430 width 2 opacity 0.6 visible true order 1
```

| 属性 | 取值 |
| --- | --- |
| `fill` | 填充色 `#rrggbb` 或 `#rgb` |
| `outline` | 轮廓色 `#rrggbb` 或 `#rgb` |
| `width` | 轮廓宽度，0.5 到 12 |
| `opacity` | 透明度，0 到 1 |
| `visible` | `true` 或 `false` |
| `order` | 叠放顺序，正整数，1 表示最上层 |

`STYLE` 写在图层块里时是初始样式；写在顶层时要带图层名，修改已有图层或前面语句产生的图层：

```
STYLE 道路_缓冲 fill #d94f30 opacity 0.4 order 1
```

样式写入当前对话的 `layers/layer-store.json`，刷新页面后保留。

## 5. 空间运算

只支持三种，全部调用 `packages/surtgis` 的核心算子（Turf），结果成为新图层：

```
BUFFER <输入图层> <距离> <单位> AS <结果图层>
INTERSECT <图层甲> WITH <图层乙> AS <结果图层>
CLIP <输入图层> BY <裁剪图层> AS <结果图层>
```

- 单位：`m`/`meters`/`米`、`km`/`kilometers`/`千米`/`公里`、`mi`/`miles`/`英里`、`ft`/`feet`/`英尺`、`deg`/`degrees`/`度`。距离和单位可以连写：`100m`。
- 引用图层时先找本段文本里定义或产生的图层，再按名称找地图里已有的图层（同名取最上层）。
- 运算按语句顺序执行。某一步失败时报出行号，前面已经生成的图层保留。

## 6. 完整示例

```
-- 道路缓冲后与片区相交
LAYER 道路
  GEOMETRY LINE
  CRS EPSG:4326
  FIELD 名称 TEXT
  FIELD lanes INT
  STYLE fill #2f6f5e outline #1c2430 width 2
  FEATURE 名称="中山路" lanes=4 GEOM LINESTRING (116.30 39.90, 116.40 39.91)
END

LAYER 片区
  GEOMETRY POLYGON
  FIELD 名称 TEXT
  FEATURE 名称="东片" GEOM POLYGON ((116.32 39.88, 116.36 39.88, 116.36 39.93, 116.32 39.93, 116.32 39.88))
END

BUFFER 道路 200 m AS 道路_缓冲
INTERSECT 道路_缓冲 WITH 片区 AS 道路片区相交
CLIP 道路 BY 片区 AS 道路_裁剪
STYLE 道路_缓冲 fill #d94f30 opacity 0.4 order 1
```

## 7. 摘要模式

摘要只保留图层名、几何类型、坐标系标签、字段名和类型、样式、要素数量、运算类型和参数。`FEATURE` 行替换为 `FEATURES n`：

```
-- Igis GDL 摘要
LAYER 道路
  GEOMETRY LINE
  CRS EPSG:4326
  FIELD 名称 TEXT
  FIELD lanes INT
  STYLE fill #2f6f5e outline #1c2430 width 2
  FEATURES 1
END
BUFFER 道路 200 m AS 道路_缓冲
```

完整几何在导出的 GDL 里。摘要不再写入知识库。导入对话框和图层菜单上的写入入口已去掉。

## 8. 模型工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `gdl.run` | `script`（必填）、`writeKnowledge` | 执行模型写的 GDL。只允许 `STYLE`、`BUFFER`、`INTERSECT`、`CLIP` 引用已有图层；出现 `LAYER`/`FEATURE`、几何字面量或坐标串会直接拒绝。最多 8000 个字符。 |
| `gdl.describe` | `layerName` | 返回该图层的 GDL 摘要。 |

## 9. 导入与导出

- 导入：导入 GIS 对话框里的“Igis GDL（地理描述语言）”区域，可以粘贴文本或选择 `.gdl` 文件，先“检查语法”再“载入GDL”。
- 导出：图层列表右键“导出为GDL”。浏览器下载一份，服务端同时写入 `var/gdl/<图层名>-<时间>.gdl`。重名时加序号，不覆盖已有文件。几何集合（GeometryCollection）要素无法表示，会省略并提示数量。
- 接口：`POST /api/gdl/parse`、`/api/gdl/load`、`/api/gdl/export`、`/api/gdl/summary`。

## 10. 不支持的内容

投影转换、比例尺、拓扑、网络分析、三维、shp/gdb/mif 读写、除缓冲/相交/裁剪以外的运算。
