# InkShader — 当前三个计划任务状态

---

## Task 1: Ref Section Inline 显示 / 编辑 / 拖出悬浮

**状态:** ✅ 已完成

**涉及文件:**
- `js/ui/property_panel.js`
- `js/ui/group_settings_popup.js`
- `js/services/i18n.js`

**改动内容:**
- `_buildRefProps` 行内六个字段（ScaleX/Y, ShearX/Y, OffsetX/Y）改为 `npp-row` + `npp-input-group` + `npp-axis` 标准双字段样式
- `group_settings_popup.js` POPUP_HTML ref 段同样统一 `npp-row` 模式
- `_extractSectionImpl` ref 分支：不调 `render()`，inline 段保留 DOM，popup 浮在上层
- 设 `_extractedRefId` 标记来源，设 `_refDetailsMode` 区分 ref/ref_details
- `_setSectionDocked` 清除 `_extractedRefId`/`_refDetailsMode`，跳过 localStorage
- `_handleStoreStateChanged` 重构：`_extractedRefId` 时用 `selectedTreeIds` 追踪 ref 选择
- i18n 新增 prop.scale/prop.shear/prop.offset 翻译

**待验证:** Dev server 启动后目测拖出/回插行为，验证字段弹出后编辑是否正常

---

## Task 2: Non-Drag Ref Transform 画布更新

**状态:** ✅ 已完成

**涉及文件:**
- `js/core/bezier/tree_store.js`
- `js/app/editor_read_facade.js`

**改动内容:**
- `applyTransformPreview` 非拖拽路径（数值输入）补 `invalidateGroupCache(snap.ref.id)`，确保画布实时更新
- `getRefTransform` 优先读取 live tree item（而非 stale 缓存）

**待验证:** 在 property panel 输入 ref 变换数值后画布即时刷新

---

## Task 3: Ligature 支持

**状态:** ✅ 已完成（历史遗留功能，非本次新增）

**涉及文件:**
- `js/services/sequence_service.js`
- `js/ui/glyph_sequence_bar.js`
- `js/canvas/canvas_io_service.js`
- `js/ui/property_panel.js`

**功能范围:**
- 分词合并: `_mergeLigatureTokens()` 按最长匹配合并单字符 token
- UI 展示: glyph sequence bar 中 ligature 跳过 ASCII grid，归入 "Other Groups"
- 编辑: property panel `g_char` 字段 placeholder "Ligatures allowed"
- 导出: GLIF 跳过 unicode 字段；自动生成 `features.fea` ligature 规则

---

## 总览

| # | 任务 | 状态 | 代码完成 | 测试/验证 |
|---|------|------|---------|---------|
| 1 | Ref inline + extract/dock | ✅ | 已完成 | 待启动 dev server |
| 2 | Non-drag transform update | ✅ | 已完成 | 待启动 dev server |
| 3 | Ligature support | ✅ | 已完成 | 已验证 |


我需要为本项目加入kerning，由于完整的feature file支持较为复杂，暂不考虑，但kerning作为其中特殊的部分在字体编辑器中一般必须支持，应该如何加入目前的文件结构，kerning除了写为feature中的gpos规则还能如何表示
我现在对整个项目结构有了清晰的理解。以下是围绕 kerning 加入方式的完整分析：

你的问题拆解
你的本质问题是：在不引入完整 OpenType feature 文件机制的前提下，用什么样的数据结构和集成方式在本项目中实现字偶距（kerning）支持。

先梳理现有体系与 kerning 的关系：

现状关键路径
SequenceService.calculateSequenceOffsets()
  → 遍历 sequenceTokens，累加每个 glyph 的 advance
  → 得到 sequenceOffsets[] (每个字形的 X 位置)

渲染/拾取/网格均基于 sequenceOffsets 定位字形
当前每个 GroupData 只有自己的 advance，没有 "我前面是 A 时应该缩多少" 这种字偶信息。

Kerning 的几种表达方式（无需 feature file）
1. 简单字偶表（Pair Kerning Table）— 推荐
结构：Map<leftGlyphName, Map<rightGlyphName, number>>

