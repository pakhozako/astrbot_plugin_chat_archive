#!/usr/bin/env python3
"""
前端媒体渲染逻辑测试 - 直接解析和验证关键函数
不依赖 Node.js，直接解析 app.js 验证逻辑
"""

import re
import sys
from pathlib import Path


def test_skip_inline_media_logic():
    """测试 1: skipInlineMedia 逻辑存在"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    # 检查 skipInlineMedia 变量
    if "skipInlineMedia" not in app_js:
        return False, "未找到 skipInlineMedia 变量"

    # 检查条件判断
    if "item?.media" not in app_js and "item.media" not in app_js:
        return False, "未找到 item.media 检查"

    # 检查 skipMedia 选项传递
    if "skipMedia:" not in app_js and "skipMedia :" not in app_js:
        return False, "未找到 skipMedia 选项传递"

    return True, "skipInlineMedia 逻辑正确实现"


def test_is_media_element_function():
    """测试 2: isMediaElement 函数存在且覆盖所有媒体类型"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    if "function isMediaElement" not in app_js:
        return False, "未找到 isMediaElement 函数"

    # 检查是否检测各种媒体元素
    required_checks = [
        "picElement",
        "imageElement",
        "mfaceElement",
        "marketFaceElement",
        "fileElement",
        "pttElement",
        "voiceElement",
        "videoElement",
    ]

    missing = [check for check in required_checks if check not in app_js]
    if missing:
        return False, f"isMediaElement 未检测: {', '.join(missing)}"

    return True, "isMediaElement 函数正确实现"


def test_is_media_placeholder_text_function():
    """测试 3: isMediaPlaceholderText 函数存在"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    if "function isMediaPlaceholderText" not in app_js:
        return False, "未找到 isMediaPlaceholderText 函数"

    # 检查是否过滤常见占位符
    if "图片" not in app_js or "表情" not in app_js:
        return False, "isMediaPlaceholderText 未过滤常见占位符"

    return True, "isMediaPlaceholderText 函数正确实现"


def test_media_for_grid_prioritizes_db():
    """测试 4: mediaForGrid 优先返回 DB media"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    start = app_js.find("function mediaForGrid(item)")
    if start < 0:
        return False, "未找到 mediaForGrid 函数"
    end = app_js.find("function dedupeMediaItems", start)
    if end < 0:
        return False, "mediaForGrid 函数边界解析失败"
    func_body = app_js[start:end]

    # 检查是否有 dbMedia
    if "dbMedia" not in func_body:
        return False, "mediaForGrid 未定义 dbMedia"

    # 有 DB 媒体时必须走 DB 分支；inlineMedia 只能在无 DB 时兜底。
    if "if (!dbMedia.length)" not in func_body:
        return False, "mediaForGrid 未显式区分无 DB media 的兜底分支"
    if "preferStableMediaItems(normalized)" not in func_body:
        return False, "mediaForGrid 未优先返回 dbMedia"
    if func_body.find("inlineMedia") > func_body.find("if (!dbMedia.length)"):
        return False, "mediaForGrid 在 DB media 分支之后仍继续混入 inline media"

    # 检查是否移除了混入逻辑
    if "dbSources.has(" in func_body:
        return False, "mediaForGrid 仍然包含去重混入逻辑（应该已移除）"

    return True, "mediaForGrid 正确优先返回 DB media"


def test_render_component_accepts_options():
    """测试 5: renderComponentInlineHtml 接受 options 参数"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    # 检查函数签名
    if "function renderComponentInlineHtml(component, options" not in app_js:
        return False, "renderComponentInlineHtml 未接受 options 参数"

    # 检查是否使用 options.skipMedia
    if "options.skipMedia" not in app_js:
        return False, "renderComponentInlineHtml 未使用 options.skipMedia"

    return True, "renderComponentInlineHtml 正确接受 options 参数"


def test_all_displayable_media_uses_grid():
    """测试 6: allDisplayableMediaItems 使用 mediaForGrid"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    # 找到函数
    match = re.search(
        r"function allDisplayableMediaItems\(\)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}",
        app_js,
        re.DOTALL,
    )
    if not match:
        return False, "未找到 allDisplayableMediaItems 函数"

    func_body = match.group(1)

    # 检查是否使用 mediaForGrid
    if "mediaForGrid(msg)" not in func_body and "mediaForGrid( msg )" not in func_body:
        return False, "allDisplayableMediaItems 未使用 mediaForGrid"

    # 检查是否移除了直接访问 msg.media 和 inlineMediaItemsFromMessage
    if "inlineMediaItemsFromMessage(msg)" in func_body:
        return (
            False,
            "allDisplayableMediaItems 仍然直接调用 inlineMediaItemsFromMessage",
        )

    return True, "allDisplayableMediaItems 正确使用 mediaForGrid"


def test_loading_text_simplified():
    """测试 7: 加载文案简化"""
    app_js = Path("pages/timeline/app.js").read_text(encoding="utf-8")

    if "图片加载中" in app_js:
        return False, "仍然使用旧的'图片加载中'文案"

    if "加载中" not in app_js:
        return False, "未找到新的'加载中'文案"

    return True, "加载文案已简化为'加载中'"


def test_css_compact_mode():
    """测试 8: CSS compact 模式"""
    style_css = Path("pages/timeline/style.css").read_text(encoding="utf-8")

    if ".media-file.compact" not in style_css:
        return False, "未找到 .media-file.compact 样式"

    if ".media-card.image" not in style_css:
        return False, "未找到 .media-card.image 样式"

    return True, "CSS compact 模式正确添加"


def main():
    print("=" * 60)
    print("Chat Archive - 前端修复逻辑验证")
    print("=" * 60)

    tests = [
        ("skipInlineMedia 逻辑", test_skip_inline_media_logic),
        ("isMediaElement 函数", test_is_media_element_function),
        ("isMediaPlaceholderText 函数", test_is_media_placeholder_text_function),
        ("mediaForGrid 优先 DB", test_media_for_grid_prioritizes_db),
        ("renderComponentInlineHtml options", test_render_component_accepts_options),
        ("allDisplayableMediaItems 使用 grid", test_all_displayable_media_uses_grid),
        ("加载文案简化", test_loading_text_simplified),
        ("CSS compact 模式", test_css_compact_mode),
    ]

    results = []
    for name, test_func in tests:
        print(f"\n>> 测试: {name}")
        try:
            passed, message = test_func()
            if passed:
                print(f"  [PASS] {message}")
                results.append(True)
            else:
                print(f"  [FAIL] {message}")
                results.append(False)
        except Exception as e:
            print(f"  [ERROR] {e}")
            results.append(False)

    print(f"\n{'=' * 60}")
    print("[测试总结]")
    print(f"{'=' * 60}")
    passed = sum(results)
    total = len(results)
    print(f"通过: {passed}/{total}")
    print(f"失败: {total - passed}/{total}")

    if passed == total:
        print("\n[SUCCESS] 所有逻辑验证通过！")
        print("前端修复已正确实现。")
        return 0
    else:
        print(f"\n[WARNING] {total - passed} 个测试失败")
        return 1


if __name__ == "__main__":
    sys.exit(main())
