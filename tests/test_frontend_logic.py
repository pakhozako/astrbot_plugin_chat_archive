#!/usr/bin/env python3
"""
前端媒体渲染逻辑自动化测试
通过 Node.js 执行 JavaScript 函数并验证结果
"""

import json
import subprocess
import sys
from pathlib import Path

# 测试用例
TEST_CASES = [
    {
        "name": "测试1: 单个表情包（核心问题）",
        "message": {
            "message_id": "test-sticker-1",
            "text": "[图片]",
            "raw": {
                "elements": [
                    {
                        "picElement": {
                            "originImageUrl": "C:\\Users\\Claude\\.astrbot\\data\\temp\\media_image_1f9fda9642b9476fbf2a9f38428c1c4b.gif",
                            "summary": "图片不可用",
                        }
                    },
                    {
                        "picElement": {
                            "originImageUrl": "C:\\temp\\another_path.gif",
                            "summary": "图片",
                        }
                    },
                ]
            },
            "media": [
                {
                    "id": 1,
                    "kind": "image",
                    "name": "C7A8EB15DB806AB1AED0BCCB15A0E4B6.gif",
                    "source": "https://gchat.qpic.cn/gchatpic_new/test/sticker.gif",
                    "mime": "image/gif",
                }
            ],
        },
        "assertions": [
            ("media_count", 1, "应该只有1个媒体"),
            ("no_temp_path", True, "不应显示临时路径"),
            ("no_placeholder", True, "不应显示占位文本"),
        ],
    },
    {
        "name": "测试2: DB media 存在的图片",
        "message": {
            "message_id": "test-image-1",
            "text": "看看这张图",
            "media": [
                {
                    "id": 2,
                    "kind": "image",
                    "name": "photo.jpg",
                    "source": "https://example.com/photo.jpg",
                    "mime": "image/jpeg",
                }
            ],
        },
        "assertions": [
            ("media_count", 1, "应该只有1个媒体"),
            ("has_text", True, "应该显示消息文本"),
        ],
    },
    {
        "name": "测试3: 占位文本过滤",
        "message": {
            "message_id": "test-placeholder-1",
            "text": "[图片]",
            "media": [
                {
                    "id": 4,
                    "kind": "image",
                    "name": "filtered.jpg",
                    "source": "https://example.com/filtered.jpg",
                    "mime": "image/jpeg",
                }
            ],
        },
        "assertions": [
            ("media_count", 1, "应该只有1个媒体"),
            ("placeholder_filtered", True, "占位文本应被过滤"),
        ],
    },
    {
        "name": "测试4: 多个 raw 候选源",
        "message": {
            "message_id": "test-multi-raw-1",
            "raw": {
                "elements": [
                    {"picElement": {"originImageUrl": "temp1.jpg"}},
                    {"picElement": {"originImageUrl": "temp2.jpg"}},
                    {"picElement": {"originImageUrl": "temp3.jpg"}},
                ]
            },
            "media": [
                {
                    "id": 5,
                    "kind": "image",
                    "name": "archived.jpg",
                    "source": "https://example.com/archived.jpg",
                    "mime": "image/jpeg",
                }
            ],
        },
        "assertions": [
            ("media_count", 1, "应该只有1个媒体（DB）"),
            ("is_db_media", True, "应该是 DB 归档的媒体"),
        ],
    },
]

# Node.js 测试运行器脚本
NODE_TEST_SCRIPT = """
const fs = require('fs');
const vm = require('vm');

// 加载 app.js
const appJs = fs.readFileSync('pages/timeline/app.js', 'utf8');

function makeStubElement() {
    return {
        hidden: false,
        value: '',
        textContent: '',
        innerHTML: '',
        className: '',
        dataset: {},
        style: {},
        classList: {
            add() {},
            remove() {},
            toggle() {},
            contains() { return false; },
        },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        append() {},
        replaceChildren() {},
        remove() {},
        querySelector() { return makeStubElement(); },
        querySelectorAll() { return []; },
        setAttribute() {},
        closest() { return null; },
        scrollIntoView() {},
        getBoundingClientRect() { return { width: 0, height: 0 }; },
    };
}

// 创建沙箱环境
const sandbox = {
    console: console,
    Map: Map,
    Set: Set,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Number: Number,
    String: String,
    Boolean: Boolean,
    Array: Array,
    URL: URL,
    URLSearchParams: URLSearchParams,
    RegExp: RegExp,
    navigator: { clipboard: null },
    parent: {},
    document: {
        body: makeStubElement(),
        documentElement: { dataset: {} },
        getElementById() { return makeStubElement(); },
        createElement() { return makeStubElement(); },
        createTextNode() { return makeStubElement(); },
        createDocumentFragment() { return makeStubElement(); },
        execCommand() { return true; },
        addEventListener() {},
        removeEventListener() {},
        activeElement: null,
    },
    CSS: {
        escape(value) {
            return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
        },
    },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(callback) {
        if (typeof callback === 'function') callback();
    },
};
sandbox.window = {
    AstrBotPluginPage: null,
    parent: sandbox.parent,
    location: { href: 'http://localhost/' },
    document: sandbox.document,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
};
sandbox.globalThis = sandbox;

// 执行 app.js
vm.createContext(sandbox);
vm.runInContext(appJs, sandbox);

// 从 stdin 读取测试消息
const input = fs.readFileSync(0, 'utf-8');
const message = JSON.parse(input);

// 执行测试
const result = {
    mediaForGrid: sandbox.mediaForGrid ? sandbox.mediaForGrid(message) : null,
    messageBodyHtml: sandbox.messageBodyHtml ? sandbox.messageBodyHtml(message) : null,
};

console.log(JSON.stringify(result, null, 2));
"""