// 顶层字段
"kerning": {
  "A": { "V": -50, "W": -30, "T": -35 },
  "V": { "A": -40 },
  "T": { "o": -20, "a": -25, "e": -25 }
}
含义：当 leftGlyphName 后面紧跟 rightGlyphName 时，在计算 offset 时额外加上 kerning 值（负值 = 靠近，正值 = 远离）。

集成点（数据流视角）：

用户设置 "A/V = -50"
  → KerningManager.setPair("A", "V", -50)
  → 标记 dirty
  → SequenceService.calculateSequenceOffsets()
     → 遍历 tokens[i] 和 tokens[i-1] 查 kerning
     → offsets[i] += getKerning(prevGlyphName, currGlyphName)
优点	缺点
数据结构极简单，一眼可读	字形重命名时需要级联更新 map key
对当前架构改动最小	没有 class 机制，大量字偶得逐一设置
序列预览直接生效	导出到 OpenType 时需额外编译为 GPOS
序列条上的分割线拖拽不受影响（各 glyph advance 不变，仅渲染偏移变）	
2. 左侧/右侧 Kerning 类（Class-based Kerning）
更接近 OpenType GPOS Type 2 的 Class-based Pair Positioning。分为左类、右类、值矩阵三层：

"kerning_classes": {
  "left_groups": {
    "A_W": ["A", "Aacute", "Agrave"],
    "T_F": ["T", "F"]
  },
  "right_groups": {
    "v_w": ["v", "w"],
    "period": [".", ",", ":"]
  },
  "values": [
    { "left": "A_W", "right": "v_w", "value": -30 },
    { "left": "T_F", "right": "period", "value": -10 }
  ]
}
优点	缺点
一组定义覆盖大量字偶，编辑效率高	类划分 → 类管理 → 类成员编辑 → 复杂度跳跃
GPOS 导出时可直接映射为 class 格式	字形重命名时需要知道它在哪个类
更接近 font engineer 心智模型	需要 class 管理 UI，对纯字形编辑场景过剩
对于 InkShader 当前"单字形即一个根级 group"的模型，class 带来的收益可能不如简单的 pair 表直观。

3. 每个 Group 自带 side bearings（伪 kerning）
即给每个 glyph 加一个 left_bearing / right_bearing 字段：

// GroupData 层面
{
  "name": "A",
  "advance": 1000,
  "left_bearing": 50,
  "right_bearing": 30
}
计算 offset 时：prev.advance - prev.right_bearing + curr.left_bearing

但这不是 kerning——这只解决了统一的 side bearing，无法处理 A/V 这种特定组合的差异（A 右侧和 V 左侧的形状互补需要负的视觉补偿，单纯靠 side bearing 不够）。

4. 完全分离的 kerning table（扁平存储）
"kerning_pairs": [
  { "left": "A", "right": "V", "value": -50 },
  { "left": "A", "right": "W", "value": -30 }
]
与方案 1 等价，只是存储形式从嵌套 map 变为数组。可读性稍差但序列化更规整，不过对架构设计没有本质区别。

放入当前结构的推荐方案
我推荐 方案 1（嵌套 Pair Table），理由：

对架构改动最小——只需新增一个 core/bezier/kerning_manager.js 和几处集成点
与当前 Group 模型天然匹配——key 是 group name（唯一标识）
写入/加载路径清晰——顶层加一个 kerning 字段，SnapshotSerializer 两端各加几行
预览直接生效——calculateSequenceOffsets 中插入一行 offset += kerning
为未来 GPOS 导出预留路径——pair kerning 表可以直接编译为 GPOS Pair Adjustment lookup，不需要额外分析
需要改动的文件清单（概览）
文件	改动
js/core/bezier/kerning_manager.js	新文件 — KerningManager：pairs 存储、getPair、setPair、removePair、renameGlyph
js/core/bezier/manager.js	添加 kerningManager 属性，桥接委托方法
js/core/bezier/sequence_service.js	calculateSequenceOffsets() 中查询 kerning 调整 offset
js/core/bezier/snapshot_serializer.js	exportJSON 中写入 kerning，loadFromSnapshotObject 中读取
js/schemas/project_schema.json	添加 kerning 字段定义
js/ui/kerning_panel.js	新 Web Component — 字偶对编辑面板
js/app/canvas_dispatcher.js / canvas_events.js	添加 REQUEST_SET_KERNING_PAIR / REQUEST_DELETE_KERNING_PAIR
js/domain/commands/canvas_commands.js	添加 setKerningPair / deleteKerningPair 命令
核心改动示意
sequence_service.js 中的关键改动点：

