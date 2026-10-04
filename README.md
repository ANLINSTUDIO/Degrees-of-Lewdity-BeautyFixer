# 美化修正（BeautyFixer）

[English](#english) | 简体中文

一个 Degrees of Lewdity 的 Mod Loader 模组：在游戏内打开图像编辑器，直接修正服装 / 五官 / 头发的图——移动、缩放、画笔、橡皮、分割、镜像、复制与合并图层，保存即生效，重进游戏依然保留，并可导出修正码分享给别人。

<img width="756" height="388" alt="image" src="https://github.com/user-attachments/assets/d1bd11ad-f13c-41da-9574-be06c5a2ab5e" />


> ## ⬇️ 下载与安装
> - 请前往 [**Releases（发行版）**](../../releases) 下载最新的 `BeautyFixer-vX.X.X.zip`。
> - **不要下载仓库源码目录**：源码里的 JS 未经过打包压缩，直接装进 Mod Loader 是可以跑，但发行版才是经过验证的稳定版本。
> - 使用 ModLoader 或者 [ModHub](https://github.com/JohnLiao501/ModHub) 进行安装，确保启用，重启游戏即可。
>
> ## 📖 使用教程
> 完整教程见 **[Wiki/start.md](Wiki/start.md)** ——从打开编辑器到分享修正码，十七个章节，含常见问题。

---

## 特性

- **图层化编辑**：游戏原图层 + 自由笔迹层 + 复制块 + 导入图层，可显示/隐藏、重命名、排序、删除，全程可撤销/重做（20 步）
- **精确对位**：像素网格吸附、X/Y 单像素微调、缩放滑杆 25%~400%、多选图层整组移动/缩放
- **像素压制（Pixel Rebake）**：缩放导致像素摊开后，框选复制成块即可归位到 1 格 = 1 像素，便于精细修图
- **复像（镜像）**：镜像 / 同像两种模式，改好一侧另一侧自动跟上
- **分割图层**：划线切割，按住 Shift 吸附 0°/45°/90° 并落整像素；原图层拆成互补两张、复制块按遮罩分、笔迹层直接分
- **取色涂**：Alt 临时取色或开关模式，从画面最前可见像素取样，盖出可拖动可缩放的色块
- **服装组合**：一套衣服的全部部件一起载入，整组移动/缩放，相对位置不串位
- **保存与分享**：修正数据只存玩家笔迹与位移参数（不存原图像素，永不跨域污染），可导出/导入修正码（文本或 .txt 文件），支持按套导出
- **导出图层 / 人物背景**：图层导出 PNG 文件，人物快照一键存图
- **跨设备**：电脑端用系统另存对话框直接落盘，安卓 APK 走 cordova 原生保存接口

## 安装

1. 到 [Releases](../../releases) 下载最新的 `BeautyFixer-vX.X.X.zip`
2. 放进 Mod Loader 的模组目录（`Mod\`），或用 ModHub 导入
3. 确认模组已启用，重启游戏
4. 游戏侧栏出现「美化修正」按钮即安装成功

## 快速上手

1. 在游戏里穿好想修的服装，点侧栏 **美化修正**
2. 列表里点一张图进入编辑器
3. 用移动 / 缩放工具把部件摆正，用画笔 / 橡皮修饰
4. 点 **保存并生效** ——立刻在游戏里生效，重进也还在

更多进阶操作（多选缩放、像素压制、复像、分割、修正码分享等）见 [Wiki/start.md](Wiki/start.md)。

## 许可

与 Degrees of Lewdity 及其 Mod Loader 生态保持一致，仅限非商业用途。

## 更多模组

请查看 [dol.alseece.top](https://dol.alseece.top/release/)。

- 万能的智能手机：[SmartPhone: 在此模组中，玩家一旦拥有智能手机，便可以设定定时闹钟提醒、拨打部分角色的电话、玩游戏、开通社交账号发布照片、网购、拍摄进攻者的照片进行勒索等以及触发更多有关手机的随机事件。](https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolSmartPhone)

- 极致动态：[Dynamicest: 本模组十分轻量，主要功能有： 1、实时检测属性、社交、特质和金钱动态提醒； 2、给PC的状态条（如疼痛、性奋等）加上动画； 3、将原版移动端折叠后状态下方用于装饰的点线条，修改为真正的状态条； 本模组的目的是让玩家能够更加直观地看到数值的变化。](https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolDynamicest)

- 小小PC：[LitterPC: 此模组的功能是在屏幕上创建一个可拖动的额外的PC头像。](https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolLitterPC)

- 原版优化：[Optimization: 本模组将某些原版的可能不合理的地方进行优化，大部分优化是可选的，你可以在设置里对其进行开关。 目前包含的重大功能： 自定义游戏字体（使用.ttf文件，可以从各种字体网站如「字体天下」下载） 通过花费或作弊扩建衣柜容量 可以在医院实施处女膜修复手术，恢复童贞 自由叠加服装部件 将页面左上角的侧边栏按钮隐藏或改为回溯按钮 存档显示游戏内时间 和 自定义存档描述 其它部分功能性剧情和文段](https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-DolOptimization)

- 露出拓展：[MyExhibitionismExpansion: 【请别露出惊讶的表情好吗-露出拓展】本模组功能为拓展DoL中的【露出】剧情，原版关于露出的剧情较为稀少，只有部分露出时的描述；并且加入了【随处脱衣】、【勇气系统】、【任务系统】、【服装道具拓展】等其他玩法。](https://github.com/ANLINSTUDIO/Degrees-of-Lewdity-MyExhibitionismExpansion)

---

<a name="english"></a>

## English

A Mod Loader mod for [Degrees of Lewdity](https://github.com/Vrelnap/DoL-ModLoader): an in-game image editor for fixing clothes / face / hair sprites — move, scale, draw, erase, split, mirror, copy and merge layers. Changes apply instantly, persist across sessions, and can be shared as fix codes.

> ### Download
> Grab the latest `BeautyFixer-vX.X.X.zip` from [**Releases**](../../releases). Install it into the Mod Loader's `Mod\` directory and enable it.
>
> ### Documentation
> The full tutorial lives at **[Wiki/start.md](Wiki/start.md)** (Chinese).

### Features

- Layer-based editing (base image, stroke layers, copy blocks, imported images) with undo/redo
- Pixel-precise alignment: grid snapping, 1-px nudging, 25%–400% scaling, multi-select group transforms
- **Pixel Rebake**: re-bake zoomed layers into a copy block to restore 1 texel = 1 pixel for fine retouching
- Mirror/sync drawing, line-split with Shift snapping, color-picker stamping, outfit-group editing
- Saves only user strokes + transforms (never original pixels — no canvas tainting issues), shareable as fix codes
- Native save dialogs on desktop (File System Access) and Android APK (cordova saveDialog)