def run_test(test_case):
    """运行单个测试用例"""
    print(f"\n{'=' * 60}")
    print(f">> {test_case['name']}")
    print(f"{'=' * 60}")

    # 保存 Node 脚本
    script_path = Path(__file__).parent / "node_test_runner.js"
    script_path.write_text(NODE_TEST_SCRIPT)

    # 准备输入
    message_json = json.dumps(test_case["message"])

    try:
        # 执行 Node.js
        result = subprocess.run(
            ["node", str(script_path)],
            input=message_json,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=Path(__file__).parent.parent,
            timeout=5,
        )

        if result.returncode != 0:
            print("[FAIL] Node.js 执行失败:")
            print(result.stderr)
            return False

        # 解析结果
        output = json.loads(result.stdout)
        media_items = output.get("mediaForGrid", [])
        body_html = output.get("messageBodyHtml", "")

        print("[结果]")
        print(f"  - mediaForGrid 返回: {len(media_items)} 个媒体")
        print(
            f'  - messageBodyHtml: "{body_html[:100]}..."'
            if len(body_html) > 100
            else f'  - messageBodyHtml: "{body_html}"'
        )

        # 验证断言
        passed = True
        for assertion_type, expected, description in test_case["assertions"]:
            if assertion_type == "media_count":
                actual = len(media_items)
                if actual == expected:
                    print(f"  [PASS] {description}: {actual}")
                else:
                    print(f"  [FAIL] {description}: 预期 {expected}, 实际 {actual}")
                    passed = False

            elif assertion_type == "no_temp_path":
                has_temp = "C:\\" in body_html or "temp\\" in body_html.lower()
                if not has_temp:
                    print(f"  [PASS] {description}")
                else:
                    print(f"  [FAIL] {description}: 发现临时路径")
                    passed = False

            elif assertion_type == "no_placeholder":
                has_placeholder = "[图片]" in body_html or "图片不可用" in body_html
                if not has_placeholder:
                    print(f"  [PASS] {description}")
                else:
                    print(f"  [FAIL] {description}: 发现占位文本")
                    passed = False

            elif assertion_type == "has_text":
                has_text = "看看这张图" in body_html
                if has_text:
                    print(f"  [PASS] {description}")
                else:
                    print(f"  [FAIL] {description}: 未找到消息文本")
                    passed = False

            elif assertion_type == "placeholder_filtered":
                filtered = "[图片]" not in body_html or body_html.strip() == ""
                if filtered:
                    print(f"  [PASS] {description}")
                else:
                    print(f"  [FAIL] {description}")
                    passed = False

            elif assertion_type == "is_db_media":
                is_db = (
                    len(media_items) > 0
                    and media_items[0].get("name") == "archived.jpg"
                )
                if is_db:
                    print(f"  [PASS] {description}")
                else:
                    print(f"  [FAIL] {description}: 媒体不是 DB 归档的")
                    passed = False

        return passed

    except subprocess.TimeoutExpired:
        print("[FAIL] 测试超时")
        return False
    except json.JSONDecodeError as e:
        print(f"[FAIL] 解析 Node.js 输出失败: {e}")
        print(f"stdout: {result.stdout}")
        return False
    except Exception as e:
        print(f"[FAIL] 测试异常: {e}")
        import traceback

        traceback.print_exc()
        return False


def main():
    print("=" * 60)
    print("Chat Archive - 前端媒体渲染自动化测试")
    print("=" * 60)

    # 检查 node 是否可用
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("[ERROR] 未找到 Node.js，请先安装")
        return 1

    # 检查 app.js 是否存在
    app_js_path = Path(__file__).parent.parent / "pages" / "timeline" / "app.js"
    if not app_js_path.exists():
        print(f"[ERROR] 未找到 {app_js_path}")
        return 1

    # 运行所有测试
    results = []
    for test_case in TEST_CASES:
        results.append(run_test(test_case))

    # 总结
    print(f"\n{'=' * 60}")
    print("[测试总结]")
    print(f"{'=' * 60}")
    passed = sum(results)
    total = len(results)
    print(f"通过: {passed}/{total}")
    print(f"失败: {total - passed}/{total}")

    if passed == total:
        print("\n[SUCCESS] 所有测试通过！前端修复正确。")
        return 0
    else:
        print(f"\n[WARNING] {total - passed} 个测试失败，请检查上方详情。")
        return 1


if __name__ == "__main__":
    sys.exit(main())