// calculateSequenceOffsets() 中
calculateSequenceOffsets() {
    this.sequenceOffsets = new Array(this.sequenceTokens.length).fill(0);
    let currentOffset = 0;
    for (let i = 0; i < this.sequenceTokens.length; i++) {
        this.sequenceOffsets[i] = currentOffset;
        
        // — 新增 kerning 调整 —
        if (i > 0) {
            const prevToken = this.sequenceTokens[i - 1];
            const currToken = this.sequenceTokens[i];
            const prevGid = prevToken.isChar ? this.getDefaultGroupForChar(prevToken.value) : prevToken.value;
            const currGid = currToken.isChar ? this.getDefaultGroupForChar(currToken.value) : currToken.value;
            const kValue = this._kerningManager?.getPair(prevGid, currGid) ?? 0;
            currentOffset += kValue;
        }
        // — END —

        let t = this.sequenceTokens[i];
        let gid = t.isChar ? this.getDefaultGroupForChar(t.value) : t.value;
        let group = this._treeStore.treeItems.get(gid);
        currentOffset += (group && group.advance !== undefined) ? group.advance : 1000;
    }
}
KerningManager 的核心接口：

class KerningManager {
    constructor() {
        this._pairs = new Map(); // Map<leftName, Map<rightName, number>>
    }
    
    getPair(leftName, rightName) {
        return this._pairs.get(leftName)?.get(rightName) ?? 0;
    }
    
    setPair(leftName, rightName, value) {
        if (!this._pairs.has(leftName)) this._pairs.set(leftName, new Map());
        this._pairs.get(leftName).set(rightName, value);
    }
    
    removePair(leftName, rightName) {
        this._pairs.get(leftName)?.delete(rightName);
    }
    
    // 字形重命名时级联更新 key
    renameGlyph(oldName, newName) {
        // 更新 left-side keys
        if (this._pairs.has(oldName)) {
            this._pairs.set(newName, this._pairs.get(oldName));
            this._pairs.delete(oldName);
        }
        // 更新 right-side keys
        for (const [left, rightMap] of this._pairs) {
            if (rightMap.has(oldName)) {
                rightMap.set(newName, rightMap.get(oldName));
                rightMap.delete(oldName);
            }
        }
    }
    
    toJSON() { /* → { "A": { "V": -50 } } */ }
    fromJSON(data) { /* 反序列化 */ }
}
需要先确认的问题
在你决定实现之前，有几个设计决策最好先敲定：

kerning 值是直接从 advance 中抽取（字形 advance 不变，仅 rendered offset 变），还是应该修改 advance 本身？
推荐：不改 advance，只在 offset 计算中叠加。这样分割线拖拽、advance 属性不与 kerning 纠缠。
序列预览中的分割线（divider）拖拽行为——当前分割线位置 = 累计 advance offset。加入 kerning 后分割线应该显示在 kerning-adjusted 位置还是原始 advance 位置？
推荐：显示在 kerning-adjusted 位置（所见即所得），但拖拽时写入的仍然是 advance（kerning 不变）。
是否支持对空格/非字形 token 做 kerning？（如 \space\ + 某些大写字母）
技术上可以做，但需要定义 token 类型对应的 group 查表方式。
初始的 UI 入口怎么做？
最小方案：在 Group Settings Popup 中加一个 "Kerning" 按钮，弹出简单的 pair 编辑对话框。后续可扩展为独立的 kerning 面板。
要不要我先出个最小实现方案（文件 + 流程）给你看看？或者你先回答上面几个设计问题我再动手。

方案1和2的表示能力都是完备的吗，存在哪些区别？kern的单位是和opentype的这个1000相同单位吗
好问题。这两个方向我展开讲清楚。

表示能力的完备性 vs 信息压缩方式
Option 1（Pair Table）的完备性
可以表达任何可能的字偶关系。每个 pair (A, V) → -50 就是一个具体的约束，互不干扰。理论上：

(A, V) → -50
(A, W) → -30
(A, T) → -45
(Agrave, V) → -48
(Agrave, W) → -28
...
N 个左字形 × M 个右字形，铺满就是 N×M 个 entry。不做任何归约。

Option 2（Classes）的本质
它等价于矩阵分解。你把 {A, Agrave, Aacute} 归为一个左类 L_square，把 {v, w, y} 归为右类 R_tail，然后定义：

L_square / R_tail → -30
这就等价于在 pair table 中写了 3×3 = 9 行一模一样值的 entry。

关键区别：Option 2 并不比 Option 1 表达力更强
实际上恰恰相反：

Option 1 (Pairs)	Option 2 (Pure Classes)
细粒度控制	每个 pair 独立值，可任意不同	同类所有 pair 共享同一个值
特殊例外	天然支持（直接设不同的值）	不支持——除非引入例外机制
信息密度	低（每条记录只表达一个关系）	高（一条记录表达 N×M 关系）
看这个例子就清楚了：

你希望 A/V = -50 但 A/W = -20。在 Option 1 里直接写两条：

"A": { "V": -50, "W": -20 }
在纯 Option 2 里，如果 V 和 W 同属右类 R_vw，你给不出两个不同的值。你必须把 V 和 W 分到不同右类，或者引入例外机制（即 OpenType GPOS 里的 PairAdjustment 中的 ValueRecord 例外表）。

所以在纯类的形式下，Option 2 的可表达范围是 Option 1 的真子集。 只有当你同时支持"类 + 例外"时，二者才等价。

实际工作流中这意味着什么
场景	Pair	Class	Class+Exception
"A/Agrave/Aacute 对 v/w 都减少 30"	写 6 行	2 类 + 1 行值	2 类 + 1 行值
"这 6 个里唯独 A/V 需要再减 10"	改 1 行	不可行（除非拆类）	2 类 + 1 行值 + 1 行例外
重命名 glyph	搜索替换 N 处	改 1 处类成员列表	改 1 处类成员列表
导出到 OpenType GPOS	需要编译成 class lookup（否则文件太大）	直接映射	直接映射
结论：从纯粹的表达能力来说，Option 1 完备（可表示一切），Option 2 不完备（有约束）。但从 OpenType 编译角度看，无压缩的 pair 表导出一个几千字形的字体时会爆炸成数十万条 GPOS 记录，所以最终还是要做 class 归类——只不过这个归类可以在导出时自动推导（group 相邻 pair 值相同的→合并为类）。

单位问题
是的，kerning 值使用与 OpenType 相同的字体设计单位（UPM units）。

InkShader 体系内的一致性：

量	单位	依据
节点坐标 point.x/y	UPM（默认 1000）	SPEC §S004b1
控制柄偏移 control1.x/y	UPM（相对 point）	SPEC §S004b1
Advance width	UPM	spec + schema
Kerning 值	UPM	同上
也就是说，kerning(A, V) = -50 的语义是：在序列排版中，从 V 的 origin 减去 50 UPM 单位，等价于 OpenType 中的 pos A V -50;。

单位换算关系一览：

UPM = 1000 (默认)
1 UPM unit = 1/1000 em
1 em = 当前字号

所以 InksShader 里 advance = 1000, kern = -50
→ V 的 origin = A 的 origin + 1000 - 50 = A 的 origin + 950
→ OpenType 中等价于 pair adjustment value = -50 font units
→ 实际渲染中 = -50/1000 em 的横向偏移
如果用户修改了项目 UPM（比如设为 2048），所有坐标和 kerning 值同样跟随该单位体系，这与 OpenType 规范的行为一致。

我的建议
考虑到上面这些分析，如果现在要加入 kerning，最稳妥的路径是：

存储用 Option 1（Pair Table，嵌套 map）——最直接的表达能力，无需类管理 UI
序列 offset 计算中叠加 kerning 值
导出到 OpenType 时再将 pair 表自动编译为 class-based GPOS lookup（这是导出引擎的事情，不影响编辑器数据模型）
UI 上给一个 pair 编辑面板，支持直观的 "left glyph → right glyph → value" 输入
这样既做到了编辑器内部零概念负担，又保留了将来导出 OpenType 时的 class 优化空间。

为什么2不能支持例外，2不是可以展开降级为1吗？feature file中是怎么表示的
你说得对，我前面说得不够准确。让我纠正并展开。

纠正：Option 2 当然可以支持例外
你说得完全正确——Option 2 不是只能存类，它可以同时存一个例外表。组合后的数据模型是：

{
  "kerning_classes": {
    "left_groups": {
      "L_square": ["A", "Agrave", "Aacute"],
      "L_round": ["O", "C", "G"]
    },
    "right_groups": {
      "R_tail": ["V", "W", "Y"],
      "R_round": ["o", "c", "e"]
    },
    "class_values": {
      "L_square/R_tail": -50,
      "L_square/R_round": -30,
      "L_round/R_tail": -20
    },
    "exceptions": [
      { "left": "A", "right": "V", "value": -60 }
    ]
  }
}
解析时按优先顺序：

先查 exceptions → 精确匹配时直接取用
再查 class_values → 匹配 left 所在左类 × right 所在右类
这不就是"展开降级为 pair 表"吗？是的，例外就是局部展开。所以类+例外 = 完全等价于纯 pair 表，表达能力完全相同。我前面说"Option 2 是 Option 1 的真子集"是错的——那是纯类（无例外）的情况。

两类方案的真正差异不在完备性，而在：

Pair	Class + 例外
存储形式	用户直接看到所有 pair	类属性 + 值矩阵 + 例外表
新增字偶	直接写一对	普通 case 归入类，特殊 case 写例外
边界 case	一切平等	"大多数一致，个别不同"——所以类划分决定了例外数量
UI 复杂度	简单：左字形 × 右字形 + 值	需要类编辑器 + 例外编辑器
导出到 OpenType GPOS	编译器自动聚类导出	类直接映射，例外需要额外处理
本质区别是 编辑界面给用户看的视图不同，不是表达能力的区别。

Feature file 中 kerning 的表示法
OpenType feature file（Adobe FDK 格式）中 kerning 通过 pos 规则表达：

1. 单对单
pos A V -50;
2. 类对类
@L_square = [A Agrave Aacute];
@R_tail   = [V W Y];

lookup kern {
    pos @L_square @R_tail -50;
} kern;
3. 例外如何处理
Feature file 本身没有「例外」关键字。实际工程做法是：

做法 A：把例外字形踢出类，单独成类

@L_square_except_A = [Agrave Aacute];  # 不含 A
@R_tail = [V W Y];

lookup kern {
    pos @L_square_except_A @R_tail -50;  # Agrave/Aacute 按 -50
    pos A V -60;                         # A 单独定 -60
    pos A W -50;                         # A 对其他成员 = -50
    pos A Y -50;
} kern;
这会膨胀规则数（A 的每一条都得写），但避免了 GPOS 二进制格式的规则重叠问题。

做法 B：利用 GPOS 的 lookup 顺序

OpenType GPOS 中同一 lookup 内的多个 subtable 是叠加的（顺序执行）。所以不能在同一 lookup 内既写类规则又写例外——值和累加。所以 fonts 中例外通常：

把通用规则放一个 lookup，特殊 pair 放另一个 lookup
通过不同的 feature tag 或 lookup 优先级控制
但在编译器的数据模型层面，你完全不需要被这个二进制限制束缚。 你的编辑器数据存的是：

类定义 + 类矩阵 + 例外表
导出时才决定怎么生成 GPOS subtable（可以自动展开例外、自动调整类划分以回避覆盖冲突）。这是编译器优化问题，不是数据结构问题。

所以 feature file 里"例外"的等价写法其实就是手动展开类 + 逐个写 pair：

# 人类想表达："除了 A/V 是 -60，其他 L_square/R_tail 一律 -50"
# 但 feature file 必须展开为：
pos A V -60;
pos A W -50;
pos A Y -50;
pos Agrave V -50;
pos Agrave W -50;
pos Agrave Y -50;
pos Aacute V -50;
pos Aacute W -50;
pos Aacute Y -50;
回到工程选择
在编辑器内部数据模型中，Pair 和 Class+Exception 的区别仅仅是：

Pair 表 = 显式写出了展开后的全部 N×M 行
Class+Exception = 压缩存储，编辑时按类查看，但渲染时等价于展开后的 Pair 表
对于 InkShader 当前阶段，我仍然认为直接使用 Pair 表更合适——不是因为表达能力（二者等价），而是因为：

不需要额外的类编辑器 UI
不需要处理"字形改动类归属"的传播
用户每次只处理一对，认知负担最小
编译导出 OTF/TTF 时，相同值的连续 pair 可以自动聚类（压缩发生在导出端，不影响编辑器模型）
除非你有明确的用户场景需要按类批量设置（例如同时设 "A/Agrave/Aacute 对 V/W/Y 的 kern 值"），否则 Pair 表起步是最轻的。

ufo中如何表示，只能写成gpos规则吗
非常好的问题。UFO 恰恰证明了 kerning 不需要 GPOS feature file 来表达。

UFO 中 kerning 的表示方式
UFO 不自带 GPOS。kerning 存储在独立的 kerning.plist 中，搭配 groups.plist 使用。

纯 Pair 形式（kerning.plist）
<!-- kerning.plist -->
<plist version="1.0">
<dict>
    <key>A</key>
    <dict>
        <key>V</key>
        <integer>-50</integer>
        <key>W</key>
        <integer>-30</integer>
    </dict>
    <key>T</key>
    <dict>
        <key>o</key>
        <integer>-20</integer>
    </dict>
</dict>
</plist>
这正是 Option 1——嵌套 pair 表。key 是左字形名，value 是一个 dict 映射右字形名 → kerning 值。

类形式（kerning.plist + groups.plist）
UFO 中类通过 groups.plist 定义，类名遵循命名规约 public.kern1.XXX（左类） 和 public.kern2.XXX（右类）：

<!-- groups.plist -->
<dict>
    <key>public.kern1.A_square</key>
    <array>
        <string>A</string>
        <string>Aacute</string>
        <string>Agrave</string>
    </array>
    <key>public.kern2.V_tail</key>
    <array>
        <string>V</string>
        <string>W</string>
        <string>Y</string>
    </array>
</dict>
然后在 kerning.plist 中用类名代替字形名：

<!-- kerning.plist -->
<dict>
    <key>public.kern1.A_square</key>
    <dict>
        <key>public.kern2.V_tail</key>
        <integer>-50</integer>
    </dict>
</dict>
例外
同一对中同时出现类引用和精确字形名引用时，精确字形名优先级高。UFO spec 规定：先处理类对，再覆盖精确对。这天然就是 "类+例外" 模型：

<!-- kerning.plist -->
<dict>
    <!-- 类级：所有 A_square × V_tail 为 -50 -->
    <key>public.kern1.A_square</key>
    <dict>
        <key>public.kern2.V_tail</key>
        <integer>-50</integer>
    </dict>

    <!-- 例外：A × V 单独为 -60（覆盖类级） -->
    <key>A</key>
    <dict>
        <key>V</key>
        <integer>-60</integer>
    </dict>
</dict>
关键点：UFO 中 kerning 完全不依赖 feature file
UFO 的工作方式是分层架构：

kerning.plist + groups.plist    ← kerning 的源数据（声明式，非 GPOS）
         ↓ 编译
features.fea (可选)              ← 可选的 GPOS 输出，由编辑器/编译工具生成
         ↓ 编译
OpenType binary                  ← GPOS table（最终的二进制格式）
features.fea 在 UFO 中是可选的。XeTeX 等渲染引擎可以直接读取 kerning.plist 中的源数据，无需把它编译成 GPOS。fontTools 等库也直接在 kerning.plist 上操作。

所以回到你的问题："只能写成 gpos 规则吗"——不是。UFO 本身就是用纯粹的 pair/class 表表达的，feature file 只是导出时的中间产物。

这对 InkShader 的意义在于：

层	如何表达 kerning
InkShader 内部数据模型	Pair 表（或类+例外）
磁盘保存格式 .json	顶层 kerning 字段，格式同 pair 表或类+例外
导出 UFO	直接写到 kerning.plist + groups.plist，不需要写 features.fea
导出 OpenType	才需要编译 kerning.plist 为 GPOS lookup → features.fea 或直接写 OTF
序列预览	在 calculateSequenceOffsets() 中叠加 kerning 偏移
最终导出到 OpenType 时，kerning.plist 通过 makeotf 或 fonttools 编译为 GPOS PairAdjustment lookup——那一步的 GPOS 格式是编译器的职责，不是编辑器数据模型该关心的。

所以你现在的编辑器内部数据模型选最简单直接的 pair 表就足够了，因为它直接对应 UFO 的 kerning.plist，无需中间转换。

意思是，kerning实际上既可以表示在feature file中，也可以写成kerning.plist，其他的很多feature是不具有这个地位的？
就是这个意思。 这是非常核心的认知。

UFO 设计者的判断是：一个 font 编辑器的数据模型中，应该只有极少数东西可以脱离 feature file 体系直接存为原生数据结构。kerning 是其中之一，因为它的形状足够简单。

哪些 feature 有原生 UFO 地位
有原生表示	存储位置	数据结构
Kerning	kerning.plist	Map<左, Map<右, 数值>>
Mark anchor	glyphs/*.glif 中 <anchor> 元素	每个 glyph 上带 name + x/y 的点
Glyph 组件	glyphs/*.glif 中 <component> 元素	Base + 变换矩阵的引用
Glyph 顺序	metainfo.plist / contents.plist	有序列表
以上这四项，用户可以不写一行 feature file 就表达完整。

其他一切 feature 只能写 feature file
只能写 feature file	OpenType feature 示例
Ligature	sub f i by f_i;
Single substitution	sub A by A.small;
Multiple substitution	sub fi by f i;
Alternate substitution	sub A from [A.1 A.2 A.3];
Contextual substitution	sub A B C' by C.alt;
Cursive attachment	lookup curs { pos cursive A <anchor 500 0> <anchor 0 0>; }
Mark positioning	lookup mkmk { pos mark @top_mark <anchor 0 800>; }
Required ligature / Swash / Fractions / ...	全部
为什么 kerning 是特殊的？
不是特意优待 kerning，而是它的结构恰好适合原生存储，而其他 feature 不适合：

kerning 的本质：    2D lookup table
                   左 glyph  ×  右 glyph  →  一个数值

ligature 的本质：   pattern replacement
                   输入模式  →  替换序列  →  有状态/有优先级

substitution 的本质：context-dependent rewrite
                   什么时候替换、替换成什么、替代规则之间的冲突
2D lookup table 是一个可以用 Map 直接映射的数据结构，不需要 parser，不需要理解规则语法，不需要编译器。用户界面也能直接给出 "左字形选择器 + 右字形选择器 + 数值输入" 的三字段交互，零学习成本。

而 ligature / substitution / contextual positioning 这些，要表达清楚就必须引入规则引擎的概念：条件、模式、优先级、回溯。这就是为什么它们只能存在于 feature file 体系里。

对你（InkShader）的设计启示
当前方案    数据模型形式        是否需要 feature file
──────────────────────────────────────────────────
Kerning     原生 Pair 表         不需要
Anchors     原生 per-glyph        不需要（mark GPOS 导出时自动生成）
Ligature    需要 feature file    需要（无法绕过）
Substitution 需要 feature file   需要（无法绕过）
所以你的直觉完全正确：kerning 可以脱离 feature file 体系独立存在，直接作为编辑器的一等公民。它应该有自己的文件格式字段、自己的 UI 面板、自己的数据管理类——就像 advance width、char_code 一样，是一个 glyph 的固有属性扩展，而不是"先写一段 OpenType 规则然后再把它编译进去"。

将来如果你要加 ligature 支持，那就必须引入 feature file 了——因为 ligature 在 UFO 里也没有原生表示，唯一的途径就是 features.fea。但那是另一回事。当前阶段 kerning 作为一个独立数据模型加入，没有任何架构上的冲突。

我需要修改三个问题，逐次进行修改，修改需要审慎完整：1. 修改目前的glyph互相引用逻辑，使其导出的数据完整兼容opentype的composite，而不是现在这种展平导出；我有一个问题仍然不明白，目前这种旋转/变形/修改节点操作传回原glyph，只有平移额外叠加变换矩阵的逻辑到底是不是符合opentype composite的？如果不是，需要尝试修改成兼容的模式，但是如果需要改用户交互逻辑，需要和我确认修改方案 2. 导出unicode为字符串的glyph时，将其识别为连字，并将这个连字表示为ufo兼容的格式，如果ufo不支持把连字直接写成字符串，需要将其解析为feature file（自定义项目格式和svg不需要改，只需要能够解析）3. 实现kerning功能，这个稍后再做